import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { strToU8, strFromU8, zipSync, unzipSync } from 'fflate';
import { prepareAppend } from '../src/append';
import { createPdfWorker } from '../src/renderer';

async function makePdf(texts: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle('Preserved title');
  doc.setCreationDate(new Date('2000-01-01T00:00:00Z')); doc.setModificationDate(new Date('2000-01-01T00:00:00Z'));
  for (const [i, text] of texts.entries()) {
    const page = doc.addPage([702 + i, 936 + i]);
    page.drawText(text, { x: 42, y: 800, size: 14, font });
    page.setCropBox(5, 6, 680, 910); if (i === 1) page.setRotation(degrees(90));
  }
  return doc.save({ addDefaultPage: false });
}
function metadata() { return { fileType: 'pdf', formatVersion: 1, pages: ['old-first', 'old-second'], redirectionPageMap: [1, 0],
  pageCount: 2, originalPageCount: 2, lastOpenedPage: 1, pageTags: [{ pageId: 'old-first', name: 'important' }],
  extraMetadata: { LastPen: 'Ballpointv2' }, documentMetadata: { arbitrary: { nested: true } }, sizeInBytes: '123456' }; }

test('append preserves original page dictionaries, mapping, metadata and archive ink', async () => {
  const oldPdf = await makePdf(['Original first', 'Original second']), newPdf = await makePdf(['New daily content']);
  const ink = new Uint8Array([0, 1, 2, 3, 255]);
  const input = zipSync({ 'doc.pdf': oldPdf, 'doc.content': strToU8(JSON.stringify(metadata())), 'doc/old-first.rm': ink });
  const before = input.slice();
  const result = await prepareAppend(input, newPdf);
  assert.deepEqual(input, before); assert.deepEqual(unzipSync(input)['doc/old-first.rm'], ink);
  assert.equal(result.oldPageCount, 2); assert.equal(result.addedPageCount, 1);
  const content = JSON.parse(strFromU8(result.content));
  assert.deepEqual(content.pages.slice(0, 2), metadata().pages);
  assert.deepEqual(content.redirectionPageMap, [1, 0, 2]);
  assert.match(content.pages[2], /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  for (const key of ['lastOpenedPage', 'pageTags', 'extraMetadata', 'documentMetadata', 'sizeInBytes']) assert.deepEqual(content[key], metadata()[key as keyof ReturnType<typeof metadata>]);
  const original = await PDFDocument.load(oldPdf), appended = await PDFDocument.load(result.pdf);
  assert.equal(appended.getTitle(), original.getTitle()); assert.equal(appended.getPageCount(), 3);
  for (let page = 0; page < 2; page++) {
    assert.deepEqual(appended.getPage(page).getMediaBox(), original.getPage(page).getMediaBox());
    assert.deepEqual(appended.getPage(page).getCropBox(), original.getPage(page).getCropBox());
    assert.deepEqual(appended.getPage(page).getRotation(), original.getPage(page).getRotation());
    assert.equal(appended.getPage(page).node.toString(), original.getPage(page).node.toString());
  }
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); const worker = createPdfWorker(); await worker.promise;
  const loaded = await pdfjs.getDocument({ data: result.pdf.slice(), worker }).promise;
  for (const [index, text] of ['Original first', 'Original second', 'New daily content'].entries()) {
    const content = await (await loaded.getPage(index + 1)).getTextContent();
    assert.ok(content.items.some(item => 'str' in item && item.str === text));
  }
  await loaded.destroy(); worker.destroy();
  assert.deepEqual(await prepareAppend(input, newPdf), result, 'identical retry produces identical bytes and page UUIDs');
});

test('append refuses malformed CRDT, incomplete and mismatched mappings before changing anything', async () => {
  const pdf = await makePdf(['One', 'Two']), extra = await makePdf(['Three']);
  const archive = (content: unknown, members = {}) => zipSync({ 'doc.pdf': pdf, 'doc.content': strToU8(JSON.stringify(content)), ...members });
  await assert.rejects(prepareAppend(archive({ ...metadata(), cPages: { pages: [] } }), extra), /cPages/);
  await assert.rejects(prepareAppend(archive({ fileType: 'pdf' }, { 'doc/unknown.rm': new Uint8Array([1]) }), extra), /handwriting/);
  await assert.rejects(prepareAppend(archive({ fileType: 'pdf', pages: ['one', 'two'] }), extra), /partial map/);
  await assert.rejects(prepareAppend(archive({ ...metadata(), redirectionPageMap: [0, 0] }), extra), /mapping/);
  await assert.rejects(prepareAppend(archive({ ...metadata(), redirectionPageMap: [0, -1] }), extra), /mapping/);
  await assert.rejects(prepareAppend(archive(metadata(), { 'second.pdf': pdf }), extra), /one matching/);
  await assert.rejects(prepareAppend(archive(metadata()), await makePdf([])), /nonempty/);
});

test('pristine ink-free PDFs get deterministic old page IDs and identity redirects', async () => {
  const oldPdf = await makePdf(['Pristine one', 'Pristine two']), extra = await makePdf(['Append']);
  const original = { fileType: 'pdf', pageCount: 2, originalPageCount: 2, documentMetadata: { title: 'Unvisited' } };
  const archive = zipSync({ 'doc.pdf': oldPdf, 'doc.content': strToU8(JSON.stringify(original)) });
  const result = await prepareAppend(archive, extra), content = JSON.parse(strFromU8(result.content));
  assert.equal(content.pages.length, 3); assert.equal(new Set(content.pages).size, 3);
  assert.deepEqual(content.redirectionPageMap, [0, 1, 2]); assert.equal(content.originalPageCount, 3);
  assert.deepEqual(content.documentMetadata, original.documentMetadata);
  assert.deepEqual(await prepareAppend(archive, extra), result);
  const emptyArrays = zipSync({ 'doc.pdf': oldPdf, 'doc.content': strToU8(JSON.stringify({ ...original, pages: [], redirectionPageMap: [] })) });
  assert.deepEqual(JSON.parse(strFromU8((await prepareAppend(emptyArrays, extra)).content)).pages, content.pages);
});

test('verified rmapi pristine upload null maps and zero pageCount initialize from PDF', async () => {
  const oldPdf = await makePdf(['Unopened PDF']), extra = await makePdf(['Append']);
  const upload = { fileType: 'pdf', pages: null, redirectionPageMap: null, pageCount: 0 };
  const archive = (more: Record<string, Uint8Array> = {}) => zipSync({ 'doc.pdf': oldPdf, 'doc.content': strToU8(JSON.stringify(upload)), ...more });
  const result = await prepareAppend(archive(), extra), content = JSON.parse(strFromU8(result.content));
  assert.equal(result.oldPageCount, 1); assert.equal(content.pageCount, 2); assert.equal(content.originalPageCount, 2);
  assert.deepEqual(content.redirectionPageMap, [0, 1]); assert.equal(content.pages.length, 2);
  await assert.rejects(prepareAppend(archive({ 'doc/page.rm': new Uint8Array([1]) }), extra), /handwriting/);
});
