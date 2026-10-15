import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont } from 'pdf-lib';
import { unzipSync, strFromU8 } from 'fflate';
import { parse, renderToSvg } from 'remarkable-rm';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
// PDF.js ships no declarations for the worker implementation.
// @ts-expect-error worker exports are intentionally not part of the typed display API.
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import type { Renderer, RenderedNote, SourceBlock, PageImage } from './contracts';

const WIDTH = 702, HEIGHT = 936;
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

export interface RendererOptions { workerSrc?: string; pdfjsModuleSrc?: string; fontData?: Uint8Array; resolveImage?: (path: string) => Promise<Uint8Array>; renderCacheBytes?: number; }

export interface DrawingRegion { x: number; y: number; width: number; height: number; }

function pixelChanged(original: Uint8ClampedArray, updated: Uint8ClampedArray, i: number): boolean {
  return updated[i + 3] >= 128 && Math.max(Math.abs(original[i] - updated[i]), Math.abs(original[i + 1] - updated[i + 1]), Math.abs(original[i + 2] - updated[i + 2])) >= 24;
}

/** Compare only the requested drawing area: printed images are part of base. */
export async function hasNewDrawingInk(page: PageImage, region: DrawingRegion): Promise<boolean> {
  const { x, y, width, height } = region;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1000 || y + height > 1000)
    throw new Error('Drawing region must be positive and within normalized 0–1000 page bounds.');
  if (typeof document === 'undefined') throw new Error('Drawing comparison requires the Obsidian desktop canvas.');
  if (page.base === page.annotated) return false;
  const load = async (data: string) => {
    if (data.length > 24_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Invalid or oversized drawing page image.');
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('Drawing comparison image could not be decoded.')); image.src = `data:image/png;base64,${data}`; });
    if (!image.width || !image.height || image.width * image.height > 16_000_000) throw new Error('Drawing page dimensions exceed rendering limits.');
    return image;
  };
  const [base, annotated] = await Promise.all([load(page.base), load(page.annotated)]);
  if (base.width !== annotated.width || base.height !== annotated.height) throw new Error('Drawing comparison page sizes do not match.');
  const left = Math.max(0, Math.floor(x * base.width / 1000) - 12), top = Math.max(0, Math.floor(y * base.height / 1000) - 12);
  const right = Math.min(base.width, Math.ceil((x + width) * base.width / 1000) + 12), bottom = Math.min(base.height, Math.ceil((y + height) * base.height / 1000) + 12);
  const canvas = document.createElement('canvas'); canvas.width = right - left; canvas.height = bottom - top;
  try {
    const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas is unavailable.');
    context.drawImage(base, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    const original = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(annotated, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    const updated = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const changed = new Uint8Array(canvas.width * canvas.height); let total = 0;
    for (let pixel = 0; pixel < changed.length; pixel++) {
      const i = pixel * 4;
      // Visible channel change, including coloured highlighter, with a gap
      // above rounding/antialias noise. Baseline image pixels cancel exactly.
      if (pixelChanged(original, updated, i)) {
        changed[pixel] = 1; total++;
      }
    }
    if (total < 8) return false;
    // Require a small connected patch too, so isolated pixel noise isn't ink.
    for (let pixel = 0; pixel < changed.length; pixel++) {
      if (!changed[pixel]) continue;
      const queue = [pixel]; changed[pixel] = 0;
      for (let head = 0; head < queue.length; head++) {
        if (queue.length >= 4) return true;
        const xx = queue[head] % canvas.width, yy = Math.floor(queue[head] / canvas.width);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = xx + dx, ny = yy + dy;
          if (nx < 0 || ny < 0 || nx >= canvas.width || ny >= canvas.height) continue;
          const neighbor = ny * canvas.width + nx;
          if (changed[neighbor]) { changed[neighbor] = 0; queue.push(neighbor); }
        }
      }
    }
    return false;
  } finally { canvas.width = 0; canvas.height = 0; }
}

