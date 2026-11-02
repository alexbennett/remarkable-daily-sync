import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { LocalStore, hash } from '../src/storage';
import { NotebookSync } from '../src/notebook-sync';
import { NoteRenderer } from '../src/renderer';
import { mergeThreeWay } from '../src/merge';
import type { CloudDocument, NoteState, Revision, Settings, Transport } from '../src/contracts';

async function setup(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-notebook-sync-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('remarkable-notebook-sync-')); await fs.rm(directory, { recursive: true, force: true }); });
  const store = new LocalStore(directory), state = await store.load();
  const settings: Settings = { dailyRoot: 'Daily', startDate: '2026-11-01', cloudFolder: 'Notes', rmapiPath: '', ollamaUrl: 'http://localhost:11434', model: 'gemma4:26b', paused: false, automatic: true, validatedKinds: [], pollSeconds: 60,
    notebookMappings: [{ id: 'mapping', folder: 'Notes', title: 'Project Notes', enabled: true }] };
  const files = new Map([['Notes/A.md', 'alpha\n\noriginal'], ['Notes/B.md', 'beta']]);
  state.notes.a = { id: 'a', path: 'Notes/A.md', date: 'notebook', revisions: [] };
  state.notes.b = { id: 'b', path: 'Notes/B.md', date: 'notebook', revisions: [] };
  state.notebooks.book = { id: 'book', mappingId: 'mapping', entryIds: ['a', 'b'], generation: 0, pages: [], validation: 'pending' };
  await store.save(state);
  const remoteId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', pdfKey = `${remoteId}.pdf`, contentKey = `${remoteId}.content`;
  const archived: string[] = [], events: string[] = [], statuses: string[] = [];
  let archive: Uint8Array | undefined, doc: CloudDocument | undefined, uploads = 0, writes = 0, writeCalls = 0;
  let authorized = true, initialized = true, failUnknown = false, conflict = false;
  const transport: Transport = {
    check: async () => 'ok', list: async () => doc ? [doc] : [],
    upload: async (name, pdf) => {
      if (doc) { assert.equal(doc.name, name); return doc; }
      uploads++; events.push('upload');
      const count = (await PDFDocument.load(pdf)).getPageCount();
      const content = initialized ? { fileType: 'pdf', formatVersion: 2, pageCount: count, cPages: {
        original: { timestamp: '1:1', value: count }, uuids: [{ first: randomUUID(), second: 1 }],
        pages: Array.from({ length: count }, (_, i) => ({ id: randomUUID(), idx: { timestamp: '1:2', value: `b${String.fromCharCode(97 + i)}` }, redir: { timestamp: '1:2', value: i }, template: { timestamp: '1:2', value: 'Blank' } }))
      } } : { fileType: 'pdf', pages: null, redirectionPageMap: null, pageCount: 0 };
      archive = zipSync({ [pdfKey]: pdf, [contentKey]: strToU8(JSON.stringify(content)), [`${remoteId}.metadata`]: strToU8('preserved metadata') });
      doc = { id: remoteId, name, parent: 'Notes', version: 1, modifiedClient: '' }; return doc;
    },
    download: async id => { assert.equal(id, remoteId); assert.ok(archive); events.push('download'); return { bytes: archive.slice(), fingerprint: hash(archive) }; },
    archive: async id => { events.push(`archive:${id}`); archived.push(id); },
    replaceNotebook: async (id, expected, pdf, content, removed, gate) => {
      assert.equal(id, remoteId); assert.equal(gate.authorizedDocumentId, remoteId); assert.ok(archive); writeCalls++;
      const entries = unzipSync(archive);
      if (hash(entries[pdfKey]) === hash(pdf) && hash(entries[contentKey]) === hash(content)) return;
      if (conflict || hash(archive) !== hash(expected)) { const error = new Error('remote changed'); error.name = 'NotebookUpdateConflictError'; throw error; }
      assert.ok(events.includes('pull:a') && events.includes('pull:b'), 'all active entries must import first');
      entries[pdfKey] = new Uint8Array(pdf); entries[contentKey] = new Uint8Array(content);
      for (const file of removed) delete entries[file];
      archive = zipSync(entries); writes++; events.push('replace');
      if (failUnknown) { failUnknown = false; throw new Error('unknown response after success'); }
    }
  };
  const pull = async (note: NoteState, revision: Revision) => {
    assert.ok(archive); events.push(`pull:${note.id}`);
    const entries = unzipSync(archive); let interpreted = revision.baseline;
    for (const id of revision.pageIds ?? []) {
      const data = entries[`${remoteId}/${id}.rm`];
      if (data) { const change = JSON.parse(strFromU8(data)); interpreted = interpreted.replace(change.before, change.after); }
    }
    const merged = mergeThreeWay(revision.tabletText, files.get(note.path)!, interpreted);
    assert.deepEqual(merged.conflicts, []); files.set(note.path, merged.text);
    revision.tabletText = interpreted; revision.fingerprint = hash(archive); await store.save(state);
  };
  const callbacks = { pull, authorize: (_id: string | undefined, _format: string) => authorized };
  const host = { read: async (p: string) => files.get(p) ?? null, status: (message: string) => { statuses.push(message); } };
  const controller = new NotebookSync(state, () => settings, host, store, transport, new NoteRenderer(), callbacks);
  const ink = (noteId: string, before: string, after: string) => {
    assert.ok(archive); const entry = state.notes[noteId].revisions.find(r => r.notebookId === 'book' && !r.superseded)!;
    const key = `${remoteId}/${entry.pageIds![0]}.rm`, entries = unzipSync(archive); entries[key] = strToU8(JSON.stringify({ before, after })); archive = zipSync(entries); return key;
  };
  const editContent = (edit: (content: any) => void) => {
    assert.ok(archive); const entries = unzipSync(archive), content = JSON.parse(strFromU8(entries[contentKey])); edit(content);
    entries[contentKey] = strToU8(JSON.stringify(content)); archive = zipSync(entries);
  };
  const addBlank = (redir?: number) => {
    const id = randomUUID(), record = { id, idx: { timestamp: '1:3', value: 'bab' }, modifed: '1793579781960', ...(redir === undefined ? {} : { redir: { timestamp: '1:3', value: redir } }) };
    editContent(content => { content.cPages.pages.push(record); content.pageCount++; });
    const entries = unzipSync(archive!), key = `${remoteId}/${id}.rm`, bytes = strToU8('unassigned handwritten blank'); entries[key] = bytes; archive = zipSync(entries);
    return { record, key, bytes };
  };
  return { controller, state, store, files, settings, callbacks, transport, host, archived, events, statuses, ink, remoteId, pdfKey, contentKey, addBlank, editContent,
    entries: () => { assert.ok(archive); return unzipSync(archive); }, stats: () => ({ uploads, writes, writeCalls }),
    authorize: (value: boolean) => { authorized = value; }, uninitialized: () => { initialized = false; }, unknown: () => { failUnknown = true; }, conflict: () => { conflict = true; } };
}

