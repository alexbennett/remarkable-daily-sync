import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { zipSync, strToU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { NoteRenderer, sourceLines, archivePages, handwritingSvg, createPdfWorker, cropDrawing, highlightedText, inlineRuns } from '../src/renderer';

const archive = (content: unknown, files: Record<string, Uint8Array> = {}) => zipSync({ 'doc.content': strToU8(JSON.stringify(content)), ...files });

test('source offsets retain CRLF, frontmatter, links and unchecked tasks', async () => {
  const markdown = '---\r\ntag: test\r\n---\r\n# Daily agenda\r\n- [ ] Read [[Project]]\r\n';
  const result = await new NoteRenderer().render(markdown, 'October 11, 2026');
  assert.equal(result.pageCount, 1);
  for (const block of result.blocks) assert.equal(markdown.slice(block.start, block.end), block.markdown);
  assert.equal(result.blocks[0].page, 1);
  assert.equal(result.blocks[0].markdown, '# Daily agenda\r\n');
  assert.deepEqual(result.blocks.at(-1), { id: 'append', start: markdown.length, end: markdown.length, markdown: '', page: 1 });
  const pdf = await PDFDocument.load(result.pdf);
  assert.deepEqual(pdf.getPage(0).getSize(), { width: 702, height: 936 });
});

test('highlight markup hides paired delimiters and preserves unmatched syntax', () => {
  assert.deepEqual(highlightedText('A ==yellow== word and ==blue==.'), { text: 'A yellow word and blue.', highlights: [{ start: 2, end: 8 }, { start: 18, end: 22 }] });
  assert.deepEqual(highlightedText('Keep ==unfinished'), { text: 'Keep ==unfinished', highlights: [] });
});

test('common Markdown renders formatted labels while all source blocks stay exact', async () => {
  const source = '# Agenda\n\n| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n| 7 | 8 | 9 |\n\n- **Bold task** with *emphasis*\n- [x] Done\n1. [Website](https://example.com) and [[Project|Alias]]\n> Quote\n---\n```js\nconst value = 1;\n```\n';
  const rendered = await new NoteRenderer({ fontData: readFileSync(new URL('../node_modules/remarkable-rm/fonts/NotoSans-Regular.ttf', import.meta.url)) }).render(source, 'Daily');
  assert.equal(rendered.blocks.filter(b => b.id !== 'append').map(b => b.markdown).join(''), source);
  for (const block of rendered.blocks) assert.equal(source.slice(block.start, block.end), block.markdown);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); const worker = createPdfWorker(); await worker.promise;
  const pdf = await pdfjs.getDocument({ data: rendered.pdf, worker }).promise;
  const text = (await Promise.all(Array.from({ length: pdf.numPages }, async (_, i) => (await (await pdf.getPage(i + 1)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ')))).join(' ');
  for (const hidden of ['|', '---', '**', '*emphasis*', '[x]', 'https://', '[[', '```', '> Quote']) assert.ok(!text.includes(hidden), `No raw marker ${hidden}`);
  for (const visible of ['A', 'B', 'C', '1', '9', 'Bold task', 'emphasis', 'Website', 'Alias', 'Quote', 'const value = 1;']) assert.ok(text.includes(visible), `Rendered ${visible}`);
  await pdf.destroy(); worker.destroy();
  assert.deepEqual(inlineRuns('**bold** and *italic* and `code`').filter(run => run.bold || run.italic || run.code).map(run => run.text), ['bold', 'italic', 'code']);
});

test('missing drawing attachments fail clearly instead of printing their filename', async () => {
  const source = `![[reMarkable Attachments/${'a'.repeat(64)}.png]]\n`;
  await assert.rejects(new NoteRenderer().render(source, 'Daily'), /Cannot resolve drawing attachment/);
  await assert.rejects(new NoteRenderer({ resolveImage: async () => { throw new Error('missing'); } }).render(source, 'Daily'), /missing or unreadable/);
});

test('pagination does not truncate source blocks and output is repeatable', async () => {
  const markdown = Array.from({ length: 90 }, (_, i) => `- Task ${i}: review the daily results.\n`).join('');
  const renderer = new NoteRenderer();
  const first = await renderer.render(markdown, 'Daily');
  const second = await renderer.render(markdown, 'Daily');
  assert.deepEqual(first, second);
  assert.ok(first.pageCount > 2);
  assert.equal(first.blocks.filter(b => b.id !== 'append').map(b => b.markdown).join(''), markdown);
});

test('embedded Noto Unicode output is deterministic too', async () => {
  const fontData = readFileSync(new URL('../node_modules/remarkable-rm/fonts/NotoSans-Regular.ttf', import.meta.url));
  const renderer = new NoteRenderer({ fontData });
  const a = await renderer.render('Café résumé – review.\n', 'Daily');
  const b = await renderer.render('Café résumé – review.\n', 'Daily');
  assert.deepEqual(a.pdf, b.pdf);
});

function v6StrokeFixture(): Uint8Array {
  const concat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));
  const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  const float = (n: number, bytes = 4) => { const b = new Uint8Array(bytes); const view = new DataView(b.buffer); bytes === 4 ? view.setFloat32(0, n, true) : view.setFloat64(0, n, true); return b; };
  const tag = (n: number, wire: number) => new Uint8Array([n * 16 + wire]);
  const id = (tagNo: number, author: number, clock: number) => concat(tag(tagNo, 15), new Uint8Array([author, clock]));
  const integer = (tagNo: number, n: number) => concat(tag(tagNo, 4), u32(n));
  const sub = (tagNo: number, body: Uint8Array) => concat(tag(tagNo, 12), u32(body.length), body);
  const block = (kind: number, body: Uint8Array) => concat(u32(body.length), new Uint8Array([0, 1, 1, kind]), body);
  const header = new Uint8Array(43); header.set(strToU8('reMarkable .lines file, version=6          '));
  const tree = block(1, concat(id(1, 1, 1), id(2, 1, 1), new Uint8Array([0x31, 0]), sub(4, id(1, 0, 1))));
  const seq = (parentAuthor: number, parentId: number, itemId: number) => concat(id(1, parentAuthor, parentId), id(2, 1, itemId), id(3, 0, 0), id(4, 0, 0), integer(5, 0));
  const group = block(4, concat(seq(0, 1, 2), sub(6, concat(new Uint8Array([2]), id(2, 1, 1)))));
  const point = (x: number, y: number) => concat(float(x), float(y), float(1), float(0), float(2), float(.8));
  const stroke = concat(integer(1, 2), integer(2, 0), tag(3, 8), float(1, 8), tag(4, 4), float(0), sub(5, concat(point(-600, 100), point(-400, 200))));
  const line = block(5, concat(seq(1, 1, 3), sub(6, concat(new Uint8Array([3]), stroke))));
  return concat(header, tree, group, line);
}

test('v6 tagged scene tree renders handwriting in fixed original page coordinates', () => {
  const svg = handwritingSvg(v6StrokeFixture());
  assert.match(svg, /<polyline/);
  assert.match(svg, /width="1404" height="1872"/);
  assert.match(svg, /-191\./); // x=-600 tablet pixels converted to 72/226 PDF units.
});

test('PDF handwriting uses original physical page dimensions, not fitted screen dimensions', () => {
  // Our PDFs are 702x936 POINTS, which is larger than the native screen's
  // 447x596 points. Treating those as equal shifts annotations by 226/144.
  const svg = handwritingSvg(v6StrokeFixture(), { width: 702, height: 936, scale: 2 });
  assert.match(svg, /width="1404" height="1872" viewBox="-351 0 702 936"/);
  // The synthetic x=-600,y=100 stroke is now at output x~319.7,y~63.7.
  const viewBox = /viewBox="([^"]+)"/.exec(svg)![1].split(' ').map(Number);
  const firstPoint = /points="([^ ]+)/.exec(svg)![1].split(',').map(Number);
  assert.ok(Math.abs((firstPoint[0] - viewBox[0]) * 2 - 319.7) < .01);
  assert.ok(Math.abs((firstPoint[1] - viewBox[1]) * 2 - 63.716) < .01);
});

test('embedded PDF.js worker loads without module URLs and restores the global hook', async () => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const before = Object.getOwnPropertyDescriptor(globalThis, 'pdfjsWorker');
  const worker = createPdfWorker();
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'pdfjsWorker'), before);
  await worker.promise;
  const rendered = await new NoteRenderer().render('Smoke test\n', 'Daily');
  const pdf = await pdfjs.getDocument({ data: rendered.pdf, worker }).promise;
  assert.equal(pdf.numPages, 1);
  const content = await (await pdf.getPage(1)).getTextContent();
  assert.ok(content.items.some(item => 'str' in item && item.str === 'Smoke test' && item.transform[0] === 24));
  assert.ok(!content.items.some(item => 'str' in item && item.str.includes('Additional handwritten')));
  await pdf.destroy();
  worker.destroy();
});

