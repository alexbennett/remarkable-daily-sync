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
import { SyncEngine, type VaultHost } from '../src/engine';
import type { CloudDocument, NoteState, Revision, Settings, Transport, Renderer, Recognizer, PageImage } from '../src/contracts';

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
  let authorized = true, initialized = true, initialLegacy = false, failUnknown = false, conflict = false;
  let requireCallbackEvents = true;
  const authorizedFormats: string[] = [];
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
      if (initialLegacy && initialized) {
        const legacy = content as any; legacy.formatVersion = 1; legacy.originalPageCount = count;
        legacy.pages = legacy.cPages.pages.map((page: any) => page.id);
        legacy.redirectionPageMap = legacy.cPages.pages.map((page: any) => page.redir.value); delete legacy.cPages;
      }
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
      if (requireCallbackEvents) assert.ok(events.includes('pull:a') && events.includes('pull:b'), 'all active entries must import first');
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
  const callbacks = { pull, authorize: (_id: string | undefined, format: string) => { authorizedFormats.push(format); return authorized; } };
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
  return { controller, state, store, files, settings, callbacks, transport, host, archived, events, statuses, ink, remoteId, pdfKey, contentKey, addBlank, editContent, authorizedFormats,
    entries: () => { assert.ok(archive); return unzipSync(archive); }, stats: () => ({ uploads, writes, writeCalls }),
    restoreEntries: (entries: Record<string, Uint8Array>) => { archive = zipSync(entries); },
    authorize: (value: boolean) => { authorized = value; }, fullEngine: () => { requireCallbackEvents = false; }, uninitialized: () => { initialized = false; }, legacy: () => { initialLegacy = true; }, unknown: () => { failUnknown = true; }, conflict: () => { conflict = true; } };
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
  assert.match(s.state.notebooks.book.pendingReason!, /layout no longer matches/);
});

test('initialized legacy notebook updates the same document without inserting a native blank', async t => {
  const s = await setup(t); s.legacy(); await s.controller.sync();
  const oldIds = s.state.notebooks.book.pages.map(p => p.pageId);
  s.files.set('Notes/A.md', 'updated alpha'); await s.controller.sync();
  assert.equal(s.stats().writes, 1); assert.equal(s.state.notebooks.book.generation, 2);
  assert.equal(s.state.notebooks.book.documentId, s.remoteId); assert.equal(s.state.notebooks.book.format, 'legacy');
  assert.deepEqual(s.state.notebooks.book.pages.map(p => p.pageId), oldIds);
  assert.ok(s.authorizedFormats.includes('legacy')); assert.equal(s.authorizedFormats.includes('cPages-v2'), false);
  const content = JSON.parse(strFromU8(s.entries()[s.contentKey])); assert.equal(content.cPages, undefined);
  assert.equal(s.state.notes.a.revisions.at(-1)!.firstPage, 3);
});