test('initial combined notebook publishes once, captures tablet IDs, and archives old documents only after verification', async t => {
  const s = await setup(t);
  s.state.notes.a.revisions.push({ id: 'legacy', baseline: 'older', tabletText: 'older', name: 'legacy', blocks: [], pdfFile: 'old.pdf', archived: false, createdAt: '' });
  await s.controller.sync();
  const book = s.state.notebooks.book;
  assert.equal(book.documentId, s.remoteId); assert.equal(book.generation, 1); assert.equal(book.pages.length, 2);
  assert.equal(s.state.notes.a.lastPublishedHash, undefined);
  assert.equal(s.state.notes.a.revisions[0].archived, true);
  assert.deepEqual(s.archived, ['legacy']); assert.ok(s.events.indexOf('archive:legacy') > s.events.indexOf('download'));
  assert.ok(book.pages.every(page => s.state.notes[page.noteId].revisions.some(r => r.id === page.revisionId && r.pageIds?.includes(page.pageId))));
  await s.controller.sync(); assert.deepEqual(s.stats(), { uploads: 1, writes: 0, writeCalls: 0 });
  assert.equal(await s.store.readText('pending-notebook.json'), null);
});

test('inserted native blank and its handwriting survive an existing entry refresh with a warning', async t => {
  const s = await setup(t); await s.controller.sync(); const blank = s.addBlank();
  s.files.set('Notes/A.md', 'updated alpha'); await s.controller.sync();
  assert.equal(s.stats().writes, 1); assert.equal(s.state.notebooks.book.generation, 2);
  const entries = s.entries(), content = JSON.parse(strFromU8(entries[s.contentKey]));
  assert.deepEqual(content.cPages.pages.find((page: any) => page.id === blank.record.id), blank.record);
  assert.deepEqual(entries[blank.key], blank.bytes);
  assert.equal(s.state.notebooks.book.pages.some(p => p.pageId === blank.record.id), false);
  assert.match(s.state.notebooks.book.pendingReason!, /tablet-added page.*preserved/);
  await s.controller.sync(); assert.equal(s.stats().writes, 1);
  assert.match(s.state.notebooks.book.pendingReason!, /existing note synchronization continues/);
});