export async function cropDrawing(annotated: string, region: DrawingRegion): Promise<Uint8Array> {
  const { x, y, width, height } = region;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1000 || y + height > 1000)
    throw new Error('Drawing region must be positive and within normalized 0–1000 page bounds.');
  if (typeof document === 'undefined') throw new Error('Drawing cropping requires the Obsidian desktop canvas.');
  if (annotated.length > 24_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(annotated)) throw new Error('Invalid or oversized drawing page image.');
  const source = new Image();
  await new Promise<void>((resolve, reject) => { source.onload = () => resolve(); source.onerror = () => reject(new Error('Drawing page image could not be decoded.')); source.src = `data:image/png;base64,${annotated}`; });
  if (!source.width || !source.height || source.width * source.height > 16_000_000) throw new Error('Drawing page dimensions exceed rendering limits.');
  let left = Math.max(0, Math.floor(x * source.width / 1000) - 12), top = Math.max(0, Math.floor(y * source.height / 1000) - 12);
  let right = Math.min(source.width, Math.ceil((x + width) * source.width / 1000) + 12);
  let bottom = Math.min(source.height, Math.ceil((y + height) * source.height / 1000) + 12);
  // Follow connected dark strokes beyond the model box. Pale PDF guide lines
  // are deliberately excluded, so a ruling does not expand to the whole page.
  const probe = document.createElement('canvas'); probe.width = source.width; probe.height = source.height;
  try {
    const context = probe.getContext('2d'); if (!context) throw new Error('Canvas is unavailable.');
    context.drawImage(source, 0, 0);
    const pixels = context.getImageData(0, 0, source.width, source.height).data;
    const count = source.width * source.height, visited = new Uint8Array(count), queue = new Uint32Array(Math.min(count, 1_000_000));
    const boundLeft = Math.max(0, left - Math.ceil(source.width * .25)), boundRight = Math.min(source.width, right + Math.ceil(source.width * .25));
    const boundTop = Math.max(0, top - Math.ceil(source.height * .25)), boundBottom = Math.min(source.height, bottom + Math.ceil(source.height * .25));
    let length = 0;
    const add = (xx: number, yy: number) => {
      if (xx < 0 || yy < 0 || xx >= source.width || yy >= source.height) return;
      const index = yy * source.width + xx;
      if (visited[index]) return;
      visited[index] = 1;
      if (pixels[index * 4 + 3] < 128 || Math.min(pixels[index * 4], pixels[index * 4 + 1], pixels[index * 4 + 2]) > 150) return;
      if (xx < boundLeft || xx >= boundRight || yy < boundTop || yy >= boundBottom || length === queue.length)
        throw new Error('Drawing extends too far beyond the detected region; select a larger region for review.');
      queue[length++] = index;
    };
    const original = { left, right, top, bottom };
    for (let yy = original.top; yy < original.bottom; yy++) for (let xx = original.left; xx < original.right; xx++) add(xx, yy);
    for (let position = 0; position < length; position++) {
      const xx = queue[position] % source.width, yy = Math.floor(queue[position] / source.width);
      left = Math.min(left, xx); right = Math.max(right, xx + 1); top = Math.min(top, yy); bottom = Math.max(bottom, yy + 1);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) add(xx + dx, yy + dy);
    }
    left = Math.max(0, left - 4); top = Math.max(0, top - 4); right = Math.min(source.width, right + 4); bottom = Math.min(source.height, bottom + 4);
  } finally { probe.width = 0; probe.height = 0; }
  const canvas = document.createElement('canvas'); canvas.width = right - left; canvas.height = bottom - top;
  try {
    const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas is unavailable.');
    context.drawImage(source, left, top, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    return new Uint8Array(Buffer.from(canvas.toDataURL('image/png').split(',')[1], 'base64'));
  } finally { canvas.width = 0; canvas.height = 0; }
}

export function highlightedText(markdown: string): { text: string; highlights: Array<{ start: number; end: number }> } {
  let text = '', offset = 0;
  const highlights: Array<{ start: number; end: number }> = [];
  for (const match of markdown.matchAll(/(?<!\\)==([^\n]+?)(?<!\\)==/g)) {
    text += markdown.slice(offset, match.index);
    const start = text.length; text += match[1];
    highlights.push({ start, end: text.length }); offset = match.index! + match[0].length;
  }
  return { text: text + markdown.slice(offset), highlights };
}

export interface InlineRun { text: string; bold?: boolean; italic?: boolean; code?: boolean; highlight?: boolean; }
export function inlineRuns(source: string, style: Omit<InlineRun, 'text'> = {}): InlineRun[] {
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|==(.+?)==|\[\[([^\]]+)\]\]|\[([^\]]+)\]\([^\s)]+\)/g;
  const result: InlineRun[] = []; let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index! > cursor) result.push({ ...style, text: source.slice(cursor, match.index) });
    if (match[1]) result.push({ ...style, text: match[1], code: true });
    else if (match[2] || match[3]) result.push(...inlineRuns(match[2] || match[3], { ...style, bold: true }));
    else if (match[4] || match[5]) result.push(...inlineRuns(match[4] || match[5], { ...style, italic: true }));
    else if (match[6]) result.push(...inlineRuns(match[6], { ...style, highlight: true }));
    else result.push({ ...style, text: match[7] ? match[7].split('|').at(-1)! : match[8] });
    cursor = match.index! + match[0].length;
  }
  if (cursor < source.length) result.push({ ...style, text: source.slice(cursor) });
  return result;
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
}
function tableDelimiter(line: string): boolean { return line.includes('|') && tableCells(line).every(cell => /^:?-{3,}:?$/.test(cell)); }