test('legacy recovery uses the captured format and remains idempotent after unknown success', async t => {
  const s = await setup(t); s.legacy(); await s.controller.sync(); s.files.set('Notes/A.md', 'changed'); s.unknown();
  await assert.rejects(s.controller.sync(), /unknown response/);
  const pending = JSON.parse((await s.store.readText('pending-notebook.json'))!); assert.equal(pending.format, 'legacy');
  // Old journals have no explicit format; the original archive remains authoritative.
  delete pending.format; await s.store.write('pending-notebook.json', JSON.stringify(pending));
  await s.controller.recover();
  assert.equal(s.authorizedFormats.at(-1), 'legacy'); assert.equal(s.stats().writes, 1);
  assert.equal(await s.store.readText('pending-notebook.json'), null);
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

test('a review blocks only its entry while another entry refreshes without discarding that ink', async t => {
  const s = await setup(t); await s.controller.sync(); const ink = s.ink('b', 'beta', 'uncertain beta');
  s.state.reviews.push({ id: 'review-b', noteId: 'b', revisionId: s.state.notes.b.revisions[0].id, fingerprint: '', createdAt: '', base: 'beta', current: 'beta', proposed: 'uncertain beta', tabletText: 'uncertain beta', reasons: ['uncertain'], kinds: [], images: [] });
  s.files.set('Notes/A.md', 'updated alpha'); await s.controller.sync();
  assert.equal(s.stats().writes, 1); assert.ok(s.entries()[ink]);
  assert.equal(s.state.notes.b.revisions.length, 1); assert.equal(s.state.reviews[0].id, 'review-b');
  assert.equal(s.state.notes.a.revisions.at(-1)!.baseline, 'updated alpha');
});

test('disabled or removed mappings retain recovery journals without retrying a pending mutation', async t => {
  const s = await setup(t); await s.controller.sync(); s.files.set('Notes/A.md', 'changed'); s.unknown();
  await assert.rejects(s.controller.sync(), /unknown response/);
  const original = await s.store.readText('pending-notebook.json');
  s.settings.notebookMappings![0].enabled = false; await s.controller.recover();
  assert.equal(s.stats().writeCalls, 1); assert.equal(await s.store.readText('pending-notebook.json'), original);
  s.settings.notebookMappings = []; await s.controller.recover(); assert.equal(s.stats().writeCalls, 1);
  s.settings.notebookMappings = [{ id: 'mapping', folder: 'Notes', title: 'Project Notes', enabled: true }];
  await s.controller.recover(); assert.equal(await s.store.readText('pending-notebook.json'), null);
  assert.equal(s.stats().writes, 1);
});

test('initial creation refuses a conflicting cloud title before upload', async t => {
  const s = await setup(t);
  s.transport.list = async () => [{ id: 'existing', name: 'Project Notes', parent: 'Notes', version: 1, modifiedClient: '' }];
  await s.controller.sync();
  assert.equal(s.stats().uploads, 0); assert.equal(s.state.notebooks.book.generation, 0);
  assert.equal(await s.store.readText('pending-notebook.json'), null);
  assert.match(s.state.notebooks.book.pendingReason!, /already exists/);
});

test('post-publication old layout rollback preserves archive and blocks recognition and writes durably', async t => {
  const s = await setup(t); await s.controller.sync(); const old = s.entries();
  s.files.set('Notes/A.md', 'saved latest note'); await s.controller.sync();
  const accepted = s.entries(), generation = s.state.notebooks.book.generation;
  const active = s.state.notes.a.revisions.at(-1)!, fingerprint = active.fingerprint;
  const pulls = s.events.filter(e => e.startsWith('pull:')).length, calls = s.stats().writeCalls;
  s.restoreEntries(old);
  assert.deepEqual(await s.controller.preflight(), new Set(['book']));
  const conflict = s.state.notebooks.book.layoutConflict!;
  assert.ok(conflict); assert.ok((await s.store.read(conflict.archiveFile)).length);
  assert.match(s.state.notebooks.book.pendingReason!, /close the notebook.*reconciliation/i);
  await s.controller.sync();
  assert.equal(s.events.filter(e => e.startsWith('pull:')).length, pulls); assert.equal(s.stats().writeCalls, calls);
  assert.equal(s.files.get('Notes/A.md'), 'saved latest note'); assert.equal(active.fingerprint, fingerprint);
  assert.equal(s.state.notebooks.book.generation, generation);
  const loaded = await s.store.load();
  const restarted = new NotebookSync(loaded, () => s.settings, s.host, s.store, s.transport, new NoteRenderer(), s.callbacks);
  assert.deepEqual(await restarted.preflight(), new Set(['book']));
  assert.equal(loaded.notebooks.book.layoutConflict!.archiveFile, conflict.archiveFile);
  s.restoreEntries(accepted);
  assert.deepEqual(await s.controller.preflight(), new Set());
  assert.equal(s.state.notebooks.book.layoutConflict, undefined);
});

test('partial rollback during unknown publication preserves the pending journal and never retries overwrite', async t => {
  const s = await setup(t); await s.controller.sync(); const before = s.entries();
  s.files.set('Notes/A.md', 'new note'); s.unknown();
  await assert.rejects(s.controller.sync(), /unknown response/);
  const journal = await s.store.readText('pending-notebook.json'), partial = s.entries();
  partial[s.pdfKey] = before[s.pdfKey]; s.restoreEntries(partial);
  await s.controller.recover();
  assert.equal(s.stats().writeCalls, 1); assert.equal(await s.store.readText('pending-notebook.json'), journal);
  assert.ok(s.state.notebooks.book.layoutConflict); assert.equal(s.state.notebooks.book.generation, 1);
  assert.equal(s.files.get('Notes/A.md'), 'new note');
});

test('mapping paused during upload verification cannot archive its old individual documents', async t => {
  const s = await setup(t);
  s.state.notes.a.revisions.push({ id: 'legacy', baseline: 'older', tabletText: 'older', name: 'legacy', blocks: [], pdfFile: 'old.pdf', archived: false, createdAt: '' });
  const download = s.transport.download; let paused = false;
  s.transport.download = async id => {
    const result = await download(id);
    if (!paused) { paused = true; s.settings.notebookMappings![0].enabled = false; }
    return result;
  };
  await s.controller.sync();
  assert.equal(s.state.notebooks.book.generation, 1); assert.equal(s.state.notes.a.revisions[0].archived, false);
  assert.deepEqual(s.archived, []);
  s.settings.notebookMappings![0].enabled = true; await s.controller.sync();
  assert.deepEqual(s.archived, ['legacy']); assert.equal(s.stats().uploads, 1);
});

test('full SyncEngine roundtrip routes handwritten edits by stable IDs after physical notebook refresh', async t => {
  const s = await setup(t); s.fullEngine(); s.legacy();
  const host: VaultHost = { ...s.host, files: () => [...s.files.keys()], readSaved: async p => s.files.get(p) ?? null,
    compareAndWrite: async (p, expected, next) => { assert.equal(s.files.get(p), expected); s.files.set(p, next); } };
  const real = new NoteRenderer();
  const renderer: Renderer = {
    render: (text, title) => real.render(text, title),
    images: async (archive, originalPdf) => {
      const entries = unzipSync(archive), content = JSON.parse(strFromU8(entries[s.contentKey]));
      assert.equal((await PDFDocument.load(entries[s.pdfKey])).getPageCount(), (await PDFDocument.load(originalPdf)).getPageCount());
      return content.pages.flatMap((id: string, index: number): PageImage[] => {
        const redirect = content.redirectionPageMap[index]; if (redirect < 0) return [];
        const ink = entries[`${s.remoteId}/${id}.rm`], base = Buffer.from(`printed:${id}:${redirect}`).toString('base64');
        const annotated = ink ? Buffer.from(ink).toString('base64') : base;
        return [{ page: redirect + 1, pageId: id, base, annotated, inkHash: hash(annotated) }];
      });
    }
  };
  const seen: Array<{ page: number; blockPage: number; source: string }> = [];
  const recognizer: Recognizer = { check: async () => 'ok', interpret: async (pages, blocks) => ({ warnings: [], edits: pages.map(page => {
    const change = JSON.parse(Buffer.from(page.annotated, 'base64').toString());
    const block = blocks.find(b => b.page === page.page && b.markdown.includes(change.before)); assert.ok(block);
    seen.push({ page: page.page, blockPage: block.page, source: block.markdown });
    return { blockId: block.id, page: page.page, before: change.before, after: change.after, kind: 'replace', ambiguous: false, reason: 'clear' };
  }) }) };
  const engine = new SyncEngine(s.state, () => s.settings, host, s.store, s.transport, renderer, recognizer, () => true);
  await engine.tick();
  const initialCloudLayout = s.entries();
  const first = s.state.notes.a.revisions[0];
  s.ink('a', 'alpha', 'handwritten'); await engine.tick();
  assert.equal(s.files.get('Notes/A.md'), 'handwritten\n\noriginal');
  assert.equal(s.files.get('Notes/B.md'), 'beta'); assert.equal(s.state.reviews.length, 0);
  assert.equal(s.stats().writes, 1); assert.equal(first.superseded, true);
  const refreshed = s.state.notes.a.revisions.at(-1)!;
  assert.deepEqual(refreshed.pageIds, first.pageIds); assert.ok(refreshed.firstPage! > first.lastPage!);
  s.ink('a', 'handwritten', 'second edit'); await engine.tick();
  assert.equal(s.files.get('Notes/A.md'), 'second edit\n\noriginal'); assert.equal(s.stats().writes, 2);
  assert.deepEqual(seen.map(item => item.page), [1, 3]);
  assert.ok(seen.every(item => item.page === item.blockPage));
  await engine.tick(); assert.equal(s.stats().writes, 2); assert.equal(seen.length, 2);
  assert.equal(s.stats().uploads, 1); assert.equal(await s.store.readText('pending-notebook.json'), null);
  initialCloudLayout[`${s.remoteId}/${first.pageIds![0]}.rm`] = strToU8(JSON.stringify({ before: 'alpha', after: 'stale-device ink' }));
  s.restoreEntries(initialCloudLayout);
  await engine.tick();
  assert.ok(s.state.notebooks.book.layoutConflict);
  assert.equal(s.files.get('Notes/A.md'), 'second edit\n\noriginal');
  assert.equal(s.stats().writes, 2); assert.equal(seen.length, 2, 'rollback must be detected before OCR');
});

test('removing a daily mapping publishes individual notes without archiving or renaming the shared notebook', async t => {
  const s = await setup(t); s.fullEngine(); s.legacy();
  const folder = 'Daily/(11) November 2026', aPath = `${folder}/November 1, 2026.md`, bPath = `${folder}/November 2, 2026.md`;
  s.files.clear(); s.files.set(aPath, 'alpha\n\noriginal'); s.files.set(bPath, 'beta');
  s.state.notes.a.path = aPath; s.state.notes.a.date = '2026-11-01';
  s.state.notes.b.path = bPath; s.state.notes.b.date = '2026-11-02';
  s.settings.notebookMappings![0].folder = folder;
  await s.controller.sync();
  const originals = [s.state.notes.a.revisions[0], s.state.notes.b.revisions[0]];
  const individual = new Map<string, { doc: CloudDocument; bytes: Uint8Array }>();
  const originalList = s.transport.list, originalDownload = s.transport.download;
  const renamed: string[] = [];
  s.transport.list = async () => [...await originalList(), ...[...individual.values()].map(entry => entry.doc)];
  s.transport.download = async id => { const entry = individual.get(id); return entry ? { bytes: entry.bytes, fingerprint: hash(entry.bytes) } : originalDownload(id); };
  s.transport.upload = async (name, pdf) => {
    const id = `individual-${individual.size + 1}`, count = (await PDFDocument.load(pdf)).getPageCount();
    const doc = { id, name, parent: 'Notes', version: 1, modifiedClient: '' };
    const content = { fileType: 'pdf', formatVersion: 1, pages: Array.from({ length: count }, () => randomUUID()), redirectionPageMap: Array.from({ length: count }, (_, i) => i), originalPageCount: count, pageCount: count };
    individual.set(id, { doc, bytes: zipSync({ [`${id}.pdf`]: pdf, [`${id}.content`]: strToU8(JSON.stringify(content)) }) }); return doc;
  };
  s.transport.rename = async (id, name) => { renamed.push(id); assert.notEqual(id, s.remoteId, 'shared notebook must never be renamed by per-note publication'); const entry = individual.get(id)!; entry.doc.name = name; return entry.doc; };
  const host: VaultHost = { ...s.host, files: () => [...s.files.keys()], readSaved: async p => s.files.get(p) ?? null,
    compareAndWrite: async (p, expected, next) => { assert.equal(s.files.get(p), expected); s.files.set(p, next); } };
  const real = new NoteRenderer();
  const renderer: Renderer = { render: (text, title) => real.render(text, title), images: async archive => {
    const entries = unzipSync(archive), contentKey = Object.keys(entries).find(key => key.endsWith('.content'))!;
    const content = JSON.parse(strFromU8(entries[contentKey])), id = contentKey.slice(0, -8);
    return content.pages.map((pageId: string, index: number) => {
      const ink = entries[`${id}/${pageId}.rm`], base = Buffer.from(`printed:${pageId}`).toString('base64');
      const annotated = ink ? Buffer.from(ink).toString('base64') : base;
      return { page: content.redirectionPageMap[index] + 1, pageId, base, annotated, inkHash: hash(annotated) };
    });
  } };
  const recognizer: Recognizer = { check: async () => 'ok', interpret: async (pages, blocks) => ({ warnings: [], edits: pages.map(page => {
    const edit = JSON.parse(Buffer.from(page.annotated, 'base64').toString()), block = blocks.find(b => b.page === page.page && b.markdown.includes(edit.before)); assert.ok(block);
    return { blockId: block.id, page: page.page, before: edit.before, after: edit.after, kind: 'replace', ambiguous: false, reason: 'clear' };
  }) }) };
  s.settings.notebookMappings = [];
  const engine = new SyncEngine(s.state, () => s.settings, host, s.store, s.transport, renderer, recognizer, () => true);
  await engine.tick();
  assert.equal(individual.size, 2); assert.equal(s.archived.includes(s.remoteId), false); assert.equal(renamed.includes(s.remoteId), false);
  assert.ok(originals.every(revision => !revision.archived && !revision.superseded));
  assert.ok([s.state.notes.a, s.state.notes.b].every(note => !note.revisions.at(-1)!.notebookId));
  s.ink('a', 'alpha', 'late tablet handwriting'); await engine.tick();
  assert.equal(s.files.get(aPath), 'late tablet handwriting\n\noriginal'); assert.equal(s.files.get(bPath), 'beta');
  assert.equal(s.state.reviews.length, 0); assert.equal(s.archived.includes(s.remoteId), false); assert.equal(renamed.includes(s.remoteId), false);
  const count = individual.size; await engine.tick(); assert.equal(individual.size, count);
});
