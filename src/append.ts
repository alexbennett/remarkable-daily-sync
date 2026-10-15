import { createHash } from 'node:crypto';
import { strFromU8, strToU8, unzipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';

export interface PreparedAppend {
  pdf: Uint8Array;
  content: Uint8Array;
  /** Number of existing physical PDF pages; newly copied pages start here. */
  oldPageCount: number;
  addedPageCount: number;
}

export class UnsupportedAppendFormatError extends Error {
  constructor() {
    super('This tablet PDF uses the newer cPages format. Handwriting imports continue, but updated layouts cannot be appended safely. Turn off history-page appending to publish a new PDF instead.');
    this.name = 'UnsupportedAppendFormatError';
  }
}

const MAX_BYTES = 80 * 1024 * 1024;
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

// Stable RFC 4122 UUIDv5 IDs mean retrying the same append produces exactly
// the same PDF/content payload rather than another set of page identities.
function pageId(baselineHash: string, appendHash: string, page: number): string {
  const namespace = Buffer.from('be5df3471b2d4df6bc2fd68283fbdab4', 'hex');
  const bytes = createHash('sha1').update(namespace).update(`${baselineHash}:${appendHash}:${page}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Prepare only the two replacement members. The caller must retain every
 * other archive entry, especially .rm handwriting, byte-for-byte. */
export async function prepareAppend(archive: Uint8Array, newPdf: Uint8Array): Promise<PreparedAppend> {
  if (!archive.length || archive.length > MAX_BYTES || !newPdf.length || newPdf.length > MAX_BYTES)
    throw new Error('Append input is empty or exceeds the 80 MB document limit.');
  let expanded = 0, hasInkMembers = false;
  const entries = unzipSync(archive, { filter: entry => {
    expanded += entry.originalSize;
    if (entry.name.endsWith('.rm')) hasInkMembers = true;
    if (entry.originalSize > MAX_BYTES || expanded > MAX_BYTES * 2) throw new Error('Tablet archive expands beyond the safe size limit.');
    return entry.name.endsWith('.pdf') || entry.name.endsWith('.content');
  } });
  const pdfNames = Object.keys(entries).filter(name => name.endsWith('.pdf'));
  const contentNames = Object.keys(entries).filter(name => name.endsWith('.content'));
  if (pdfNames.length !== 1 || contentNames.length !== 1 || pdfNames[0].slice(0, -4) !== contentNames[0].slice(0, -8))
    throw new Error('Append requires one matching PDF and content member in the tablet archive.');
  const content = JSON.parse(strFromU8(entries[contentNames[0]]));
  if (!content || typeof content !== 'object' || Array.isArray(content) || content.fileType !== 'pdf') throw new Error('Only PDF tablet documents support page append.');
  if (content.cPages !== undefined) throw new UnsupportedAppendFormatError();
  if (content.formatVersion !== undefined && content.formatVersion !== 1) throw new Error('Unsupported tablet content format for page append.');
  const originalPdf = entries[pdfNames[0]];
  // Loading the original document (rather than rebuilding it from copied old
  // pages) retains its page dictionaries, resource references and metadata.
  const original = await PDFDocument.load(originalPdf, { updateMetadata: false });
  const additional = await PDFDocument.load(newPdf, { updateMetadata: false });
  const oldPageCount = original.getPageCount(), addedPageCount = additional.getPageCount();
  if (!oldPageCount || !addedPageCount || oldPageCount + addedPageCount > 256)
    throw new Error('Page append requires nonempty PDFs with at most 256 combined pages.');
  const baselineHash = sha(originalPdf), appendHash = sha(newPdf);
  const empty = (value: unknown) => value === undefined || value === null || (Array.isArray(value) && value.length === 0);
  let ids: unknown[] = content.pages, redirects: unknown[] = content.redirectionPageMap;
  if (empty(ids) || empty(redirects)) {
    if (hasInkMembers || !empty(ids) || !empty(redirects))
      throw new Error('Append cannot initialize incomplete page mappings when handwriting or a conflicting partial map exists.');
    // Pinned rmapi's newly uploaded PDF has null maps, pageCount:0 and no
    // originalPageCount until the tablet opens it. Its embedded PDF is the
    // authority while no page identities or handwriting exist.
    const unvisitedUpload = content.originalPageCount === undefined && (content.pageCount === undefined || content.pageCount === 0);
    if (!unvisitedUpload && (content.pageCount === undefined ? content.originalPageCount !== oldPageCount : content.pageCount !== oldPageCount))
      throw new Error('Pristine tablet page count does not confirm the original PDF page count.');
    // Unvisited PDFs have no page identities yet. With no handwriting files,
    // deterministic IDs and identity redirects preserve every original page.
    ids = Array.from({ length: oldPageCount }, (_, index) => pageId(baselineHash, 'existing-page', index));
    redirects = Array.from({ length: oldPageCount }, (_, index) => index);
  } else if (content.pageCount !== oldPageCount) throw new Error('Initialized tablet page count does not match the original PDF.');
  if (!Array.isArray(ids) || !Array.isArray(redirects)) throw new Error('Append requires valid legacy page ID and redirection arrays.');
  if (ids.length !== oldPageCount || redirects.length !== oldPageCount || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !/^[\w-]+$/.test(id)) ||
      new Set(redirects).size !== oldPageCount || redirects.some(page => !Number.isInteger(page) || Number(page) < 0 || Number(page) >= oldPageCount) ||
      (content.pageCount !== undefined && content.pageCount !== 0 && content.pageCount !== oldPageCount) ||
      (content.originalPageCount !== undefined && content.originalPageCount !== oldPageCount))
    throw new Error('Tablet page mapping does not bijectively match the existing PDF; append was stopped.');
  const newIds = Array.from({ length: addedPageCount }, (_, index) => pageId(baselineHash, appendHash, oldPageCount + index));
  if (newIds.some(id => ids.includes(id))) throw new Error('Appended page identity collides with an existing page.');
  const copied = await original.copyPages(additional, additional.getPageIndices());
  for (const page of copied) original.addPage(page);
  const pdf = await original.save();
  if (pdf.length > MAX_BYTES) throw new Error('Appended PDF exceeds the 80 MB document limit.');
  content.pages = [...ids, ...newIds];
  content.redirectionPageMap = [...redirects, ...Array.from({ length: addedPageCount }, (_, index) => oldPageCount + index)];
  content.pageCount = oldPageCount + addedPageCount;
  content.originalPageCount = oldPageCount + addedPageCount;
  return { pdf, content: strToU8(JSON.stringify(content, null, 4)), oldPageCount, addedPageCount };
}