export function createPdfWorker(): pdfjs.PDFWorker {
  // Obsidian app:// pages cannot reliably import file:// ES modules. Bundle
  // both PDF.js parts and select its supported in-process worker. The getter
  // captures this handler synchronously in the constructor, so restore the
  // global before yielding, even when another plugin already set the property.
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'pdfjsWorker');
  try {
    Object.defineProperty(globalThis, 'pdfjsWorker', { value: { WorkerMessageHandler }, configurable: true });
    return new pdfjs.PDFWorker();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'pdfjsWorker', previous);
    else Reflect.deleteProperty(globalThis, 'pdfjsWorker');
  }
}

/** Source offsets are UTF-16 offsets, as used by Obsidian and String.slice. */
export function sourceLines(markdown: string): Array<{ start: number; end: number; markdown: string }> {
  const frontmatter = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(markdown);
  const lines: Array<{ start: number; end: number; markdown: string }> = [];
  let start = frontmatter?.[0].length ?? 0;
  for (const match of markdown.slice(start).matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) continue;
    const end = start + match[0].length;
    lines.push({ start, end, markdown: match[0] });
    start = end;
  }
  return lines;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const result: string[] = [];
  let line = '';
  for (const char of text) {
    if (font.widthOfTextAtSize(line + char, size) > width && line) {
      // Prefer a word boundary, but split a long URL/token safely when required.
      const boundary = line.lastIndexOf(' ');
      if (boundary > line.length / 2) {
        result.push(line.slice(0, boundary));
        line = line.slice(boundary + 1) + char;
      } else { result.push(line); line = char; }
    } else line += char;
  }
  result.push(line);
  return result;
}

export interface ArchivePage { page: number; id: string; ink?: Uint8Array; }

/** Pin tablet coordinates instead of letting the renderer fit ink to its bounds. */
export function handwritingSvg(data: Uint8Array, pageSize?: { width: number; height: number; scale: number }): string {
  const nativeToPoints = 72 / 226;
  const pdfWidth = pageSize?.width ?? 1404 * nativeToPoints;
  const pdfHeight = pageSize?.height ?? 1872 * nativeToPoints;
  const rasterScale = pageSize?.scale ?? 1 / nativeToPoints;
  if (data[32] === 54) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let at = 43; at < data.length;) {
      if (at + 8 > data.length) throw new Error('Truncated handwriting block header.');
      const size = view.getUint32(at, true), kind = data[at + 7], version = data[at + 6];
      if (at + 8 + size > data.length) throw new Error('Truncated handwriting block.');
      if (![0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 13].includes(kind) || version > 2)
        throw new Error(`Unsupported handwriting block ${kind}, version ${version}.`);
      at += 8 + size;
    }
  }
  const parsed = parse(data);
  if (parsed.pages.length !== 1) throw new Error('Unsupported multi-page handwriting file.');
  const visit = (items: any[]) => {
    for (const item of items) {
      if (item.type === 'text') throw new Error('Tablet typed text requires manual review.');
      if (item.type === 'stroke') {
        if (parsed.version === 5) for (const point of item.points) point.x -= pdfWidth / nativeToPoints / 2;
        if (item.pen === 'eraser' || item.pen === 'eraser-area') throw new Error('Legacy eraser strokes require manual review.');
      }
      if (item.type === 'group') visit(item.items);
    }
  };
  for (const page of parsed.pages) {
    if (page.rootText?.paragraphs.some(t => t.spans.some(s => s.text.trim())))
      throw new Error('Tablet typed text requires manual review.');
    for (const layer of page.layers) visit(layer.items);
  }
  let svg = renderToSvg(parsed);
  const box = /viewBox="([^"]+)"/.exec(svg)?.[1].split(/\s+/).map(Number);
  if (!box || box.length !== 4 || box.some(n => !Number.isFinite(n))) throw new Error('Invalid handwriting bounds.');
  // PDF annotations are expressed at 226 DPI relative to the ORIGINAL PDF,
  // not the fitted 1404-pixel tablet screen. renderToSvg already converts to
  // 72-DPI PDF points. v6 x=0 is the horizontal center of that original PDF.
  // The renderer's bounds include one extra native pixel; subtract it first.
  const left = Math.min(-pdfWidth / 2, box[0]);
  const top = Math.min(0, box[1]);
  const right = Math.max(pdfWidth / 2, box[0] + box[2] - nativeToPoints);
  const bottom = Math.max(pdfHeight, box[1] + box[3] - nativeToPoints);
  const width = right - left, height = bottom - top;
  const pixelsWide = Math.round(width * rasterScale), pixelsHigh = Math.round(height * rasterScale);
  if (pixelsWide > 4096 || pixelsHigh > 8192 || pixelsWide * pixelsHigh > 16_000_000) throw new Error('Handwriting extent exceeds rendering limits.');
  svg = svg.replace(/viewBox="[^"]+"/, `width="${pixelsWide}" height="${pixelsHigh}" viewBox="${left} ${top} ${width} ${height}"`);
  return svg;
}