test('initial routing skips tablet-inserted blank without assigning it to a source note', async t => {
  const s = await setup(t); const download = s.transport.download; let inserted = false;
  s.transport.download = async id => { if (!inserted) { inserted = true; s.addBlank(); } return download(id); };
  await s.controller.sync();
  assert.equal(s.state.notebooks.book.generation, 1);
  assert.equal(s.state.notebooks.book.pages.length, 2);
  assert.deepEqual(s.state.notebooks.book.pages.map(p => p.pdfPage), [1, 2]);
  assert.match(s.state.notebooks.book.pendingReason!, /tablet-added page/);
});

test('unknown PDF-backed pages never gain an inferred source-note assignment', async t => {
  const s = await setup(t); await s.controller.sync(); const unknown = s.addBlank(0);
  s.files.set('Notes/A.md', 'updated alpha'); await s.controller.sync();
  assert.equal(s.stats().writes, 0); assert.equal(s.state.notebooks.book.generation, 1);
  assert.ok(s.entries()[unknown.key]);
  assert.match(s.state.notebooks.book.pendingReason!, /mapping.*review/);
});

test('legacy initialization defers changes until the tablet supplies cPages identities', async t => {
  const s = await setup(t); await s.controller.sync();
  const prior = JSON.parse(strFromU8(s.entries()[s.contentKey]));
  s.editContent(content => { content.formatVersion = 1; content.pages = content.cPages.pages.map((p: any) => p.id); content.redirectionPageMap = content.cPages.pages.map((p: any) => p.redir.value); delete content.cPages; });
  s.files.set('Notes/A.md', 'updated alpha'); await s.controller.sync();
  assert.equal(s.stats().writes, 0); assert.match(s.state.notebooks.book.pendingReason!, /Open.*cPages/);
  s.editContent(content => { content.formatVersion = 2; content.cPages = prior.cPages; delete content.pages; delete content.redirectionPageMap; });
  await s.controller.sync(); assert.equal(s.stats().writes, 1); assert.equal(s.state.notebooks.book.generation, 2);
});

test('entry refresh preserves stable document and other entry ink after all handwriting is imported', async t => {
  const s = await setup(t); await s.controller.sync();
  const original = s.entries(), oldA = s.state.notes.a.revisions[0], oldB = s.state.notes.b.revisions[0];
  s.files.set('Notes/A.md', 'alpha\n\nLOCAL');
  const aInk = s.ink('a', 'alpha', 'handwritten'), bInk = s.ink('b', 'beta', 'handwritten beta');
  await s.controller.sync();
  assert.equal(s.files.get('Notes/A.md'), 'handwritten\n\nLOCAL'); assert.equal(s.files.get('Notes/B.md'), 'handwritten beta');
  const entries = s.entries(); assert.equal(entries[aInk], undefined); assert.ok(entries[bInk]);
  assert.deepEqual(entries[`${s.remoteId}.metadata`], original[`${s.remoteId}.metadata`]);
  assert.equal(oldA.superseded, true); assert.equal(oldB.superseded, undefined);
  const newA = s.state.notes.a.revisions.at(-1)!;
  assert.deepEqual(newA.pageIds, oldA.pageIds); assert.equal(newA.documentId, s.remoteId);
  assert.equal(oldB.pdfFile, newA.pdfFile); assert.equal(s.state.notebooks.book.generation, 2);
  assert.ok(newA.firstPage! > oldA.lastPage!);
});

test('unknown write outcome retains journal and recovery never duplicates pages or deletes reappeared ink', async t => {
  const s = await setup(t); await s.controller.sync(); s.files.set('Notes/A.md', 'changed'); s.unknown();
  await assert.rejects(s.controller.sync(), /unknown response/); assert.ok(await s.store.readText('pending-notebook.json'));
  const reappeared = s.ink('a', 'changed', 'more handwriting');
  const after = s.entries(); await s.controller.recover();
  assert.equal(hash(s.entries()[s.pdfKey]), hash(after[s.pdfKey]));
  assert.deepEqual(s.entries()[reappeared], after[reappeared]);
  assert.deepEqual(s.stats(), { uploads: 1, writes: 1, writeCalls: 2 });
  assert.equal(s.state.notes.a.revisions.filter(r => !r.superseded).length, 1);
  assert.equal(await s.store.readText('pending-notebook.json'), null);
});