test('full PNG pipeline overlays v6 handwriting and retains erased/blank pages', async () => {
  const canvasApi = await import('@napi-rs/canvas');
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  };
  const blobs = new Map<string, Blob>();
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  let id = 0, canvasAllocations = 0;
  URL.createObjectURL = blob => { assert.ok(blob instanceof Blob); const key = `test-blob:${++id}`; blobs.set(key, blob); return key; };
  URL.revokeObjectURL = key => { blobs.delete(key); };
  class BrowserImage extends canvasApi.Image {}
  const nativeSrc = Object.getOwnPropertyDescriptor(canvasApi.Image.prototype, 'src')!;
  Object.defineProperty(BrowserImage.prototype, 'src', {
    set(value: string | Uint8Array) {
      if (typeof value === 'string' && blobs.has(value)) {
        void blobs.get(value)!.arrayBuffer().then(buffer => { nativeSrc.set!.call(this, Buffer.from(buffer)); });
      } else nativeSrc.set!.call(this, value);
    },
  });
  setGlobal('document', { createElement: (tag: string) => { assert.equal(tag, 'canvas'); canvasAllocations++; return canvasApi.createCanvas(1, 1); } });
  setGlobal('Image', BrowserImage);
  setGlobal('DOMMatrix', canvasApi.DOMMatrix);
  setGlobal('ImageData', canvasApi.ImageData);
  setGlobal('Path2D', canvasApi.Path2D);
  try {
    const renderer = new NoteRenderer({
      fontData: readFileSync(new URL('../node_modules/remarkable-rm/fonts/NotoSans-Regular.ttf', import.meta.url)),
    });
    const note = await renderer.render('Review daily results.\n'.repeat(16), 'Daily');
    const content = { fileType: 'pdf', pages: ['first', 'second'] };
    const pages = await renderer.images(archive(content, { 'doc.pdf': note.pdf, 'doc/first.rm': v6StrokeFixture() }), note.pdf);
    assert.equal(pages.length, 2);
    assert.equal(pages[0].page, 1);
    assert.notEqual(pages[0].base, pages[0].annotated);
    assert.equal(pages[1].base, pages[1].annotated);
    assert.equal(Buffer.from(pages[0].annotated, 'base64').subarray(1, 4).toString(), 'PNG');
    assert.ok(pages[0].changes && pages[1].changes);
    let previousAllocations = canvasAllocations;
    const repeated = await renderer.images(archive(content, { 'doc.pdf': note.pdf, 'doc/first.rm': v6StrokeFixture() }), note.pdf);
    assert.equal(canvasAllocations, previousAllocations, 'unchanged pages reuse complete images without creating rendering canvases');
    assert.deepEqual(repeated, pages);
    repeated[0].annotated = 'caller mutation';
    assert.equal((await renderer.images(archive(content, { 'doc.pdf': note.pdf, 'doc/first.rm': v6StrokeFixture() }), note.pdf))[0].annotated, pages[0].annotated, 'cache returns independent records');
    await assert.rejects(renderer.images(archive({ ...content, pages: ['first'] }, { 'doc.pdf': note.pdf, 'doc/first.rm': v6StrokeFixture() }), note.pdf), /mapping differs/);
    assert.equal(canvasAllocations, previousAllocations, 'archive integrity/mapping still validated before cache lookup');
    const changeImage = await canvasApi.loadImage(Buffer.from(pages[0].changes!, 'base64'));
    const changesCanvas = canvasApi.createCanvas(changeImage.width, changeImage.height), changesContext = changesCanvas.getContext('2d');
    changesContext.drawImage(changeImage, 0, 0);
    const changePixels = changesContext.getImageData(0, 0, changeImage.width, changeImage.height).data;
    assert.ok(changePixels.some((value, index) => index % 4 !== 3 && value < 200), 'changes image contains fresh handwriting');
    const blankChangeImage = await canvasApi.loadImage(Buffer.from(pages[1].changes!, 'base64'));
    changesContext.drawImage(blankChangeImage, 0, 0);
    assert.ok(changesContext.getImageData(0, 0, changeImage.width, changeImage.height).data.every(value => value === 255), 'printed writing-page rules and labels are completely absent from changes image');
    previousAllocations = canvasAllocations;
    const erased = await renderer.images(archive(content, { 'doc.pdf': note.pdf }), note.pdf);
    assert.equal(canvasAllocations - previousAllocations, 2, 'erasing ink invalidates only that page, leaving the other page cached');
    assert.equal(erased[0].base, erased[0].annotated);
    assert.notEqual(erased[0].inkHash, pages[0].inkHash);
    // Production LocalStore.read returns a Node Buffer, unlike doc.save().
    // It must neither be passed directly to PDF.js nor have its storage detached.
    const storedPdf = Buffer.from(note.pdf);
    const originalBytes = Buffer.from(storedPdf);
    const storedPages = await renderer.images(archive(content, { 'doc.pdf': note.pdf }), storedPdf);
    assert.equal(storedPages.length, 2);
    assert.deepEqual(storedPdf, originalBytes);
    previousAllocations = canvasAllocations;
    const changedPdf = await renderer.render('Review fresh results.\n'.repeat(16), 'Daily');
    const changedPages = await renderer.images(archive(content, { 'doc.pdf': changedPdf.pdf }), changedPdf.pdf);
    assert.equal(canvasAllocations - previousAllocations, 4, 'different PDF bytes invalidate both physical pages');
    assert.notEqual(changedPages[0].base, pages[0].base);
    const uncached = new NoteRenderer({ renderCacheBytes: 1 });
    await uncached.images(archive(content, { 'doc.pdf': note.pdf }), note.pdf);
    previousAllocations = canvasAllocations;
    await uncached.images(archive(content, { 'doc.pdf': note.pdf }), note.pdf);
    assert.equal(canvasAllocations - previousAllocations, 4, 'pages larger than cache memory budget are never retained');
    const size = (image: typeof pages[number]) => 2 * (image.base.length + image.annotated.length + (image.changes?.length ?? 0) + image.inkHash.length) + 1024;
    const smallCache = new NoteRenderer({ renderCacheBytes: Math.max(...erased.map(size)) });
    await smallCache.images(archive(content, { 'doc.pdf': note.pdf }), note.pdf);
    previousAllocations = canvasAllocations;
    await smallCache.images(archive(content, { 'doc.pdf': note.pdf }), note.pdf);
    assert.equal(canvasAllocations - previousAllocations, 4, 'LRU eviction keeps the cache within a one-page memory budget');

    const drawingCanvas = canvasApi.createCanvas(100, 100);
    const drawingContext = drawingCanvas.getContext('2d'); drawingContext.fillStyle = 'white'; drawingContext.fillRect(0, 0, 100, 100);
    drawingContext.fillStyle = 'blue'; drawingContext.fillRect(50, 10, 40, 80);
    const cropped = await cropDrawing(drawingCanvas.toDataURL('image/png').split(',')[1], { x: 500, y: 0, width: 500, height: 1000 });
    const croppedImage = await canvasApi.loadImage(cropped);
    assert.equal(croppedImage.width, 66); assert.equal(croppedImage.height, 100);
    // A clipped model box must include the connected part of a shape below it.
    const shapeCanvas = canvasApi.createCanvas(300, 300), shapeContext = shapeCanvas.getContext('2d');
    shapeContext.fillStyle = 'white'; shapeContext.fillRect(0, 0, 300, 300);
    shapeContext.strokeStyle = 'black'; shapeContext.lineWidth = 3; shapeContext.strokeRect(90, 90, 80, 100);
    const expanded = await cropDrawing(shapeCanvas.toDataURL('image/png').split(',')[1], { x: 290, y: 340, width: 300, height: 180 });
    const expandedImage = await canvasApi.loadImage(expanded); assert.ok(expandedImage.height > 100, 'connected rectangle reaches full height beyond original 54px crop');

    const printed = canvasApi.createCanvas(200, 200), printedContext = printed.getContext('2d');
    printedContext.fillStyle = 'white'; printedContext.fillRect(0, 0, 200, 200);
    printedContext.strokeStyle = 'black'; printedContext.lineWidth = 3; printedContext.strokeRect(25, 25, 50, 50);
    const printedBase = printed.toDataURL('image/png').split(',')[1];
    // Ink elsewhere on the page must not turn the printed square into a new drawing.
    printedContext.fillStyle = 'black'; printedContext.fillRect(160, 160, 20, 4);
    const onlyElsewhere = { page: 1, base: printedBase, annotated: printed.toDataURL('image/png').split(',')[1], inkHash: 'elsewhere' };
    const squareRegion = { x: 100, y: 100, width: 300, height: 300 };
    assert.equal(await renderer.hasNewDrawingInk(onlyElsewhere, squareRegion), false);
    assert.equal(await renderer.hasNewDrawingInk(onlyElsewhere, { x: 80, y: 80, width: 350, height: 350 }), false, 'different-size crop still detects no new ink');
    await assert.rejects(renderer.drawingImage(onlyElsewhere, squareRegion), /no new ink/);
    // Very low contrast image rounding is ignored, not recropped.
    printedContext.fillStyle = 'rgb(244,244,244)'; printedContext.fillRect(40, 40, 10, 10);
    assert.equal(await renderer.hasNewDrawingInk({ ...onlyElsewhere, annotated: printed.toDataURL('image/png').split(',')[1] }, squareRegion), false);
    printedContext.fillStyle = 'black'; printedContext.fillRect(40, 45, 25, 3);
    const newlyMarked = { ...onlyElsewhere, annotated: printed.toDataURL('image/png').split(',')[1] };
    assert.equal(await renderer.hasNewDrawingInk(newlyMarked, squareRegion), true);
    assert.ok((await renderer.drawingImage(newlyMarked, squareRegion)).length > 0);
    await assert.rejects(cropDrawing(pages[0].annotated, { x: 950, y: 0, width: 100, height: 200 }), /bounds/);
    await assert.rejects(cropDrawing(pages[0].annotated, { x: 0, y: 0, width: 0, height: 200 }), /positive/);
    await assert.rejects(cropDrawing(pages[0].annotated, { x: Number.NaN, y: 0, width: 100, height: 200 }), /bounds/);

    const attachment = `reMarkable Attachments/${'a'.repeat(64)}.png`;
    const enrichedSource = `This is ==highlighted== text.\n![[${attachment}]]\n`;
    const enrichedRenderer = new NoteRenderer({ fontData: readFileSync(new URL('../node_modules/remarkable-rm/fonts/NotoSans-Regular.ttf', import.meta.url)),
      resolveImage: async path => { assert.equal(path, attachment); return cropped; } });
    const enriched = await enrichedRenderer.render(enrichedSource, 'Daily');
    assert.equal(enriched.blocks[0].markdown, 'This is ==highlighted== text.\n');
    assert.equal(enriched.blocks[1].markdown, `![[${attachment}]]\n`);
    const enrichedPages = await enrichedRenderer.images(archive({ fileType: 'pdf', pages: Array.from({length: enriched.pageCount}, (_, i) => 'page-' + i) }, { 'doc.pdf': enriched.pdf }), enriched.pdf);
    const renderedImage = await canvasApi.loadImage(Buffer.from(enrichedPages[0].base, 'base64'));
    const inspectCanvas = canvasApi.createCanvas(renderedImage.width, renderedImage.height);
    const inspectContext = inspectCanvas.getContext('2d'); inspectContext.drawImage(renderedImage, 0, 0);
    const pixels = inspectContext.getImageData(0, 0, renderedImage.width, renderedImage.height).data;
    let yellow = 0, blue = 0;
    for (let n = 0; n < pixels.length; n += 4) {
      if (pixels[n] > 240 && pixels[n + 1] > 200 && pixels[n + 2] < 150) yellow++;
      if (pixels[n] < 20 && pixels[n + 1] < 20 && pixels[n + 2] > 230) blue++;
    }
    assert.ok(yellow > 100, 'yellow highlight rendered behind text');
    assert.ok(blue > 100, 'actual attachment pixels rendered into PDF');
    const worker = createPdfWorker(); await worker.promise;
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(enriched.pdf), worker }).promise;
    const extracted = (await (await pdf.getPage(1)).getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ');
    assert.ok(extracted.replace(/\s+/g, ' ').includes('This is highlighted text.')); assert.ok(!extracted.includes('==')); assert.ok(!extracted.includes(attachment));
    await pdf.destroy(); worker.destroy();
  } finally {
    URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke;
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('unsupported glyphs and overlong single lines fail explicitly', async () => {
  await assert.rejects(new NoteRenderer().render('Test 😀', 'Daily'), /font does not support/);
  await assert.rejects(new NoteRenderer().render('word '.repeat(3000), 'Daily'), /line is too long/);
  assert.deepEqual(sourceLines(''), []);
});

test('archive mapping uses PDF redirections, not zip or tablet order', () => {
  const bytes = archive({ fileType: 'pdf', cPages: { pages: [{ id: 'second', redir: { value: 1 } }, { id: 'first', redir: { value: 0 } }] } }, { 'doc/first.rm': new Uint8Array([1]) });
  const result = archivePages(bytes, 2);
  assert.equal(result[0].id, 'first'); assert.equal(result[0].ink?.[0], 1);
  assert.equal(result[1].ink, undefined); // Retained for erasure detection.
});

test('unmapped ink, added pages and transformed layouts fail closed', () => {
  assert.throws(() => archivePages(archive({ fileType: 'pdf', pages: ['first'] }, { 'doc/other.rm': new Uint8Array([1]) }), 1), /Unmapped/);
  assert.throws(() => archivePages(archive({ fileType: 'pdf', cPages: { pages: [{ id: 'first' }] } }), 1), /Added tablet pages/);
  assert.throws(() => archivePages(archive({ fileType: 'pdf', pages: ['first'], transform: { m11: 2 } }), 1), /Transformed/);
  assert.throws(() => archivePages(archive({ fileType: 'pdf', pages: ['first', 'second'], redirectionPageMap: [0, 0] }), 2), /mapping differs/);
  assert.throws(() => archivePages(archive({ fileType: 'pdf', pages: ['first'] }, { 'doc.pdf': new Uint8Array([1]) }), 1, new Uint8Array([2])), /differs from the published baseline/);
  assert.equal(archivePages(archive({ fileType: 'pdf', pages: ['first'] }, { 'doc.pdf': new Uint8Array([1]) }), 1, new Uint8Array([1])).length, 1);
});

test('pristine PDFs and fully erased v6 pages remain identifiable', () => {
  assert.equal(archivePages(archive({ fileType: 'pdf' }), 2).length, 2);
  const header = strToU8('reMarkable .lines file, version=6          ');
  // The format header occupies exactly 43 bytes.
  const empty = new Uint8Array(43); empty.set(header);
  const svg = handwritingSvg(empty);
  assert.match(svg, /width="1404" height="1872"/);
  assert.ok(!svg.includes('<path'));
  const invalid = new Uint8Array(51); invalid.set(empty); invalid[50] = 99;
  assert.throws(() => handwritingSvg(invalid), /Unsupported handwriting block/);
});

test('normal tablet best-fit metadata uses native page center and dimensions', () => {
  const content = { fileType: 'pdf', pages: ['first', 'second'], zoomMode: 'bestFit',
    customZoomCenterX: 0, customZoomCenterY: 936, customZoomScale: 1,
    customZoomPageWidth: 1404, customZoomPageHeight: 1872, customZoomOrientation: 'portrait' };
  assert.equal(archivePages(archive(content), 2).length, 2);
  for (const changed of [{ customZoomScale: 2 }, { customZoomCenterY: 400 }, { customZoomPageWidth: 1500 }, { customZoomScale: NaN }]) {
    assert.throws(() => archivePages(archive({ ...content, ...changed }), 2), /Cropped or zoomed/);
  }
});