/** Resolve original PDF indices explicitly. Never guess page order from ZIP order. */
export function archivePages(archive: Uint8Array, pageCount: number, originalPdf?: Uint8Array): ArchivePage[] {
  if (archive.length > 80 * 1024 * 1024) throw new Error('Tablet archive exceeds 80 MB limit.');
  let total = 0;
  const files = unzipSync(archive, { filter: entry => {
    if (entry.originalSize > 80 * 1024 * 1024 || (total += entry.originalSize) > 160 * 1024 * 1024)
      throw new Error('Tablet archive expands beyond the safe size limit.');
    return /(?:\.content|\.rm|\.pdf)$/.test(entry.name);
  } });
  if (originalPdf) {
    const pdfFiles = Object.keys(files).filter(name => name.endsWith('.pdf'));
    if (pdfFiles.length !== 1 || hash(files[pdfFiles[0]]) !== hash(originalPdf))
      throw new Error('Tablet PDF differs from the published baseline. Import stopped to protect note mapping.');
  }
  const contents = Object.keys(files).filter(name => name.endsWith('.content'));
  if (contents.length !== 1) throw new Error('Expected exactly one tablet document content file.');
  const content = JSON.parse(strFromU8(files[contents[0]]));
  if (content.fileType !== 'pdf') throw new Error('Only published PDF Daily Notes are supported.');
  if (content.orientation && content.orientation !== 'portrait') throw new Error('Landscape tablet layouts require manual review.');
  // A normal rM2 best-fit page is centered at (0, 936), not (0, 0).
  // Earlier/pristine files omit these fields or store zero-valued defaults.
  const normal = (value: unknown, allowed: number[]) => value === undefined || (typeof value === 'number' && allowed.includes(value));
  if (!normal(content.customZoomCenterX, [0]) || !normal(content.customZoomCenterY, [0, 936]) ||
      !normal(content.customZoomScale, [0, 1]) || !normal(content.customZoomPageWidth, [0, 1404]) ||
      !normal(content.customZoomPageHeight, [0, 1872]) ||
      (content.customZoomOrientation && content.customZoomOrientation !== 'portrait'))
    throw new Error('Cropped or zoomed tablet layouts are not supported. Reset the page view first.');
  if (content.transform) {
    const identity: Record<string, number> = { m11: 1, m12: 0, m13: 0, m21: 0, m22: 1, m23: 0, m31: 0, m32: 0, m33: 1 };
    for (const [key, value] of Object.entries(content.transform)) {
      if (!(key in identity) || !Number.isFinite(Number(value)) || Math.abs(Number(value) - identity[key]) > 1e-6)
        throw new Error('Transformed tablet pages require manual review.');
    }
  }
  let entries: Array<{ id: string; page: number }>;
  if (Array.isArray(content.cPages?.pages) && content.cPages.pages.length) {
    entries = content.cPages.pages.map((item: any) => {
      if (item.deleted?.value) throw new Error('Deleted tablet pages require manual review.');
      if (!Number.isInteger(item.redir?.value) || item.redir.value < 0)
        throw new Error('Added tablet pages are unsupported; use the supplied writing page.');
      return { id: item.id, page: item.redir.value };
    });
  } else if (Array.isArray(content.pages) && content.pages.length) {
    entries = content.pages.map((id: string, index: number) => ({ id, page: content.redirectionPageMap?.[index] ?? index }));
  } else if (!Object.keys(files).some(name => name.endsWith('.rm'))) {
    // A pristine uploaded PDF may have no page IDs until opened on the tablet.
    entries = Array.from({ length: pageCount }, (_, page) => ({ id: `pristine-${page}`, page }));
  } else throw new Error('Tablet page mapping is unavailable.');
  if (entries.length !== pageCount || new Set(entries.map(p => p.page)).size !== pageCount ||
      entries.some(p => !Number.isInteger(p.page) || p.page < 0 || p.page >= pageCount || typeof p.id !== 'string' || !/^[\w-]+$/.test(p.id)))
    throw new Error('Tablet page mapping differs from the published PDF.');
  const used = new Set<string>();
  const result = entries.map(entry => {
    const matches = Object.keys(files).filter(name => name === `${entry.id}.rm` || name.endsWith(`/${entry.id}.rm`));
    if (matches.length > 1) throw new Error('Duplicate tablet page data.');
    if (matches.length) used.add(matches[0]);
    return { ...entry, ink: matches.length ? files[matches[0]] : undefined };
  });
  if (Object.keys(files).some(name => name.endsWith('.rm') && !used.has(name)))
    throw new Error('Unmapped handwriting exists in the tablet archive.');
  return result.sort((a, b) => a.page - b.page);
}

