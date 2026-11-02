import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { SyncEngine, type VaultHost } from '../src/engine';
import { LocalStore, hash } from '../src/storage';
import { NoteRenderer } from '../src/renderer';
import type { CloudDocument, Interpretation, NotebookMapping, Recognizer, Renderer, Settings, Transport } from '../src/contracts';

const folder = 'Daily/(10) October 2026';
const oldPath = `${folder}/October 1, 2026.md`, recentPath = `${folder}/October 31, 2026.md`;
const outsidePath = 'Daily/(11) November 2026/November 1, 2026.md';
const mapping = (enabled = true): NotebookMapping => ({ id: 'october', folder, title: 'October Notes', enabled });
async function setup(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-notebook-engine-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('remarkable-notebook-engine-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = new LocalStore(directory), state = await store.load();
  const files = new Map<string, string>([[recentPath, 'recent text'], [oldPath, 'old text'], [outsidePath, 'outside text']]);
  const statuses: string[] = [];
  const host: VaultHost = { files: () => [...files.keys()], read: async p => files.get(p) ?? null, readSaved: async p => files.get(p) ?? null,
    compareAndWrite: async (p, expected, next) => { assert.equal(files.get(p), expected); files.set(p, next); }, status: s => { statuses.push(s); } };
  const settings: Settings = { dailyRoot: 'Daily', startDate: '2026-11-01', cloudFolder: 'Daily', rmapiPath: '', ollamaUrl: 'http://localhost:11434', model: 'gemma4:26b', paused: false, automatic: true, validatedKinds: [], pollSeconds: 60, notebookMappings: [mapping()] };
  const cloud = new Map<string, { doc: CloudDocument; ink: Interpretation }>();
  let uploads = 0, downloads = 0, archives = 0, lists = 0, recognitions = 0;
  const transport: Transport = {
    check: async () => 'ok',
    list: async () => { lists++; return [...cloud.values()].map(c => c.doc); },
    upload: async name => { uploads++; const doc = { id: `remote-${uploads}`, name, parent: 'Daily', version: 1, modifiedClient: '' }; cloud.set(doc.id, { doc, ink: { edits: [], warnings: [] } }); return doc; },
    download: async id => { downloads++; const bytes = Buffer.from(JSON.stringify(cloud.get(id)!.ink)); return { bytes, fingerprint: hash(bytes) }; },
    archive: async () => { archives++; },
    getNotebookWriteCapability: () => ({ supported: false, reason: 'Awaiting tablet validation.' })
  };
  const real = new NoteRenderer();
  const renderer: Renderer = { render: (text, title) => real.render(text, title), images: async bytes => {
    const ink = JSON.parse(Buffer.from(bytes).toString()) as Interpretation;
    return ink.edits.length ? [{ page: 1, base: 'YQ==', annotated: Buffer.from(bytes).toString('base64'), inkHash: hash(bytes) }] : [];
  } };
  const recognizer: Recognizer = { check: async () => 'ok', interpret: async pages => { recognitions++; return JSON.parse(Buffer.from(pages[0].annotated, 'base64').toString()); } };
  const engine = new SyncEngine(state, () => settings, host, store, transport, renderer, recognizer);
  return { store, state, files, settings, transport, cloud, engine, statuses, stats: () => ({ uploads, downloads, archives, lists, recognitions }) };
}

test('mapped folders enroll all dates, reserve paused mappings, and leave unmapped daily publishing active', async t => {
  const s = await setup(t);
  s.files.set(`${folder}/nested/October 2, 2026.md`, 'not a direct child');
  s.files.set(`${folder}/image.png`, 'not Markdown');
  await s.engine.tick();
  const notebook = Object.values(s.state.notebooks)[0];
  assert.deepEqual(notebook.entryIds.map(id => s.state.notes[id].path), [oldPath, recentPath]);
  assert.equal(s.stats().uploads, 1);
  assert.equal(Object.values(s.state.notes).find(n => n.path === outsidePath)!.revisions.length, 1);
  assert.ok(notebook.entryIds.every(id => s.state.notes[id].revisions.length === 0));
  assert.match(s.statuses.at(-1)!, /awaiting.*validation/);
  s.settings.notebookMappings![0].enabled = false;
  s.files.set(recentPath, 'changed while mapping paused');
  await s.engine.tick();
  assert.equal(s.stats().uploads, 1, 'disabled mapping must not fall back to per-note publication');
  await assert.rejects(s.engine.refreshTablet(recentPath), /synthetic notebook/);
});

test('local notebook previews are deterministic and never acknowledge or publish tablet work', async t => {
  const s = await setup(t);
  const preview = await s.engine.previewNotebook('october');
  const firstBytes = await fs.readFile(preview), first = await PDFDocument.load(firstBytes);
  assert.ok(first.getPageCount() >= 2);
  assert.equal(await s.engine.previewNotebook('october'), preview);
  assert.equal(hash(await fs.readFile(preview)), hash(firstBytes));
  const notebook = Object.values(s.state.notebooks)[0];
  assert.equal(notebook.generation, 0); assert.equal(notebook.documentId, undefined);
  assert.deepEqual(notebook.pages, []); assert.equal(notebook.validation, 'pending');
  assert.ok(notebook.entryIds.every(id => s.state.notes[id].lastPublishedHash === undefined && s.state.notes[id].revisions.length === 0));
  assert.deepEqual(s.stats(), { uploads: 0, downloads: 0, archives: 0, lists: 0, recognitions: 0 });
  for (const journal of ['pending-commit.json', 'pending-append.json', 'pending-notebook.json']) assert.equal(await s.store.readText(journal), null);
  const manifest = JSON.parse(await fs.readFile(preview.replace(/\.pdf$/, '.json'), 'utf8'));
  assert.deepEqual(manifest.entries.map((entry: { path: string }) => entry.path), [oldPath, recentPath]);
});

test('new earlier-sorting entries append to established notebook order across reloads', async t => {
  const s = await setup(t); await s.engine.previewNotebook('october');
  const initial = Object.values(s.state.notebooks)[0].entryIds.slice();
  const addition = `${folder}/October 2, 2026.md`; s.files.set(addition, 'newly discovered entry');
  const preview = await s.engine.previewNotebook('october');
  const notebook = Object.values(s.state.notebooks)[0];
  assert.deepEqual(notebook.entryIds.slice(0, 2), initial);
  assert.equal(s.state.notes[notebook.entryIds[2]].path, addition);
  const reloaded = await s.store.load();
  assert.deepEqual(reloaded.notebooks[notebook.id].entryIds, notebook.entryIds);
  const manifest = JSON.parse(await fs.readFile(preview.replace(/\.pdf$/, '.json'), 'utf8'));
  assert.deepEqual(manifest.entries.map((entry: { path: string }) => entry.path), [oldPath, recentPath, addition]);
});

test('existing mapped revisions continue importing handwriting without publishing a replacement', async t => {
  const s = await setup(t);
  s.files.clear(); s.files.set(recentPath, 'old text');
  s.settings.notebookMappings = []; s.settings.startDate = '2026-10-01';
  await s.engine.tick();
  const note = Object.values(s.state.notes)[0], revision = note.revisions[0];
  const block = revision.blocks.find(b => b.markdown.includes('old text'))!;
  const originalHash = note.lastPublishedHash;
  s.settings.notebookMappings = [mapping()];
  s.cloud.get(revision.id)!.ink = { edits: [{ blockId: block.id, page: block.page, before: 'old text', after: 'tablet text', kind: 'replace', ambiguous: false, reason: 'clear' }], warnings: [] };
  await s.engine.tick();
  assert.equal(s.files.get(recentPath), 'tablet text');
  assert.equal(note.lastPublishedHash, originalHash); assert.equal(note.revisions.length, 1);
  assert.equal(s.stats().uploads, 1); assert.equal(s.state.reviews.length, 0);
  await s.engine.tick(); assert.equal(s.stats().recognitions, 1);
});

test('notebook preview cannot interleave with an active cloud sync', async t => {
  const s = await setup(t); let reached!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { reached = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const list = s.transport.list;
  s.transport.list = async () => { reached(); await blocked; return list(); };
  const ticking = s.engine.tick(); await started;
  try { await assert.rejects(s.engine.previewNotebook('october'), /current sync/); }
  finally { release(); await ticking; }
  assert.ok(await s.engine.previewNotebook('october'));
});

