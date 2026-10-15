import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncEngine, type VaultHost } from '../src/engine';
import { LocalStore, hash } from '../src/storage';
import { CloudRateLimitError } from '../src/transport';
import type { CloudDocument, Interpretation, Recognizer, Renderer, Settings, Transport } from '../src/contracts';

const notePath = 'Daily/(10) October 2026/October 11, 2026.md';
const replacement = (after: string): Interpretation => ({ edits: [{ blockId: 'a', before: 'old', after, kind: 'replace', page: 1, ambiguous: false, reason: 'clear' }], warnings: [] });
async function setup(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remarkable-engine-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('remarkable-engine-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = new LocalStore(directory), state = await store.load();
  const files = new Map([[notePath, 'old\nuntouched']]);
  const attachments = new Map<string, Uint8Array>();
  const writes: string[] = [], statuses: string[] = [];
  const host: VaultHost = {
    writeAttachment: async (name, bytes) => { attachments.set(name, bytes); },
    files: () => [...files.keys()], read: async p => files.get(p) ?? null,
    readSaved: async p => files.get(p) ?? null,
    compareAndWrite: async (p, expected, next) => { assert.equal(files.get(p), expected); files.set(p, next); writes.push(next); },
    status: s => { statuses.push(s); }
  };
  const settings: Settings = { dailyRoot: 'Daily', startDate: '2026-10-11', cloudFolder: 'Daily', rmapiPath: '', ollamaUrl: 'http://localhost:11434', model: 'gemma4:26b', paused: false, automatic: true, validatedKinds: ['insert', 'replace', 'delete'], pollSeconds: 60 };
  const cloud = new Map<string, { doc: CloudDocument; data: Interpretation; version: number }>();
  let uploads = 0, recognitions = 0;
  const transport: Transport = {
    list: async () => [...cloud.values()].map(v => v.doc), check: async () => 'ok',
    upload: async name => {
      const existing = [...cloud.values()].find(v => v.doc.name === name); if (existing) return existing.doc;
      uploads++; const doc = { id: `doc-${uploads}`, name, parent: 'Daily', version: 1, modifiedClient: '' };
      cloud.set(doc.id, { doc, data: { edits: [], warnings: [] }, version: 1 }); return doc;
    },
    download: async id => { const v = cloud.get(id)!; const bytes = Buffer.from(JSON.stringify(v.data)); return { bytes, fingerprint: hash(`${v.version}:${bytes.toString()}`) }; },
    archive: async id => { cloud.get(id)!.doc.parent = 'Archive'; },
    rename: async (id, name) => {
      const doc = cloud.get(id)!.doc;
      if ([...cloud.values()].some(v => v.doc.id !== id && v.doc.parent === doc.parent && v.doc.name === name)) throw new Error('Duplicate name');
      doc.name = name; return { ...doc };
    }
  };
  const renderer: Renderer = {
    drawingImage: async (_page, region) => Buffer.from(JSON.stringify(region)),
    render: async text => ({ pdf: Buffer.from(text), blocks: [{ id: 'a', start: 0, end: text.length, markdown: text, page: 1 }], pageCount: 1 }),
    images: async bytes => {
      const data = JSON.parse(Buffer.from(bytes).toString()) as Interpretation;
      return data.edits.length || data.warnings.length || data.drawings?.length ? [{ page: 1, base: 'YQ==', annotated: Buffer.from(bytes).toString('base64'), inkHash: hash(bytes) }] : [];
    }
  };
  const recognizer: Recognizer = { check: async () => 'ok', interpret: async pages => { recognitions++; return JSON.parse(Buffer.from(pages[0].annotated, 'base64').toString()); } };
  const makeEngine = async () => new SyncEngine(await store.load(), () => settings, host, store, transport, renderer, recognizer);
  const engine = new SyncEngine(state, () => settings, host, store, transport, renderer, recognizer);
  const ink = (id: string, data: Interpretation) => { const v = cloud.get(id)!; v.data = data; v.version++; };
  return { store, state, files, writes, host, settings, cloud, engine, ink, makeEngine, transport, renderer, attachments, stats: () => ({ uploads, recognitions }) };
}

test('printed drawing mistaken for new ink never becomes a duplicate attachment', async t => {
  const s = await setup(t); await s.engine.tick();
  s.renderer.hasNewDrawingInk = async () => false;
  s.ink('doc-1', { ...replacement('corrected'), drawings: [{ page: 1, x: 100, y: 200, width: 300, height: 200 }] });
  await s.engine.tick();
  assert.equal(s.files.get(notePath), 'corrected\nuntouched');
  assert.equal(s.attachments.size, 0);
});

test('background and forced sync respect cloud rate-limit cooldown', async t => {
  const s = await setup(t); let calls = 0;
  s.transport.list = async () => { calls++; throw new CloudRateLimitError(); };
  await assert.rejects(s.engine.tick(), /HTTP 429/);
  await s.engine.tick(); await s.engine.tick(true);
  assert.equal(calls, 1);
});

test('saved overlap-only handwriting recovers before a failed cloud listing and only once', async t => {
  const s = await setup(t); await s.engine.tick();
  const note = Object.values(s.state.notes)[0], rev = note.revisions[0];
  s.state.reviews.push({ id: 'saved', noteId: note.id, revisionId: rev.id, recognitionVersion: 5,
    fingerprint: 'saved-ink', createdAt: '', base: rev.tabletText, current: rev.baseline,
    proposed: rev.baseline, tabletText: rev.baseline, reasons: ['Handwriting proposals overlap.'],
    kinds: ['insert'], images: [], canValidate: false,
    suggestions: [{blockId:'a',page:1,kind:'insert',before:rev.baseline,after:rev.baseline+'\n\nHandwritten\nparagraph',ambiguous:false,reason:''}] });
  s.transport.list = async () => { throw new Error('Cloud offline'); };
  await assert.rejects(s.engine.tick(), /Cloud offline/);
  assert.equal(s.files.get(notePath), 'old\nuntouched\n\nHandwritten paragraph');
  assert.equal(s.state.reviews.length, 0);
  const writes = s.writes.length;
  await assert.rejects(s.engine.tick(), /Cloud offline/);
  assert.equal(s.writes.length, writes);
  assert.equal(s.stats().recognitions, 0);
});

test('drawings become stable image embeds and highlights merge without duplicate attachments', async t => {
  const s = await setup(t); await s.engine.tick();
  s.ink('doc-1', { ...replacement('==old=='), drawings: [{ page: 1, x: 100, y: 200, width: 300, height: 200 }] });
  await s.engine.tick();
  assert.match(s.files.get(notePath)!, /^==old==\nuntouched/);
  assert.match(s.files.get(notePath)!, /!\[\[reMarkable Attachments\/[a-f0-9]{64}\.png\]\]/);
  assert.equal(s.attachments.size, 1); const result = s.files.get(notePath);
  await s.engine.tick(); assert.equal(s.files.get(notePath), result); assert.equal(s.attachments.size, 1);
});

test('drawing-only imports are supported and failed attachment writes cannot change the note', async t => {
  const s = await setup(t); await s.engine.tick();
  s.ink('doc-1', { edits: [], warnings: [], drawings: [{ page: 1, x: 100, y: 200, width: 300, height: 200 }] });
  const write = s.host.writeAttachment;
  s.host.writeAttachment = async () => { throw new Error('Attachment write failed'); };
  await assert.rejects(s.engine.tick(), /Attachment write failed/); assert.equal(s.files.get(notePath), 'old\nuntouched');
  s.host.writeAttachment = write; await s.engine.tick(); assert.equal(s.state.reviews.length, 0);
  assert.match(s.files.get(notePath)!, /!\[\[/);
});

test('current PDF uses only the date and prior revisions remain uniquely archived', async t => {
  const s = await setup(t); await s.engine.tick();
  assert.equal(s.cloud.get('doc-1')!.doc.name, '2026-10-11');
  s.files.set(notePath, 'updated'); await s.engine.tick();
  assert.equal(s.cloud.get('doc-2')!.doc.name, '2026-10-11');
  assert.equal(s.cloud.get('doc-1')!.doc.parent, 'Archive');
  assert.match(s.cloud.get('doc-1')!.doc.name, /r0001/);
  await s.engine.tick(); assert.equal(s.stats().uploads, 2);
});

test('failed final rename is completed after restart without another upload', async t => {
  const s = await setup(t);
  const rename = s.transport.rename!;
  s.transport.rename = async () => { throw new Error('rename interrupted'); };
  await assert.rejects(s.engine.tick(), /rename interrupted/);
  s.transport.rename = rename;
  const restart = await s.makeEngine(); await restart.tick();
  assert.equal(s.stats().uploads, 1);
  assert.equal(s.cloud.get('doc-1')!.doc.name, '2026-10-11');
});

test('renderer upgrade republishes unchanged Markdown once with the new layout', async t => {
  const s = await setup(t); await s.engine.tick();
  const note = Object.values(s.state.notes)[0]; delete note.renderedVersion;
  await s.store.save(s.state);
  const restart = await s.makeEngine(); await restart.tick();
  assert.equal(s.stats().uploads, 2); assert.equal(s.cloud.get('doc-2')!.doc.name, '2026-10-11');
  await restart.tick(); assert.equal(s.stats().uploads, 2);
});

test('pending reviews from an older recognizer are retried once after an upgrade', async t => {
  const s = await setup(t); s.settings.automatic = false; await s.engine.tick();
  s.ink('doc-1', replacement('tablet')); await s.engine.tick();
  s.state.reviews[0].recognitionVersion = 2;
  const count = s.stats().recognitions; await s.engine.tick();
  assert.equal(s.stats().recognitions, count + 1);
  assert.equal(s.state.reviews[0].recognitionVersion, 6);
  await s.engine.tick(); assert.equal(s.stats().recognitions, count + 1);
});

test('pinned tablet layout imports successive handwriting without replacing the open document', async t => {
  const s = await setup(t); s.settings.manualRefresh = true; await s.engine.tick();
  s.ink('doc-1', replacement('first')); await s.engine.tick();
  s.ink('doc-1', replacement('second')); await s.engine.tick();
  assert.equal(s.files.get(notePath), 'second\nuntouched');
  assert.equal(s.stats().uploads, 1); assert.equal(s.cloud.get('doc-1')!.doc.parent, 'Daily');
  s.files.set(notePath, 'second\nLOCAL'); await s.engine.tick(true);
  assert.equal(s.stats().uploads, 1); // Sync now also respects a pinned layout.
  await s.engine.refreshTablet(notePath);
  assert.equal(s.stats().uploads, 2); assert.equal(s.cloud.get('doc-1')!.doc.parent, 'Archive');
  assert.equal(Object.values(s.state.notes)[0].revisions.at(-1)!.baseline, 'second\nLOCAL');
});

test('explicit tablet layout refresh cannot bypass unresolved handwriting conflicts', async t => {
  const s = await setup(t); s.settings.manualRefresh = true; await s.engine.tick();
  s.files.set(notePath, 'desktop\nuntouched'); s.ink('doc-1', replacement('tablet'));
  await assert.rejects(s.engine.refreshTablet(notePath), /Review pending/);
  assert.equal(s.stats().uploads, 1); assert.equal(s.files.get(notePath), 'desktop\nuntouched');
});

test('automatic edits need no pattern approval but uncertain recognition still needs review', async t => {
  const s = await setup(t); s.settings.validatedKinds = []; await s.engine.tick();
  s.ink('doc-1', replacement('tablet')); await s.engine.tick();
  assert.equal(s.files.get(notePath), 'tablet\nuntouched');
  s.ink('doc-1', { ...replacement('uncertain'), warnings: ['Unclear handwriting'] }); await s.engine.tick();
  assert.equal(s.files.get(notePath), 'tablet\nuntouched');
  assert.equal(s.state.reviews.length, 1);
});

test('repeated polls do not duplicate a handwritten edit or publish again', async t => {
  const s = await setup(t); await s.engine.tick();
  s.ink('doc-1', replacement('tablet')); await s.engine.tick();
  assert.equal(s.files.get(notePath), 'tablet\nuntouched');
  const before = s.stats(); await s.engine.tick(); await s.engine.tick();
  assert.deepEqual(s.stats(), before); assert.equal(s.writes.length, 1); assert.equal(before.uploads, 2);
});
test('late handwriting on archived revisions merges without removing newer local edits', async t => {
  const s = await setup(t); await s.engine.tick();
  s.files.set(notePath, 'old\nLOCAL'); await s.engine.tick();
  assert.equal(s.cloud.get('doc-1')!.doc.parent, 'Archive');
  s.ink('doc-1', replacement('tablet')); await s.engine.tick();
  assert.equal(s.files.get(notePath), 'tablet\nLOCAL'); assert.equal(s.state.reviews.length, 0);
});
test('concurrent overlapping edits require review and preserve current text', async t => {
  const s = await setup(t); await s.engine.tick();
  s.files.set(notePath, 'desktop\nLOCAL'); s.ink('doc-1', replacement('tablet')); await s.engine.tick();
  assert.equal(s.files.get(notePath), 'desktop\nLOCAL'); assert.equal(s.stats().uploads, 1);
  const item = s.state.reviews[0]; assert.equal(item.proposed, 'desktop\nLOCAL'); assert.equal(item.canValidate, false);
  assert.equal(item.tabletText, 'tablet\nuntouched');
  s.files.set(notePath, 'desktop\nMORE'); await assert.rejects(s.engine.review(item.id, 'accept'), /changed/);
  await s.engine.refreshReview(item.id); assert.equal(item.proposed, 'desktop\nMORE');
});
test('rejection is durable and same handwriting does not reappear on repeated polls', async t => {
  const s = await setup(t); s.settings.automatic = false; await s.engine.tick();
  s.ink('doc-1', replacement('tablet')); await s.engine.tick();
  const item = s.state.reviews[0]; assert.equal(item.canValidate, true);
  await s.engine.review(item.id, 'reject'); await s.engine.tick();
  const restart = await s.makeEngine(); await restart.tick();
  assert.equal(s.files.get(notePath), 'old\nuntouched'); assert.equal(restart.state.reviews.length, 0); assert.equal(s.writes.length, 0);
});
test('erasing pending handwriting removes the stale review when prior ink hash matches', async t => {
  const s = await setup(t); s.settings.automatic = false;
  await s.engine.tick(); await s.engine.tick(); // Save the original empty ink hash.
  s.ink('doc-1', replacement('tablet')); await s.engine.tick(); assert.equal(s.state.reviews.length, 1);
  s.ink('doc-1', { edits: [], warnings: [] }); await s.engine.tick();
  assert.equal(s.state.reviews.length, 0); assert.equal(s.files.get(notePath), 'old\nuntouched');
});
test('new automatically applied tablet state supersedes an earlier pending review', async t => {
  const s = await setup(t); s.settings.automatic = false; await s.engine.tick();
  s.ink('doc-1', replacement('first')); await s.engine.tick(); assert.equal(s.state.reviews.length, 1);
  s.settings.automatic = true; s.ink('doc-1', replacement('second')); await s.engine.tick();
  assert.equal(s.state.reviews.length, 0); assert.equal(s.files.get(notePath), 'second\nuntouched');
});
test('erasing manually accepted handwriting is recognized even when blank ink was cached', async t => {
  const s = await setup(t); s.settings.automatic = false; await s.engine.tick(); await s.engine.tick();
  s.ink('doc-1', replacement('tablet')); await s.engine.tick();
  await s.engine.review(s.state.reviews[0].id, 'accept'); assert.equal(s.files.get(notePath), 'tablet\nuntouched');
  s.ink('doc-1', { edits: [], warnings: [] }); await s.engine.tick();
  assert.equal(s.state.reviews.length, 1); assert.equal(s.state.reviews[0].proposed, 'old\nuntouched');
  await s.engine.review(s.state.reviews[0].id, 'accept'); assert.equal(s.files.get(notePath), 'old\nuntouched');
});
test('restart completes a journal after the vault write succeeded but state persistence failed', async t => {
  const s = await setup(t); await s.engine.tick();
  s.ink('doc-1', replacement('tablet'));
  const save = s.store.save.bind(s.store); let injected = false;
  s.store.save = async state => { if (!injected && s.writes.length) { injected = true; throw new Error('simulated crash'); } await save(state); };
  await assert.rejects(s.engine.tick(), /simulated crash/); assert.equal(s.files.get(notePath), 'tablet\nuntouched');
  assert.ok(await s.store.readText('pending-commit.json')); s.store.save = save;
  const restart = await s.makeEngine(); await restart.tick();
  assert.equal(await s.store.readText('pending-commit.json'), null); assert.equal(s.writes.length, 1);
  assert.equal(Object.values(restart.state.notes)[0].revisions[0].tabletText, 'tablet\nuntouched');
});
test('recovery refuses to overwrite newer edits after an interrupted vault write', async t => {
  const s = await setup(t); await s.engine.tick(); s.ink('doc-1', replacement('tablet'));
  const compare = s.host.compareAndWrite;
  s.host.compareAndWrite = async () => { throw new Error('interrupted'); };
  await assert.rejects(s.engine.tick(), /interrupted/);
  s.host.compareAndWrite = compare; s.files.set(notePath, 'newer desktop');
  const restart = await s.makeEngine(); await assert.rejects(restart.tick(), /pending write conflicts/);
  assert.equal(s.files.get(notePath), 'newer desktop'); assert.ok(await s.store.readText('pending-commit.json'));
});
test('local store rejects path traversal', async t => {
  const s = await setup(t); await assert.rejects(s.store.write('../escape.md', 'x'), /Invalid local state path/);
});

test('OCR reuses unchanged pages, recognizes changed pages, and removes erased-page edits', async t => {
  const s = await setup(t); s.settings.manualRefresh = true;
  const blocks = [{id:'a',start:0,end:3,markdown:'old',page:1}, {id:'b',start:4,end:13,markdown:'untouched',page:2}];
  s.renderer.render = async text => ({pdf:Buffer.from(text),blocks,pageCount:2});
  s.renderer.images = async bytes => {
    const parsed = JSON.parse(Buffer.from(bytes).toString()) as Interpretation;
    return [1,2].map(page => { const edits=parsed.edits.filter(e=>e.page===page);
      const annotated=edits.length ? Buffer.from(JSON.stringify({edits,warnings:[]})).toString('base64') : 'YQ==';
      return {page,base:'YQ==',annotated,inkHash:hash(annotated)}; });
  };
  const seen:number[][]=[];
  const recognizer:Recognizer={check:async()=> 'ok',interpret:async pages=>{
    seen.push(pages.map(p=>p.page));return {edits:pages.flatMap(p=>JSON.parse(Buffer.from(p.annotated,'base64').toString()).edits),warnings:[]};
  }};
  const engine=new SyncEngine(s.state,()=>s.settings,s.host,s.store,s.transport,s.renderer,recognizer);
  await engine.tick();
  const second=(after:string)=>({...replacement(after).edits[0],blockId:'b',page:2,before:'untouched'});
  s.ink('doc-1',{edits:[replacement('ONE').edits[0],second('TWO')],warnings:[]});await engine.tick();
  s.ink('doc-1',{edits:[replacement('ONE').edits[0],second('THREE')],warnings:[]});await engine.tick();
  assert.deepEqual(seen,[[1,2],[2]]);assert.equal(s.files.get(notePath),'ONE\nTHREE');
  s.ink('doc-1',{edits:[second('THREE')],warnings:[]});await engine.tick();
  assert.deepEqual(seen,[[1,2],[2]]);assert.equal(s.files.get(notePath),'old\nTHREE');
  s.settings.model='gemma4:latest';
  s.ink('doc-1',{edits:[replacement('ONE').edits[0],second('THREE')],warnings:[]});await engine.tick();
  assert.deepEqual(seen.at(-1),[1,2]);
});

test('clear handwriting refills an originally blank note without approval', async t => {
  const s = await setup(t); s.files.set(notePath, ''); await s.engine.tick();
  const incoming = (text: string): Interpretation => ({edits:[{blockId:'a',page:1,before:'',after:text,kind:'insert',ambiguous:false,reason:''}],warnings:[]});
  s.ink('doc-1', incoming('First handwriting')); await s.engine.tick();
  s.files.set(notePath, ''); s.ink('doc-1', incoming('Updated handwriting')); await s.engine.tick();
  assert.equal(s.files.get(notePath), 'Updated handwriting');
  assert.equal(s.state.reviews.length, 0);
});

test('saved empty-note conflict resolves without cloud or another OCR call', async t => {
  const s = await setup(t); s.files.set(notePath, ''); await s.engine.tick();
  const note=Object.values(s.state.notes)[0], rev=note.revisions[0]; rev.tabletText='Previous handwriting';
  s.state.reviews.push({id:'empty-conflict',noteId:note.id,revisionId:rev.id,recognitionVersion:6,fingerprint:'new-ink',createdAt:'',
    base:rev.tabletText,current:'',proposed:'',tabletText:'New handwriting',reasons:['Obsidian and tablet edits overlap or share an insertion boundary.'],
    kinds:['insert'],images:[],canValidate:false,suggestions:[{blockId:'a',page:1,before:'',after:'New handwriting',kind:'insert',ambiguous:false,reason:''}]});
  s.transport.list=async()=>{throw new Error('Cloud offline');};
  await assert.rejects(s.engine.tick(), /Cloud offline/);
  assert.equal(s.files.get(notePath),'New handwriting'); assert.equal(s.state.reviews.length,0);
  assert.equal(s.stats().recognitions,0);
});

test('a silently dropped save stays pending and retries without recognizing handwriting again', async t => {
  const s = await setup(t); await s.engine.tick();
  const rev = Object.values(s.state.notes)[0].revisions[0];
  const previous = { text: rev.tabletText, fingerprint: rev.fingerprint };
  const write = s.host.compareAndWrite;
  s.host.compareAndWrite = async () => {}; // reports success without saving
  s.ink('doc-1', replacement('tablet'));
  await assert.rejects(s.engine.tick(), /save could not be verified/);
  assert.equal(rev.tabletText, previous.text); assert.equal(rev.fingerprint, previous.fingerprint);
  assert.ok(await s.store.readText('pending-commit.json'));
  assert.equal(await s.store.readText(`ink/${rev.id}.json`), null);
  const recognitions = s.stats().recognitions;
  s.host.compareAndWrite = write;
  await s.engine.tick();
  assert.equal(s.files.get(notePath), 'tablet\nuntouched');
  assert.equal(s.stats().recognitions, recognitions);
  assert.equal(await s.store.readText('pending-commit.json'), null);
});

test('cached editor success cannot acknowledge handwriting before persisted contents match, even on restart', async t => {
  const s = await setup(t); await s.engine.tick();
  const original = s.files.get(notePath)!;
  s.host.readSaved = async () => original;
  s.ink('doc-1', replacement('tablet'));
  await assert.rejects(s.engine.tick(), /save could not be verified/);
  const restart = await s.makeEngine();
  await assert.rejects(restart.tick(), /save could not be verified/);
  assert.equal(Object.values(restart.state.notes)[0].revisions[0].tabletText, original);
  assert.ok(await s.store.readText('pending-commit.json'));
  s.host.readSaved = async p => s.files.get(p) ?? null;
  await restart.tick();
  assert.equal(await s.store.readText('pending-commit.json'), null);
  assert.equal(s.writes.length, 1);
});
