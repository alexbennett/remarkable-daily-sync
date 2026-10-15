import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { RmapiTransport, RMAPI_COMMIT, archiveFingerprint, archiveContentHash, appendMappingsPresent, AppendConflictError, CloudRateLimitError, type CommandRunner } from '../src/transport';

test('append recovery verifies CRDT identities without accepting absent legacy arrays', () => {
  const wanted = {cPages: {pages: [{id: 'page-a', idx: {timestamp: '1:2', value: 'ba'}, redir: {timestamp: '1:2', value: 0}}]}};
  const current: any = structuredClone(wanted);
  assert.equal(appendMappingsPresent(wanted, current), true);
  current.cPages.pages[0].idx.timestamp = '1:9';
  assert.equal(appendMappingsPresent(wanted, current), true);
  current.cPages.pages[0].redir.value = 1;
  assert.equal(appendMappingsPresent(wanted, current), false);
  current.cPages.pages[0].redir.value = 0;
  current.cPages.pages[0].deleted = {timestamp: '1:10', value: 1};
  assert.equal(appendMappingsPresent(wanted, current), false);
  assert.equal(appendMappingsPresent(wanted, {}), false);
  assert.equal(appendMappingsPresent({}, {}), false);
  assert.equal(appendMappingsPresent({pages: [], redirectionPageMap: []}, current), false);
});

const node = (id: string, name: string, parent: string, type = 'DocumentType') => ({id, name, parent, type, version: 1, modifiedClient: '2026-10-11T00:00:00Z'});
const root = node('folder', 'Daily', '', 'CollectionType');
const archive = node('archive', 'Archive', root.id, 'CollectionType');
const pdf = new TextEncoder().encode('%PDF-test');
const packed = zipSync({'doc.pdf': pdf, 'doc.content': new TextEncoder().encode('{}')});

async function cacheFixture(run: (t: RmapiTransport, state: {hash?: string; bytes: Uint8Array; gets: number; failMove: boolean}) => Promise<void>, limit?: number) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rmapi-cache-test-'));
  const state = {hash: archiveContentHash(packed) as string | undefined, bytes: packed, gets: 0, failMove: false};
  const runner: CommandRunner = async (_binary, args, options) => {
    if (args.includes('ls')) return JSON.stringify([root]);
    if (args.includes('find')) return JSON.stringify([root, ...['one', 'two'].map(id => ({...node(id, id, root.id), contentHash: state.hash}))]);
    if (args.includes('get')) { state.gets++; await writeFile(path.join(options.cwd, args.at(-1)! + '.rmdoc'), state.bytes); return 'OK'; }
    if (args.includes('mv') && state.failMove) throw new Error('unknown mutation outcome');
    throw new Error('Unexpected command');
  };
  try { await run(new RmapiTransport(path.join(dir, 'rmapi.exe'), dir, 'Daily', runner, limit), state); }
  finally { await rm(dir, {recursive: true, force: true}); }
}
test('authoritative full document hash skips unchanged downloads and detects ink changes without metadata changes', async () => cacheFixture(async (t, state) => {
  const first = await t.download('one'); first.bytes[0] = 0; // A caller must not corrupt the cached archive.
  await t.list(); const second = await t.download('one'); assert.equal(state.gets, 1); assert.equal(second.bytes[0], 80);
  state.bytes = zipSync({'doc.pdf': pdf, 'doc.content': Buffer.from('{}'), 'doc/page.rm': Buffer.from('new ink')});
  state.hash = archiveContentHash(state.bytes); await t.list(); await t.download('one'); assert.equal(state.gets, 2);
}));
test('missing and invalid hashes never fall back to versions or timestamps', async () => cacheFixture(async (t, state) => {
  for (const hash of [undefined, 'bad-hash']) { state.hash = hash; await t.list(); const before = state.gets; await t.download('one'); await t.download('one'); assert.equal(state.gets, before + 2); }
}));
test('download racing listed hash is never cached under the wrong revision', async () => cacheFixture(async (t, state) => {
  state.hash = '0'.repeat(64); await t.download('one'); await t.download('one'); assert.equal(state.gets, 2);
}));
test('download LRU respects byte bound and bypasses entries larger than the budget', async () => {
  await cacheFixture(async (t, state) => { await t.download('one'); await t.download('two'); await t.download('two'); assert.equal(state.gets, 2); await t.download('one'); assert.equal(state.gets, 3); }, packed.length);
  await cacheFixture(async (t, state) => { await t.download('one'); await t.download('one'); assert.equal(state.gets, 2); }, packed.length - 1);
});
test('unknown mutation outcome invalidates previously cached downloads', async () => cacheFixture(async (t, state) => {
  await t.download('one'); state.failMove = true; await assert.rejects(t.rename('one', 'renamed'), /unknown mutation/);
  await t.download('one'); assert.equal(state.gets, 2);
}));

