import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { freshState, hash, LocalStore } from '../src/storage';
import type { NotebookMapping, NotebookState } from '../src/contracts';

async function setup(t: TestContext): Promise<LocalStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-notebook-storage-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('remarkable-notebook-storage-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return new LocalStore(directory);
}
const legacy = () => ({ version: 1, notes: { note: { id: 'note', path: 'Daily/November 1, 2026.md', date: '2026-11-01', revisions: [{ id: 'rev', name: 'old tablet document', baseline: '# Original', blocks: [], pdfFile: 'pdf/original.pdf', tabletText: '# Original', archived: false, createdAt: '2026-11-01T12:00:00Z' }] } }, reviews: [{ id: 'review', noteId: 'note', revisionId: 'rev', fingerprint: 'fingerprint', createdAt: '2026-11-01T12:00:00Z', base: '# Original', current: '# Original', proposed: '# Edited', tabletText: '# Edited', reasons: ['Check handwriting'], kinds: ['replace'], images: ['review.png'] }], futureMetadata: { preserve: true } });
const notebook = (): NotebookState => ({ id: 'notebook', mappingId: 'daily', documentId: 'remote', entryIds: ['note'], generation: 2, pages: [{ pageId: 'stable-page', pdfPage: 1, noteId: 'note', revisionId: 'rev' }], validation: 'pending', pendingReason: 'Awaiting tablet validation.' });

test('fresh v2 state has no implicitly enrolled notebooks or write permission', async t => {
  const store = await setup(t);
  assert.deepEqual(await store.load(), freshState());
  assert.deepEqual(freshState(), { version: 2, notes: {}, reviews: [], notebooks: {} });
});

test('v1 migration backs up exact source and preserves reviews, legacy notes, settings and journals', async t => {
  const store = await setup(t), original = legacy(), source = JSON.stringify(original, null, 4) + '\r\n';
  const journals = ['pending-commit.json', 'pending-append.json', 'pending-notebook.json'];
  await store.write('state.json', source);
  for (const name of journals) await store.write(name, `original ${name}`);
  const mappings: NotebookMapping[] = [{ id: 'daily', folder: 'Daily', title: 'Daily Notes', enabled: true }];
  const settings = JSON.stringify({ notebookMappings: mappings }); await store.write('settings.json', settings);
  const migrated = await store.load();
  assert.deepEqual(migrated, { ...original, version: 2, notebooks: {} });
  assert.equal(await store.readText(`backups/state-v1-${hash(source)}.json`), source);
  assert.deepEqual(JSON.parse((await store.readText('state.json'))!), migrated);
  assert.equal(await store.readText('settings.json'), settings);
  for (const name of journals) assert.equal(await store.readText(name), `original ${name}`);
  assert.deepEqual(await store.load(), migrated);
  assert.equal((await fs.readdir(path.join(store.directory, 'backups'))).length, 1);
});

test('migration stops before changing v1 state if its recovery backup cannot be saved', async t => {
  const store = await setup(t), source = JSON.stringify(legacy()); await store.write('state.json', source);
  const write = store.write.bind(store);
  store.write = async (name, bytes) => { if (name.startsWith('backups/state-v1-')) throw new Error('backup denied'); return write(name, bytes); };
  await assert.rejects(store.load(), /backup denied/);
  assert.equal(await store.readText('state.json'), source);
});

test('interrupted migration retries from preserved v1 source and the same backup', async t => {
  const store = await setup(t), source = JSON.stringify(legacy()); await store.write('state.json', source);
  const save = store.save.bind(store); store.save = async () => { throw new Error('interrupted save'); };
  await assert.rejects(store.load(), /interrupted save/);
  assert.equal(await store.readText('state.json'), source);
  assert.equal(await store.readText(`backups/state-v1-${hash(source)}.json`), source);
  store.save = save;
  assert.equal((await store.load()).version, 2);
  assert.equal((await fs.readdir(path.join(store.directory, 'backups'))).length, 1);
});

test('notebook stable identities, order, generation, manifest and pending gate round trip', async t => {
  const store = await setup(t), state = freshState(); state.notebooks.notebook = notebook();
  state.notebooks.notebook.entryIds = ['second', 'first'];
  state.notebooks.notebook.pages = [{ pageId: 'page-second', pdfPage: 1, noteId: 'second', revisionId: 'r2' }, { pageId: 'page-first', pdfPage: 2, noteId: 'first', revisionId: 'r1' }];
  await store.save(state);
  assert.deepEqual(await store.load(), state);
  assert.equal((await store.load()).notebooks.notebook.validation, 'pending');
});

test('unknown state versions and malformed notebook manifests fail without overwriting source', async t => {
  const store = await setup(t);
  const badNotebooks = [
    { ...notebook(), id: 'different-key' }, { ...notebook(), generation: -1 }, { ...notebook(), validation: true },
    { ...notebook(), entryIds: ['note', 'note'] }, { ...notebook(), pages: [{ ...notebook().pages[0], pdfPage: 0 }] },
    { ...notebook(), pages: [notebook().pages[0], notebook().pages[0]] }
  ];
  for (const invalid of [{ ...freshState(), version: 99 }, { ...freshState(), notebooks: [] }, ...badNotebooks.map(n => ({ ...freshState(), notebooks: { notebook: n } }))]) {
    const source = JSON.stringify(invalid); await store.write('state.json', source);
    await assert.rejects(store.load(), /state|manifest/);
    assert.equal(await store.readText('state.json'), source);
  }
});
