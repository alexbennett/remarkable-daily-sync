import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { SyncEngine, type VaultHost } from '../src/engine';
import { LocalStore, hash } from '../src/storage';
import { NoteRenderer } from '../src/renderer';
import type { CloudDocument, Interpretation, Renderer, Recognizer, Settings, Transport } from '../src/contracts';

const file = 'Daily/(10) October 2026/October 12, 2026.md';
const documentId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const pdfKey = `${documentId}.pdf`, contentKey = `${documentId}.content`;
const inkKey = `${documentId}/old-page.rm`;
const initialInk = strToU8('existing original handwriting must be preserved');

async function setup(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-append-engine-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('remarkable-append-engine-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = new LocalStore(directory), state = await store.load();
  const files = new Map([[file, 'old paragraph\n\nuntouched']]);
  const statuses: string[] = [];
  const host: VaultHost = { files: () => [...files.keys()], read: async p => files.get(p) ?? null,
    readSaved: async p => files.get(p) ?? null,
    compareAndWrite: async (p, expected, next) => { assert.equal(files.get(p), expected); files.set(p, next); }, status: text => { statuses.push(text); } };
  const settings: Settings = { dailyRoot: 'Daily', startDate: '2026-10-12', cloudFolder: 'Daily', rmapiPath: '', ollamaUrl: 'http://localhost:11434', model: 'gemma4:26b', paused: false, automatic: true, validatedKinds: ['insert', 'replace', 'delete'], pollSeconds: 60, appendHistory: true, manualRefresh: false };
  let archive: Uint8Array | undefined, doc: CloudDocument | undefined;
  const others = new Map<string, { doc: CloudDocument; bytes: Uint8Array }>();
  let uploads = 0, appends = 0, appendCalls = 0, archives = 0, rejectAppend = false, unknownAfterAppend = false;
  const recognitionCalls: Array<{ pages: number[]; baseline: string }> = [];
  const transport: Transport = {
    check: async () => 'ok', list: async () => [...(doc ? [doc] : []), ...[...others.values()].map(entry => entry.doc)],
    upload: async (name, pdf) => {
      uploads++;
      const count = (await PDFDocument.load(pdf)).getPageCount();
      if (archive) {
        const other = { id: `other-${uploads}`, name, parent: 'Daily', version: 1, modifiedClient: '' };
        others.set(other.id, { doc: other, bytes: zipSync({ [pdfKey]: pdf, [contentKey]: strToU8(JSON.stringify({ fileType: 'pdf', pageCount: count })) }) });
        return other;
      }
      archive = zipSync({ [pdfKey]: pdf, [contentKey]: strToU8(JSON.stringify({ fileType: 'pdf', formatVersion: 1, pageCount: count, originalPageCount: count, pages: Array.from({ length: count }, (_, i) => `old-page-${i}`), redirectionPageMap: Array.from({ length: count }, (_, i) => i) })), [inkKey]: initialInk });
      doc = { id: documentId, name, parent: 'Daily', version: 1, modifiedClient: '' }; return doc;
    },
    download: async id => { const other = others.get(id); if (other) return { bytes: other.bytes, fingerprint: hash(other.bytes) }; assert.equal(id, documentId); assert.ok(archive); return { bytes: archive.slice(), fingerprint: hash(archive) }; },
    archive: async () => { archives++; },
    append: async (id, expected, pdf, content) => {
      appendCalls++; assert.equal(id, documentId); assert.ok(archive);
      const entries = unzipSync(archive);
      if (hash(entries[pdfKey]) === hash(pdf) && hash(entries[contentKey]) === hash(content)) return;
      if (rejectAppend || hash(archive) !== hash(expected)) { const error = new Error('cloud changed'); error.name = 'AppendConflictError'; throw error; }
      entries[pdfKey] = new Uint8Array(pdf); entries[contentKey] = new Uint8Array(content); archive = zipSync(entries); appends++;
      if (unknownAfterAppend) { unknownAfterAppend = false; throw new Error('connection lost after cloud success'); }
    }
  };
  const noteRenderer = new NoteRenderer();
  const renderer: Renderer = {
    render: (markdown, title) => noteRenderer.render(markdown, title),
    images: async (bytes, originalPdf) => {
      const entries = unzipSync(bytes), count = (await PDFDocument.load(entries[pdfKey])).getPageCount();
      assert.equal((await PDFDocument.load(originalPdf)).getPageCount(), count, 'all revision snapshots must use the merged PDF after append');
      const ink: Record<string, Interpretation> = entries['test-ink.json'] ? JSON.parse(strFromU8(entries['test-ink.json'])) : {};
      return Array.from({ length: count }, (_, index) => {
        const page = index + 1, base = Buffer.from(`printed page ${page}`).toString('base64');
        const annotated = ink[page] ? Buffer.from(JSON.stringify(ink[page])).toString('base64') : base;
        return { page, base, annotated, inkHash: hash(annotated) };
      });
    }
  };
  const recognizer: Recognizer = { check: async () => 'ok', interpret: async (pages, _blocks, baseline) => {
    recognitionCalls.push({ pages: pages.map(p => p.page), baseline });
    return { edits: pages.flatMap(p => (JSON.parse(Buffer.from(p.annotated, 'base64').toString()) as Interpretation).edits), warnings: [] };
  } };
  const engine = new SyncEngine(state, () => settings, host, store, transport, renderer, recognizer);
  const restart = async () => new SyncEngine(await store.load(), () => settings, host, store, transport, renderer, recognizer);
  const setInk = (page: number, interpretation: Interpretation) => { assert.ok(archive); const entries = unzipSync(archive); entries['test-ink.json'] = strToU8(JSON.stringify({ [page]: interpretation })); archive = zipSync(entries); };
  const upgradeToCPages = () => {
    assert.ok(archive); const entries = unzipSync(archive);
    const legacy = JSON.parse(strFromU8(entries[contentKey]));
    const pages = legacy.pages.map((id: string, index: number) => ({ id,
      idx: { timestamp: '1:2', value: `b${String.fromCharCode(97 + index)}` },
      redir: { timestamp: '1:2', value: index }, template: { timestamp: '1:2', value: 'Blank' } }));
    const content = { fileType: 'pdf', formatVersion: 2, pageCount: legacy.pageCount,
      cPages: { original: { timestamp: '1:1', value: legacy.pageCount }, uuids: [{ first: '11111111-2222-3333-4444-555555555555', second: 1 }], pages } };
    entries[contentKey] = strToU8(JSON.stringify(content));
    // Keep the original fixture member and include ink under a mapped page ID.
    entries[`${documentId}/${pages[0].id}.rm`] = initialInk;
    archive = zipSync(entries); return content;
  };
  return { engine, state, store, files, settings, restart, setInk, recognitionCalls, upgradeToCPages, statuses,
    getArchive: () => { assert.ok(archive); return archive; },
    stats: () => ({ uploads, appends, appendCalls, archives }),
    conflict: () => { rejectAppend = true; }, unknownSuccess: () => { unknownAfterAppend = true; } };
}

test('append history reuses remote ID, grows real PDF, and pins previous revision ranges', async t => {
  const s = await setup(t); await s.engine.tick();
  const note = Object.values(s.state.notes)[0];
  const originalPdf = unzipSync(s.getArchive())[pdfKey];
  const oldCount = (await PDFDocument.load(originalPdf)).getPageCount();
  s.files.set(file, 'old paragraph\n\nLOCAL'); await s.engine.tick();
  const count = (await PDFDocument.load(unzipSync(s.getArchive())[pdfKey])).getPageCount();
  assert.ok(count > oldCount); assert.equal(note.revisions.length, 2);
  assert.equal(note.revisions[0].firstPage, 1); assert.equal(note.revisions[0].lastPage, oldCount);
  assert.equal(note.revisions[1].documentId, documentId); assert.equal(note.revisions[1].firstPage, oldCount + 1); assert.equal(note.revisions[1].lastPage, count);
  assert.ok(note.revisions[1].blocks.every(b => b.page > oldCount && b.page <= count));
  assert.deepEqual(unzipSync(s.getArchive())[inkKey], initialInk);
  await s.engine.tick(); await s.engine.tick();
  assert.deepEqual(s.stats(), { uploads: 1, appends: 1, appendCalls: 1, archives: 0 });
});

test('cPages defers only publication while handwriting and other notes keep syncing', async t => {
  const s = await setup(t); await s.engine.tick(); await s.engine.tick();
  const note = Object.values(s.state.notes)[0], published = note.lastPublishedHash;
  const original = s.upgradeToCPages(), before = unzipSync(s.getArchive());
  s.files.set(file, 'old paragraph\n\nLOCAL');
  s.files.set('Daily/(10) October 2026/October 13, 2026.md', 'another daily note');
  await s.engine.tick();
  assert.equal(note.lastPublishedHash, published);
  assert.notEqual(note.lastPublishedHash, hash(s.files.get(file)!));
  assert.equal(note.revisions.length, 1);
  assert.equal(s.stats().uploads, 2, 'a deferred note must not block another note upload');
  assert.match(s.statuses.at(-1)!, /layout pending.*cPages.*Handwriting imports continue/);
  assert.equal(await s.store.readText('pending-append.json'), null);
  const block = note.revisions[0].blocks.find(b => b.markdown.includes('old paragraph'))!;
  for (const replacement of ['tablet paragraph', 'updated tablet paragraph']) {
    s.setInk(block.page, { edits: [{ blockId: block.id, page: block.page, before: 'old paragraph', after: replacement, kind: 'replace', ambiguous: false, reason: 'clear' }], warnings: [] });
    await s.engine.tick();
    assert.equal(s.files.get(file), `${replacement}\n\nLOCAL`);
    assert.equal(note.lastPublishedHash, published);
  }
  const restarted = await s.restart(); await restarted.tick(); await restarted.tick();
  const after = unzipSync(s.getArchive());
  assert.equal(hash(after[pdfKey]), hash(before[pdfKey]));
  assert.equal(hash(after[contentKey]), hash(before[contentKey]));
  assert.deepEqual(after[inkKey], initialInk);
  assert.deepEqual(after[`${documentId}/${original.cPages.pages[0].id}.rm`], initialInk);
  assert.equal(s.recognitionCalls.length, 2);
  assert.equal(s.state.reviews.length, 0);
  assert.equal(await s.store.readText('pending-append.json'), null);
  assert.deepEqual(s.stats(), { uploads: 2, appends: 0, appendCalls: 0, archives: 0 });
});
test('handwriting on old appended pages uses that revision baseline and preserves newer local content', async t => {
  const s = await setup(t); await s.engine.tick();
  const note = Object.values(s.state.notes)[0], first = note.revisions[0];
  s.files.set(file, 'old paragraph\n\nLOCAL'); await s.engine.tick();
  const block = first.blocks.find(b => b.markdown.includes('old paragraph'))!;
  s.setInk(block.page, { edits: [{ blockId: block.id, page: block.page, before: 'old paragraph', after: 'tablet paragraph', kind: 'replace', ambiguous: false, reason: 'clear' }], warnings: [] });
  await s.engine.tick();
  assert.equal(s.files.get(file), 'tablet paragraph\n\nLOCAL'); assert.equal(s.state.reviews.length, 0);
  assert.deepEqual(s.recognitionCalls, [{ pages: [block.page], baseline: 'old paragraph\n\nuntouched' }]);
  const count = s.stats().appends; await s.engine.tick();
  assert.equal(s.stats().appends, count); assert.equal(s.recognitionCalls.length, 1);
});

test('append journal recovers cloud success followed by failed local state save without duplicate pages', async t => {
  const s = await setup(t); await s.engine.tick(); s.files.set(file, 'old paragraph\n\nLOCAL');
  const save = s.store.save.bind(s.store); let fail = true;
  s.store.save = async state => { if (fail && s.stats().appends && Object.values(state.notes)[0].revisions.length === 2) { fail = false; throw new Error('state write failed'); } await save(state); };
  await assert.rejects(s.engine.tick(), /state write failed/);
  const pdf = unzipSync(s.getArchive())[pdfKey]; assert.ok(await s.store.readText('pending-append.json'));
  s.store.save = save; const restarted = await s.restart(); await restarted.tick();
  assert.equal(hash(unzipSync(s.getArchive())[pdfKey]), hash(pdf));
  assert.equal(s.stats().appends, 1); assert.equal(s.stats().appendCalls, 2);
  assert.equal(Object.values(restarted.state.notes)[0].revisions.length, 2); assert.equal(await s.store.readText('pending-append.json'), null);
});

test('unknown transport outcome recovers idempotently from pending append payload', async t => {
  const s = await setup(t); await s.engine.tick(); s.files.set(file, 'old paragraph\n\nLOCAL'); s.unknownSuccess();
  await assert.rejects(s.engine.tick(), /connection lost/); assert.ok(await s.store.readText('pending-append.json'));
  const pdf = unzipSync(s.getArchive())[pdfKey]; const restarted = await s.restart(); await restarted.tick();
  assert.equal(hash(unzipSync(s.getArchive())[pdfKey]), hash(pdf)); assert.equal(s.stats().appends, 1);
  assert.equal(Object.values(restarted.state.notes)[0].revisions.length, 2); assert.equal(await s.store.readText('pending-append.json'), null);
});

test('named append conflict clears journal without modifying cloud or revision ranges', async t => {
  const s = await setup(t); await s.engine.tick();
  const original = hash(s.getArchive()); s.files.set(file, 'old paragraph\n\nLOCAL'); s.conflict();
  await assert.rejects(s.engine.tick(), { name: 'AppendConflictError' });
  assert.equal(hash(s.getArchive()), original); assert.equal(await s.store.readText('pending-append.json'), null);
  const note = Object.values(s.state.notes)[0]; assert.equal(note.revisions.length, 1); assert.equal(note.revisions[0].lastPage, undefined);
  assert.equal(s.stats().appends, 0); assert.equal(s.files.get(file), 'old paragraph\n\nLOCAL');
});