test('cooldown defaults to one minute and preserves longer server waits', () => {
  assert.equal(new CloudRateLimitError().retryAfterMs, 60_000);
  assert.equal(new CloudRateLimitError(1800_000).retryAfterMs, 1800_000);
  assert.match(new CloudRateLimitError().message, /60 seconds/);
});

test('rate limits do not retry immediately and stop subsequent helper calls during cooldown', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rmapi-rate-test-'));
  let calls = 0;
  try {
    const transport = new RmapiTransport(path.join(dir, 'rmapi.exe'), dir, 'Daily', async () => { calls++; throw new CloudRateLimitError(); });
    await assert.rejects(transport.list(), /HTTP 429/);
    await assert.rejects(transport.list(), /HTTP 429/);
    await assert.rejects(transport.check(), /HTTP 429/);
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('downloads reuse the current sync listing instead of relisting every document', async () => {
  await fixture(async (transport, calls) => {
    await transport.list();
    const listings = calls.filter(args => args.includes('ls') || args.includes('find')).length;
    await transport.download('doc'); await transport.download('older');
    assert.equal(calls.filter(args => args.includes('ls') || args.includes('find')).length, listings);
    await transport.list();
    assert.equal(calls.filter(args => args.includes('ls') || args.includes('find')).length, listings + 2);
  });
});
test('temporary listing failures retry with a bounded limit; mutations never retry blindly', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rmapi-retry-test-'));
  let listings = 0, moves = 0, alwaysFail = false;
  const run: CommandRunner = async (_binary, args) => {
    if (args.includes('ls')) {
      listings++;
      if (alwaysFail || listings < 3) throw new Error('temporary failure');
      return JSON.stringify([root]);
    }
    if (args.includes('find')) return JSON.stringify([root, node('doc', 'revision', root.id)]);
    if (args.includes('mv')) { moves++; throw new Error('unknown mutation outcome'); }
    throw new Error('Unexpected command');
  };
  try {
    const transport = new RmapiTransport(path.join(dir, 'rmapi.exe'), dir, 'Daily', run);
    assert.equal((await transport.list()).length, 1); assert.equal(listings, 3);
    await assert.rejects(transport.rename('doc', 'renamed'), /unknown mutation/); assert.equal(moves, 1);
    alwaysFail = true; const before = listings;
    await assert.rejects(transport.list(), /temporary failure/); assert.equal(listings - before, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
async function fixture(fn: (transport: RmapiTransport, calls: string[][], docs: ReturnType<typeof node>[]) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rmapi-test-'));
  const calls: string[][] = [];
  const docs = [root, archive, node('doc', 'revision', root.id), node('older', 'old', archive.id)];
  const run: CommandRunner = async (_binary, args, options) => {
    calls.push(args);
    assert.equal(options.env.RMAPI_CONFIG, path.join(dir, 'rmapi.conf'));
    assert.equal(args[0], '-ni');
    const command = args.find(a => !a.startsWith('-'));
    if (command === 'version') return RMAPI_COMMIT;
    if (command === 'ls') return JSON.stringify([root]);
    if (command === 'find') return JSON.stringify(docs);
    if (command === 'get') {
      const doc = docs.find(n => n.id === args.at(-1))!;
      await writeFile(path.join(options.cwd, doc.name + '.rmdoc'), packed);
      return 'OK';
    }
    if (command === 'mv') {
      const source = args.at(-2)!;
      const sourceParent = path.posix.dirname(source) === '/Daily' ? root.id : archive.id;
      const doc = docs.find(n => n.parent === sourceParent && n.name === path.posix.basename(source))!;
      assert.ok(doc, 'Move source must exist');
      if (args.at(-1) === '/Daily/Archive') doc.parent = archive.id;
      else doc.name = path.posix.basename(args.at(-1)!);
      return 'OK';
    }
    if (command === 'put') {
      const source = args.at(-2)!;
      assert.equal(source, path.basename(source), 'Upload argument must be a basename, not a Windows path');
      assert.deepEqual(new Uint8Array(await readFile(path.join(options.cwd, source))), pdf);
      // Match the upstream Go POSIX path.Base behavior, including on Windows.
      docs.push(node('new', path.posix.basename(source, '.pdf'), root.id)); return 'OK';
    }
    throw new Error('Unexpected command');
  };
  try { await fn(new RmapiTransport(path.join(dir, 'rmapi.exe'), dir, 'Daily', run), calls, docs); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
test('lists active and archived revisions and checks without cloud mutations', async () => fixture(async (t, calls) => {
  assert.equal((await t.list()).length, 2);
  assert.match(await t.check(), /connected/);
  assert.ok(calls.every(a => ['ls', 'find', 'version'].includes(a.find(x => !x.startsWith('-'))!)));
  assert.ok(calls.some(a => a.join(' ') === '-ni -json find /Daily'));
}));
test('downloads by ID and hashes ZIP entries independently of archive metadata', async () => fixture(async (t) => {
  assert.equal((await t.download('doc')).fingerprint, archiveFingerprint(packed));
  await assert.rejects(t.download('unmanaged'), /outside/);
  assert.equal(archiveFingerprint(zipSync({'b': pdf, 'a': pdf})), archiveFingerprint(zipSync({'a': pdf, 'b': pdf})));
}));
test('archive resolves unique path and is idempotent', async () => fixture(async (t, calls) => {
  await t.archive('doc'); await t.archive('doc');
  assert.equal(calls.filter(a => a.includes('mv')).length, 1);
  assert.deepEqual(calls.find(a => a.includes('mv')), ['-ni', 'mv', '/Daily/revision', '/Daily/Archive']);
}));
test('duplicate source names block moving either revision', async () => fixture(async (t, calls, docs) => {
  docs.push(node('duplicate', 'revision', root.id));
  await assert.rejects(t.archive('doc'), /ambiguous/);
  assert.ok(!calls.some(a => a.includes('mv')));
}));
test('upload retry verifies existing PDF without replacing or duplicating it', async () => fixture(async (t, calls) => {
  assert.equal((await t.upload('new revision', pdf)).id, 'new');
  assert.equal((await t.upload('new revision', pdf)).id, 'new');
  assert.equal(calls.filter(a => a.includes('put')).length, 1);
  assert.ok(!calls.flat().some(a => a === '--force' || a === '--content-only'));
  await assert.rejects(t.upload('new revision', new Uint8Array([1])), /verification failed/);
}));
test('untrusted wildcard names and out-of-scope listing are rejected', async () => fixture(async (t, calls, docs) => {
  docs.find(n => n.id === 'doc')!.name = '*';
  await assert.rejects(t.download('doc'), /Unsafe/);
  assert.ok(!calls.some(a => a.includes('get')));
  docs.push(node('outside', 'Oops', 'unrelated'));
  await assert.rejects(t.list(), /escaped/);
}));
test('renames active revision to date display title, preserving ID and retrying idempotently', async () => fixture(async (t, calls) => {
  const renamed = await t.rename('doc', 'October 11, 2026');
  assert.equal(renamed.id, 'doc');
  assert.equal(renamed.name, 'October 11, 2026');
  assert.equal(renamed.parent, root.id);
  await t.rename('doc', 'October 11, 2026');
  assert.deepEqual(calls.filter(a => a.includes('mv')), [['-ni', 'mv', '/Daily/revision', '/Daily/October 11, 2026']]);
}));
test('renames archived revisions within Archive and allows same title in another parent', async () => fixture(async (t, calls) => {
  const renamed = await t.rename('older', 'revision');
  assert.equal(renamed.id, 'older');
  assert.equal(renamed.parent, archive.id);
  assert.deepEqual(calls.find(a => a.includes('mv')), ['-ni', 'mv', '/Daily/Archive/old', '/Daily/Archive/revision']);
}));
test('rename rejects sibling documents and folders without moving any document', async () => fixture(async (t, calls, docs) => {
  docs.push(node('occupied', 'October 11, 2026', root.id));
  await assert.rejects(t.rename('doc', 'October 11, 2026'), /occupied/);
  await assert.rejects(t.rename('doc', 'Archive'), /occupied/);
  assert.ok(!calls.some(a => a.includes('mv')));
}));
test('rename rejects unsafe names, unmanaged IDs, ambiguous source, and nested documents', async () => fixture(async (t, calls, docs) => {
  await assert.rejects(t.rename('doc', '../outside'), /Unsafe/);
  await assert.rejects(t.rename('missing', 'safe'), /unmanaged/);
  docs.push(node('duplicate', 'revision', root.id));
  await assert.rejects(t.rename('doc', 'safe'), /ambiguous/);
  docs.push(node('nested-folder', 'Nested', root.id, 'CollectionType'), node('nested-doc', 'document', 'nested-folder'));
  await assert.rejects(t.rename('nested-doc', 'safe'), /Only active/);
  assert.ok(!calls.some(a => a.includes('mv')));
}));
test('date-title lifecycle archives unique prior revision before assigning title to new revision', async () => fixture(async (t, calls) => {
  await t.rename('doc', 'October 11, 2026');
  const next = await t.upload('revision-r0002', pdf);
  await t.rename('doc', 'revision-r0001');
  await t.archive('doc');
  await t.rename(next.id, 'October 11, 2026');
  const documents = await t.list();
  assert.equal(documents.find(n => n.id === 'doc')!.name, 'revision-r0001');
  assert.equal(documents.find(n => n.id === 'doc')!.parent, archive.id);
  assert.equal(documents.find(n => n.id === next.id)!.name, 'October 11, 2026');
  assert.equal(documents.find(n => n.id === next.id)!.parent, root.id);
  assert.ok(!calls.flat().some(a => ['--force', '--content-only', 'rm'].includes(a)));
}));
test('guarded append passes baseline bytes and verifies same document with later ink preserved', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'rmapi-append-test-'));
  const beforeContent = Buffer.from(JSON.stringify({ pages: ['p1'], redirectionPageMap: [0] }));
  const afterContent = Buffer.from(JSON.stringify({ pages: ['p1', 'p2'], redirectionPageMap: [0, 1] }));
  const baseline = zipSync({'doc.pdf': pdf, 'doc.content': beforeContent, 'doc/p1.rm': Buffer.from('original ink')});
  const newPdf = Buffer.from('%PDF-appended');
  let marker = 'APPEND_OK'; let calls = 0;
  const runner: CommandRunner = async (_binary, args, options) => {
    if (args.includes('ls')) return JSON.stringify([root]);
    if (args.includes('find')) return JSON.stringify([root, node('doc', '2026-10-12', root.id)]);
    if (args.includes('append-pages')) {
      calls++;
      assert.deepEqual(args, ['-ni', 'append-pages', '--id', 'doc', '--expected-archive', 'expected.rmdoc', '--pdf', 'combined.pdf', '--content', 'appended.content']);
      assert.deepEqual(new Uint8Array(await readFile(path.join(options.cwd, 'expected.rmdoc'))), baseline);
      assert.deepEqual(await readFile(path.join(options.cwd, 'combined.pdf')), newPdf);
      return marker + '\n';
    }
    if (args.includes('get')) {
      await writeFile(path.join(options.cwd, '2026-10-12.rmdoc'), zipSync({'doc.pdf': newPdf, 'doc.content': afterContent, 'doc/p1.rm': Buffer.from('newer ink after append')}));
      return 'OK';
    }
    throw new Error('Unexpected command');
  };
  try {
    const transport = new RmapiTransport(path.join(dir, 'rmapi.exe'), dir, 'Daily', runner);
    await transport.append('doc', baseline, newPdf, afterContent);
    marker = 'APPEND_CONFLICT';
    await assert.rejects(transport.append('doc', baseline, newPdf, afterContent), AppendConflictError);
    marker = 'unrecognized output';
    await assert.rejects(transport.append('doc', baseline, newPdf, afterContent), /not confirmed/);
    await assert.rejects(transport.append('outside', baseline, newPdf, afterContent), /active managed/);
    assert.equal(calls, 3);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