/** PDF pages have the reMarkable 2 aspect ratio, preventing annotation rescaling. */
export class NoteRenderer implements Renderer {
  private readonly renderCache = new Map<string, { image: PageImage; bytes: number }>();
  private cacheBytes = 0;
  private readonly cacheLimit: number;

  constructor(private readonly options: RendererOptions = {}) {
    const requested = options.renderCacheBytes ?? 64 * 1024 * 1024;
    if (!Number.isFinite(requested) || requested < 0) throw new Error('Render cache size must be a finite nonnegative byte count.');
    this.cacheLimit = Math.min(Math.floor(requested), 64 * 1024 * 1024);
  }

  private cachedPage(key: string): PageImage | undefined {
    const entry = this.renderCache.get(key);
    if (!entry) return undefined;
    this.renderCache.delete(key); this.renderCache.set(key, entry);
    // Strings are immutable; clone the mutable record given to callers.
    return { ...entry.image };
  }

  private rememberPage(key: string, image: PageImage): void {
    // Budget strings as UTF-16 (even when V8 stores ASCII compactly) and allow
    // overhead for the key, map entry and record. Never retain oversized pages.
    const bytes = 2 * (key.length + image.base.length + image.annotated.length + (image.changes?.length ?? 0) + image.inkHash.length) + 256;
    const existing = this.renderCache.get(key);
    if (existing) { this.renderCache.delete(key); this.cacheBytes -= existing.bytes; }
    if (bytes > this.cacheLimit) return;
    while (this.cacheBytes + bytes > this.cacheLimit && this.renderCache.size) {
      const oldest = this.renderCache.keys().next().value!;
      this.cacheBytes -= this.renderCache.get(oldest)!.bytes; this.renderCache.delete(oldest);
    }
    this.renderCache.set(key, { image: { ...image }, bytes }); this.cacheBytes += bytes;
  }

  hasNewDrawingInk(page: PageImage, region: DrawingRegion): Promise<boolean> { return hasNewDrawingInk(page, region); }

  async drawingImage(page: PageImage, region: DrawingRegion): Promise<Uint8Array> {
    if (!await hasNewDrawingInk(page, region)) throw new Error('Drawing region contains no new ink relative to the printed baseline.');
    return cropDrawing(page.annotated, region);
  }