test('new entries append after existing identities without reuploading or disturbing original routes', async t => {
  const s = await setup(t); await s.controller.sync();
  const existing = s.state.notebooks.book.pages.map(p => ({ ...p }));
  s.files.set('Notes/C.md', 'new entry');
  s.state.notes.c = { id: 'c', path: 'Notes/C.md', date: 'notebook', revisions: [] };
  s.state.notebooks.book.entryIds.push('c');
  await s.controller.sync();
  assert.equal(s.stats().uploads, 1); assert.equal(s.stats().writes, 1);
  for (const prior of existing) assert.ok(s.state.notebooks.book.pages.some(p => JSON.stringify(p) === JSON.stringify(prior)));
  const revision = s.state.notes.c.revisions[0];
  assert.equal(revision.documentId, s.remoteId); assert.equal(revision.firstPage, 3);
  assert.equal(s.state.notebooks.book.pages.length, 3);
});

test('state-save failure after verified remote update is replayed without duplicate acknowledgement', async t => {
  const s = await setup(t); await s.controller.sync(); s.files.set('Notes/A.md', 'changed');
  const save = s.store.save.bind(s.store); let fail = true;
  s.store.save = async state => { if (fail && state.notebooks.book.generation === 2) { fail = false; throw new Error('state disk error'); } await save(state); };
  await assert.rejects(s.controller.sync(), /state disk error/); s.store.save = save;
  const persisted = await s.store.load();
  const recovered = new NotebookSync(persisted, () => s.settings, s.host, s.store, s.transport, new NoteRenderer(), s.callbacks);
  await recovered.recover();
  assert.equal(persisted.notebooks.book.generation, 2); assert.equal(persisted.notes.a.revisions.length, 2);
  assert.deepEqual(s.stats(), { uploads: 1, writes: 1, writeCalls: 2 });
});

test('scoped validation blocks creation and update without relying on persisted validation flag', async t => {
  const s = await setup(t); s.authorize(false); s.state.notebooks.book.validation = 'validated';
  await s.controller.sync(); assert.equal(s.stats().uploads, 0); assert.equal(await s.store.readText('pending-notebook.json'), null);
  s.authorize(true); await s.controller.sync(); s.authorize(false); s.files.set('Notes/A.md', 'changed');
  await s.controller.sync(); assert.equal(s.stats().writes, 0); assert.equal(s.state.notebooks.book.generation, 1);
});

test('uninitialized upload preserves creation journal without duplicate upload or premature archival', async t => {
  const s = await setup(t); s.uninitialized();
  s.state.notes.a.revisions.push({ id: 'legacy', baseline: 'older', tabletText: 'older', name: 'legacy', blocks: [], pdfFile: 'old.pdf', archived: false, createdAt: '' });
  await s.controller.sync(); await s.controller.sync();
  assert.equal(s.stats().uploads, 1); assert.ok(await s.store.readText('pending-notebook.json'));
  assert.equal(s.state.notebooks.book.generation, 0); assert.deepEqual(s.archived, []);
  assert.match(s.state.notebooks.book.pendingReason!, /Open.*tablet/);
});

test('review or CAS conflict prevents publication without acknowledging source text', async t => {
  const s = await setup(t); await s.controller.sync(); s.files.set('Notes/A.md', 'changed');
  s.state.reviews.push({ id: 'review', noteId: 'a', revisionId: s.state.notes.a.revisions[0].id, fingerprint: '', createdAt: '', base: '', current: '', proposed: '', tabletText: '', reasons: ['uncertain'], kinds: [], images: [] });
  await s.controller.sync(); assert.equal(s.stats().writes, 0);
  s.state.reviews = []; s.conflict(); await s.controller.sync();
  assert.equal(s.state.notebooks.book.generation, 1); assert.equal(s.state.notes.a.revisions.length, 1);
  assert.equal(await s.store.readText('pending-notebook.json'), null);
  assert.match(s.state.notebooks.book.pendingReason!, /Tablet changed/);
});
