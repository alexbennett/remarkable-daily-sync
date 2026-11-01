import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { NoteRenderer } from '../src/renderer';
import { appendNotebookManifest, mappingForFile, newlyDiscoveredEntries, normalizeNotebookFolder, renderNotebook, routeNotebookPage, selectNotebookEntries, validateNotebookMappings } from '../src/notebooks';

const mapping = { id: 'projects', folder: 'Projects', title: 'Project notebook', enabled: true };
const note = (name: string, markdown = 'Hello world.\n') => ({ id: name, path: `Projects/${name}.md`, markdown });

test('explicit mappings select direct Markdown children, respect disabled mappings and reject ambiguous names', () => {
  const entries = [note('Note 10'), note('Note 2'), note('Note 1'), note('nested/Child'), { ...note('Other'), path: 'Others/Other.md' }];
  assert.deepEqual(selectNotebookEntries(mapping, entries).map(entry => entry.id), ['Note 1', 'Note 2', 'Note 10']);
  assert.deepEqual(selectNotebookEntries({...mapping, enabled:false}, entries), []);
  assert.equal(mappingForFile([mapping], 'Projects/Note 1.md')?.id, mapping.id);
  assert.equal(mappingForFile([{...mapping,enabled:false}], 'Projects/Note 1.md')?.id, mapping.id);
  assert.equal(mappingForFile([mapping], 'Projects/nested/Child.md'), undefined);
  assert.equal(mappingForFile([mapping], 'Projects/image.png'), undefined);
  assert.equal(normalizeNotebookFolder('Projects\\Meetings/'), 'Projects/Meetings');
  assert.throws(() => normalizeNotebookFolder('../Private'), /vault-relative/);
  assert.throws(() => validateNotebookMappings([mapping, {...mapping, id:'other',folder:'Other'}]), /duplicate/);
  assert.throws(() => selectNotebookEntries(mapping, [note('Title'),note('title')]), /duplicate/);
});

test('daily entries parse valid dated filenames and order chronologically before other Markdown files', () => {
  const entries = ['2026-11-01', '2025-12-31', '2026-02-30', 'Ideas 10', 'Ideas 2'].map(name => note(name));
  assert.deepEqual(selectNotebookEntries(mapping, entries, {daily:true}).map(entry => entry.id), ['2025-12-31','2026-11-01','2026-02-30','Ideas 2','Ideas 10']);
});

test('mapping validation rejects unsafe runtime paths and consistently matches folder case', () => {
  for (const path of ['/', '\\', 'Projects\nPrivate', 'Projects\0Secret', 'Projects/..', 'Projects./Entry', 'Projects /Entry', 'C:/Projects', '//server/share', 'Projects//Entry'])
    assert.throws(() => normalizeNotebookFolder(path));
  assert.equal(mappingForFile([mapping], 'projects/Test.md')?.id,mapping.id);
  assert.equal(selectNotebookEntries(mapping,[{...note('Test'),path:'projects/Test.md'}]).length,1);
  assert.throws(() => validateNotebookMappings([{...mapping,enabled:'false'} as any]), /Invalid/);
  assert.throws(() => validateNotebookMappings([{...mapping,title:'Title\nSecond'}]), /control/);
  assert.throws(() => validateNotebookMappings([null as any]), /Invalid/);
});

test('combined PDF starts each entry on a page, preserves exact source offsets, and is deterministic', async () => {
  const renderer = new NoteRenderer();
  const inputs = [note('First', '---\ntags: [test]\n---\n# First\n\nContent here.\n'),note('Second', 'More content.\n')];
  const first = await renderNotebook(renderer, mapping.id, inputs), repeated = await renderNotebook(renderer, mapping.id, inputs);
  assert.deepEqual(first.pdf, repeated.pdf);
  assert.equal((await PDFDocument.load(first.pdf)).getPageCount(), 2);
  assert.equal(first.manifest.entries[0].firstPage, 1);
  assert.equal(first.manifest.entries[1].firstPage, 2);
  for (const entry of first.manifest.entries) for (const block of entry.blocks) {
    assert.equal(entry.baseline.slice(block.start,block.end),block.markdown);
    assert.ok(block.page >= entry.firstPage && block.page <= entry.lastPage);
  }
  assert.equal(routeNotebookPage(first.manifest, 2)?.noteId,'Second');
  for (const page of [0,3,1.5,NaN]) assert.equal(routeNotebookPage(first.manifest,page),undefined);
  const malformed = structuredClone(first.manifest);
  malformed.entries[1].firstPage = 1;
  assert.throws(() => routeNotebookPage(malformed,1), /ranges/);
  const wrongSource = structuredClone(first.manifest);
  wrongSource.entries[1].blocks[0].page = 1;
  assert.throws(() => routeNotebookPage(wrongSource,2), /source blocks/);
});

test('new discoveries append without rearranging published entries or mutating their routing', async () => {
  const renderer = new NoteRenderer(), existing = (await renderNotebook(renderer,mapping.id,[note('Later')])).manifest;
  const ordered = selectNotebookEntries(mapping, [note('Later'),note('Earlier')]);
  const discoveries = newlyDiscoveredEntries(existing,ordered);
  assert.deepEqual(discoveries.map(entry=>entry.id),['Earlier']);
  const addition = (await renderNotebook(renderer,mapping.id,discoveries)).manifest;
  const combined = appendNotebookManifest(existing,addition);
  assert.equal(routeNotebookPage(combined,1)?.noteId,'Later');
  assert.equal(routeNotebookPage(combined,2)?.noteId,'Earlier');
  assert.equal(existing.pageCount,1); assert.equal(addition.entries[0].firstPage,1);
  assert.throws(()=>appendNotebookManifest(existing,existing),/already published/);
  await assert.rejects(()=>renderNotebook(renderer,mapping.id,[]),/empty notebook/);
});

test('multi-page entries keep all their pages and route the following entry after them', async () => {
  const renderer = new NoteRenderer();
  const long = note('Long', 'Review daily results.\n'.repeat(40));
  const own = await renderer.render(long.markdown,'Long');
  assert.ok(own.pageCount > 1);
  const combined = await renderNotebook(renderer,mapping.id,[long,note('Next')]);
  assert.equal(combined.manifest.pageCount, own.pageCount + 1);
  assert.equal(combined.manifest.entries[0].lastPage,own.pageCount);
  assert.equal(routeNotebookPage(combined.manifest,own.pageCount)?.noteId,'Long');
  assert.equal(routeNotebookPage(combined.manifest,own.pageCount + 1)?.noteId,'Next');
  assert.deepEqual(combined.manifest.entries[0].blocks,own.blocks);
});