  async render(markdown: string, title: string): Promise<RenderedNote> {
    const doc = await PDFDocument.create();
    doc.setTitle(title); doc.setCreator('Obsidian Daily Notes Sync');
    doc.setCreationDate(new Date('2000-01-01T00:00:00Z'));
    doc.setModificationDate(new Date('2000-01-01T00:00:00Z'));
    let font: PDFFont;
    if (this.options.fontData) {
      const fontkit = await import('@pdf-lib/fontkit');
      doc.registerFontkit(fontkit.default);
      font = await doc.embedFont(this.options.fontData, { subset: true });
    } else font = await doc.embedFont(StandardFonts.Helvetica);
    const monospace = await doc.embedFont(StandardFonts.Courier);
    const monoChars = new Set(monospace.getCharacterSet());
    const supported = new Set(font.getCharacterSet());
    for (const char of title + sourceLines(markdown).map(line => line.markdown).join('')) {
      if (!/[\r\n\t]/.test(char) && !supported.has(char.codePointAt(0)!))
        throw new Error(`The PDF font does not support ${JSON.stringify(char)}. Note was not published.`);
    }
    const blocks: SourceBlock[] = [];
    let page = doc.addPage([WIDTH, HEIGHT]);
    let y = HEIGHT - 100;
    const decorate = () => {
      const titleLines = wrap(title, font, 34, WIDTH - 70);
      if (titleLines.length > 2) throw new Error('Daily Note title is too long.');
      titleLines.forEach((line, index) => page.drawText(line, { x: 36, y: HEIGHT - 48 - index * 40, size: 34, font }));
      y = Math.min(y, HEIGHT - 70 - titleLines.length * 40);
      page.drawText(`Daily Notes / ${doc.getPageCount()}`, { x: 36, y: 26, size: 9, font, color: rgb(.45, .45, .45) });
      page.drawLine({ start: { x: 526, y: 60 }, end: { x: 526, y: HEIGHT - 85 }, color: rgb(.87, .87, .87), thickness: .5 });
    };
    const next = () => { if (doc.getPageCount() >= 100) throw new Error('Daily Note exceeds 100 pages.'); page = doc.addPage([WIDTH, HEIGHT]); y = HEIGHT - 100; decorate(); };
    const drawStyled = (runs: InlineRun[], lines: string[], x: number, baseline: number, size: number, leading: number) => {
      const text = runs.map(run => run.text).join(''); let cursor = 0;
      for (const line of lines) {
        const start = text.indexOf(line, cursor), end = start + line.length; let offset = 0, position = x;
        for (const run of runs) {
          const a = Math.max(start, offset), b = Math.min(end, offset + run.text.length);
          if (b > a) {
            const fragment = run.text.slice(a - offset, b - offset);
            const face = run.code && [...fragment].every(char => monoChars.has(char.codePointAt(0)!)) ? monospace : font;
            const width = face.widthOfTextAtSize(fragment, size);
            if (run.highlight || run.code) page.drawRectangle({ x: position, y: baseline - size * .22, width, height: size * 1.2,
              color: run.highlight ? rgb(1, .94, .43) : rgb(.94, .94, .94) });
            page.drawText(fragment, { x: position, y: baseline, size, font: face, ySkew: degrees(run.italic ? 12 : 0) });
            if (run.bold) page.drawText(fragment, { x: position + .35, y: baseline, size, font: face, ySkew: degrees(run.italic ? 12 : 0) });
            position += width;
          }
          offset += run.text.length;
        }
        cursor = end; baseline -= leading;
      }
    };
    try {
      decorate();
      const sources = sourceLines(markdown);
      let fence: string | undefined;
      for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
        const source = sources[sourceIndex];
        const raw = source.markdown.replace(/\r?\n$/, '').replace(/\t/g, '    ');
        const mapSource = () => { const id = `b${blocks.length + 1}`; blocks.push({ ...source, id, page: doc.getPageCount() }); return id; };
        const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(raw);
        if (fenceMatch && (!fence || fenceMatch[1][0] === fence[0])) { mapSource(); fence = fence ? undefined : fenceMatch[1]; y -= 7; continue; }
        if (!fence && sourceIndex + 1 < sources.length && raw.includes('|') && tableDelimiter(sources[sourceIndex + 1].markdown.trim())) {
          const columns = tableCells(raw).length;
          if (columns > 8) throw new Error('Tables with more than eight columns cannot fit the tablet text area.');
          const cellWidth = 460 / columns;
          let rowIndex = sourceIndex;
          while (rowIndex < sources.length) {
            const row = sources[rowIndex], rowRaw = row.markdown.replace(/\r?\n$/, '');
            if (rowIndex === sourceIndex + 1) {
              blocks.push({ ...row, id: `b${blocks.length + 1}`, page: doc.getPageCount() }); rowIndex++; continue;
            }
            if (!rowRaw.includes('|') || !rowRaw.trim() || tableCells(rowRaw).length !== columns) break;
            const header = rowIndex === sourceIndex;
            const cells = tableCells(rowRaw).map(text => inlineRuns(text, { bold: header }));
            const wrapped = cells.map(runs => wrap(runs.map(r => r.text).join(''), font, 22, cellWidth - 14));
            const rowHeight = Math.max(...wrapped.map(lines => lines.length)) * 38 + 14;
            if (rowHeight > 750) throw new Error('A table row is too tall to fit on one page.');
            if (y - rowHeight < 60) next();
            const id = `b${blocks.length + 1}`;
            blocks.push({ ...row, id, page: doc.getPageCount() });
            page.drawText(id, { x: 10, y: y - 13, size: 6, font, color: rgb(.6, .6, .6) });
            for (let column = 0; column < columns; column++) {
              const x = 40 + column * cellWidth;
              page.drawRectangle({ x, y: y - rowHeight, width: cellWidth, height: rowHeight, borderWidth: .5,
                borderColor: rgb(.65, .65, .65), color: header ? rgb(.94, .95, .96) : rgb(1, 1, 1) });
              drawStyled(cells[column], wrapped[column], x + 7, y - 30, 22, 38);
            }
            y -= rowHeight; rowIndex++;
          }
          sourceIndex = rowIndex - 1; y -= 14; continue;
        }
        if (!fence && /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {
          if (y < 80) next(); mapSource(); page.drawLine({ start: { x: 40, y }, end: { x: 500, y }, color: rgb(.7, .7, .7), thickness: .7 }); y -= 22; continue;
        }
        if (!raw.trim()) { mapSource(); y -= fence ? 18 : 12; continue; }
        const drawing = !fence ? /^!\[\[(reMarkable Attachments\/[a-f0-9]{64}\.png)\]\]$/.exec(raw.trim()) : null;
        if (drawing) {
          if (!this.options.resolveImage) throw new Error(`Cannot resolve drawing attachment: ${drawing[1]}`);
          let imageBytes: Uint8Array;
          try { imageBytes = await this.options.resolveImage(drawing[1]); }
          catch { throw new Error(`Drawing attachment is missing or unreadable: ${drawing[1]}`); }
          if (!imageBytes.length || imageBytes.length > 16_000_000) throw new Error(`Invalid drawing attachment size: ${drawing[1]}`);
          if (imageBytes.length < 24 || Buffer.from(imageBytes.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a')
            throw new Error(`Drawing attachment is not a PNG: ${drawing[1]}`);
          const header = new DataView(imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength);
          const imageWidth = header.getUint32(16), imageHeight = header.getUint32(20);
          if (!imageWidth || !imageHeight || imageWidth * imageHeight > 16_000_000) throw new Error('Drawing attachment dimensions exceed rendering limits.');
          const drawingImage = await doc.embedPng(imageBytes);
          if (drawingImage.width * drawingImage.height > 16_000_000) throw new Error('Drawing attachment dimensions exceed rendering limits.');
          const scale = Math.min(460 / drawingImage.width, 650 / drawingImage.height, 1);
          const width = drawingImage.width * scale, height = drawingImage.height * scale;
          if (y - height - 16 < 60) next();
          const id = `b${blocks.length + 1}`;
          blocks.push({ ...source, id, page: doc.getPageCount() });
          page.drawText(id, { x: 10, y: y + 1, size: 6, font, color: rgb(.6, .6, .6) });
          page.drawImage(drawingImage, { x: 40, y: y - height, width, height });
          y -= height + 16;
          continue;
        }
        const heading = !fence ? /^(#{1,6})\s+/.exec(raw) : null;
        const list = !fence ? /^(\s*)([-+*]|\d+[.)])\s+(?:\[([ xX])\]\s+)?/.exec(raw) : null;
        const quote = !fence ? /^\s*>\s?/.exec(raw) : null;
        const size = fence ? 20 : heading ? Math.max(26, 40 - heading[1].length * 4) : 24;
        const prefix = heading?.[0] ?? list?.[0] ?? quote?.[0] ?? '';
        const runs = fence ? [{ text: raw, code: true }] : inlineRuns(raw.slice(prefix.length), { bold: !!heading });
        const text = runs.map(run => run.text).join('');
        const indent = list ? Math.min(80, list[1].length * 6) + 36 : quote ? 20 : 0;
        const lines = wrap(text, fence ? monospace : font, size, 460 - indent);
        const lineHeight = fence ? 36 : heading ? 56 : 46;
        const height = lines.length * lineHeight + 10;
        if (height > HEIGHT - 170) throw new Error('A single Markdown line is too long to map safely. Split it into paragraphs.');
        if (y - height < 60) next();
        const id = `b${blocks.length + 1}`;
        blocks.push({ ...source, id, page: doc.getPageCount() });
        if (text.trim()) page.drawText(id, { x: 10, y: y + 1, size: 6, font, color: rgb(.6, .6, .6) });
        if (list) {
          const markerX = 40 + indent - 36;
          if (list[3] !== undefined) {
            page.drawRectangle({ x: markerX, y: y - 1, width: 9, height: 9, borderWidth: .8, borderColor: rgb(.2, .2, .2) });
            if (list[3].toLowerCase() === 'x') {
              page.drawLine({ start: { x: markerX + 1, y: y + 3 }, end: { x: markerX + 4, y }, thickness: 1 });
              page.drawLine({ start: { x: markerX + 4, y }, end: { x: markerX + 9, y: y + 8 }, thickness: 1 });
            }
          } else if (/\d/.test(list[2])) page.drawText(list[2], { x: markerX, y, size, font });
          else page.drawCircle({ x: markerX + 4, y: y + 4, size: 2, color: rgb(.15, .15, .15) });
        }
        if (quote) page.drawLine({ start: { x: 43, y: y + 13 }, end: { x: 43, y: y - (lines.length - 1) * lineHeight - 5 }, color: rgb(.65, .65, .65), thickness: 2 });
        drawStyled(runs, lines, 40 + indent, y, size, lineHeight);
        y -= lines.length * lineHeight + (fence ? 3 : 10);
      }
      const id = 'append';
      blocks.push({ id, start: markdown.length, end: markdown.length, markdown: '', page: doc.getPageCount() });
    } catch (error) {
      throw new Error(`Could not render Daily Note without losing text: ${(error as Error).message}`);
    }
    return { pdf: await doc.save(), blocks, pageCount: doc.getPageCount() };
  }

  async images(archive: Uint8Array, originalPdf: Uint8Array): Promise<PageImage[]> {
    if (typeof document === 'undefined') throw new Error('Tablet rendering requires the Obsidian desktop canvas.');
    const worker = createPdfWorker();
    let pdf: pdfjs.PDFDocumentProxy | undefined;
    try {
      await worker.promise;
      // fs.readFile returns a Buffer: Buffer.slice() SHARES its ArrayBuffer.
      // PDF.js transfers/detaches that buffer in Electron. Give it an owned
      // Uint8Array so the baseline remains intact for the integrity comparison.
      pdf = await pdfjs.getDocument({ data: new Uint8Array(originalPdf), worker, isEvalSupported: false, useSystemFonts: true }).promise;
      const mapped = archivePages(archive, pdf.numPages, originalPdf);
      const pdfHash = hash(originalPdf);
      const result: PageImage[] = [];
      for (const entry of mapped) {
        // Validate the archive above before considering reuse: page mappings
        // and the published PDF must still match, even on a complete hit.
        const cacheKey = `${pdfHash}:${entry.page}:${entry.ink?.length ? hash(entry.ink) : 'no-ink'}`;
        const cached = this.cachedPage(cacheKey);
        if (cached) { result.push(cached); continue; }
        const page = await pdf.getPage(entry.page + 1);
        const pageSize = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 1404 / pageSize.width });
        let canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
        let context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas is unavailable.');
        await page.render({ canvasContext: context, viewport }).promise;
        let svg = '';
        if (entry.ink?.length) svg = handwritingSvg(entry.ink, { width: pageSize.width, height: pageSize.height, scale: viewport.scale });
        if (svg) {
          const [x, y, w, h] = /viewBox="([^"]+)"/.exec(svg)![1].split(/\s+/).map(Number);
          const width = Math.round(w * viewport.scale), height = Math.round(h * viewport.scale);
          if (width !== canvas.width || height !== canvas.height) {
            const padded = document.createElement('canvas'); padded.width = width; padded.height = height;
            const target = padded.getContext('2d'); if (!target) throw new Error('Canvas is unavailable.');
            target.fillStyle = '#fff'; target.fillRect(0, 0, width, height);
            target.drawImage(canvas, Math.round((-pageSize.width / 2 - x) * viewport.scale), Math.round(-y * viewport.scale));
            canvas.width = 0; canvas.height = 0; canvas = padded; context = target;
          }
        }
        const base = canvas.toDataURL('image/png').split(',')[1];
        const basePixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        if (entry.ink?.length) {
          const blob = new Blob([svg], { type: 'image/svg+xml' });
          const url = URL.createObjectURL(blob);
          try {
            const ink = new Image();
            await new Promise<void>((resolve, reject) => { ink.onload = () => resolve(); ink.onerror = () => reject(new Error('Handwriting SVG could not be rendered.')); ink.src = url; });
            context.drawImage(ink, 0, 0, canvas.width, canvas.height);
          } finally { URL.revokeObjectURL(url); }
        }
        const changeCanvas = document.createElement('canvas'); changeCanvas.width = canvas.width; changeCanvas.height = canvas.height;
        let changes: string;
        try {
          const changeContext = changeCanvas.getContext('2d'); if (!changeContext) throw new Error('Canvas is unavailable.');
          const updated = context.getImageData(0, 0, canvas.width, canvas.height).data;
          const mask = changeContext.createImageData(canvas.width, canvas.height); mask.data.fill(255);
          for (let i = 0; i < updated.length; i += 4) if (pixelChanged(basePixels, updated, i)) {
            mask.data[i] = updated[i]; mask.data[i + 1] = updated[i + 1]; mask.data[i + 2] = updated[i + 2];
          }
          changeContext.putImageData(mask, 0, 0); changes = changeCanvas.toDataURL('image/png').split(',')[1];
        } finally { changeCanvas.width = 0; changeCanvas.height = 0; }
        const image: PageImage = { page: entry.page + 1, base, annotated: canvas.toDataURL('image/png').split(',')[1], inkHash: hash(svg), changes };
        this.rememberPage(cacheKey, image); result.push(image);
        canvas.width = 0; canvas.height = 0;
        page.cleanup();
      }
      // Include blank pages: a previously handwritten page may have been erased.
      return result;
    } finally { await pdf?.destroy(); worker.destroy(); }
  }
}
