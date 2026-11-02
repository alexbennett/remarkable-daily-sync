import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { strFromU8, strToU8, unzipSync } from 'fflate';

export interface CPagesUpdateOptions { pageIds: string[]; processedInkFiles: string[]; }
export interface PreparedCPagesUpdate {
  pdf: Uint8Array; content: Uint8Array; deleteFiles: string[];
  /** The refreshed entry only. Physical PDF page numbers are one-based. */
  pages: Array<{pageId: string; pdfPage: number}>;
  oldPageCount: number; addedPageCount: number;
}
const LIMIT = 80 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const object = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
function identity(value: string): string {
  const bytes = createHash('sha1').update(Buffer.from('916ffedb6fa35446bfc6e83977db2490','hex')).update(value).digest().subarray(0,16);
  bytes[6] = bytes[6] & 15 | 80; bytes[8] = bytes[8] & 63 | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function fail(detail: string): never { throw new Error(`Experimental cPages update refused: ${detail}`); }

/** EXPERIMENTAL: register clocks and sequential ordering are reverse-engineered
 * hypotheses, not a hardware compatibility guarantee. Transport must separately
 * authorize the exact disposable document and CAS the original archive.
 * Existing physical backgrounds/other page records remain untouched. */
export async function prepareCPagesUpdate(archive: Uint8Array, newPdf: Uint8Array, options: CPagesUpdateOptions): Promise<PreparedCPagesUpdate> {
  if (!archive.length || archive.length > LIMIT || !newPdf.length || newPdf.length > LIMIT) fail('empty or oversized input');
  if (!options || !Array.isArray(options.pageIds) || !Array.isArray(options.processedInkFiles) || options.pageIds.some(id=>typeof id !== 'string' || !UUID.test(id)) || new Set(options.pageIds).size !== options.pageIds.length || new Set(options.processedInkFiles).size !== options.processedInkFiles.length) fail('invalid selected page or processed ink list');
  let expanded = 0;
  const names = new Set<string>();
  const files = unzipSync(archive, { filter: entry => {
    if (names.has(entry.name) || entry.name.startsWith('/') || /[\\\x00-\x1f:]/.test(entry.name) || entry.name.split('/').some(p=>p==='..'||p==='.'||!p)) fail('unsafe or duplicate archive member');
    names.add(entry.name); expanded += entry.originalSize;
    if (entry.originalSize > LIMIT || expanded > 2 * LIMIT) fail('archive expansion limit');
    return entry.name.endsWith('.pdf') || entry.name.endsWith('.content');
  }});
  const pdfNames = Object.keys(files).filter(name=>name.endsWith('.pdf'));
  const contentNames = Object.keys(files).filter(name=>name.endsWith('.content'));
  if (pdfNames.length !== 1 || contentNames.length !== 1 || pdfNames[0].includes('/') || pdfNames[0].slice(0,-4) !== contentNames[0].slice(0,-8)) fail('requires exactly one matching PDF/content pair');
  const documentId = pdfNames[0].slice(0,-4);
  if (!UUID.test(documentId)) fail('invalid document UUID');
  const content = JSON.parse(strFromU8(files[contentNames[0]]));
  if (object(content) && content.fileType === 'pdf' && (content.formatVersion === undefined || content.formatVersion === 1) && content.cPages === undefined)
    return prepareLegacyUpdate(archive,newPdf,options,content,files[pdfNames[0]],documentId,names);
  if (!object(content) || content.fileType !== 'pdf' || content.formatVersion !== 2 || !object(content.cPages)) fail('requires a tablet-initialized format-2 PDF');
  if ((content.pages != null && (!Array.isArray(content.pages) || content.pages.length)) || (content.redirectionPageMap != null && (!Array.isArray(content.redirectionPageMap) || content.redirectionPageMap.length))) fail('conflicting legacy page map');
  const cp = content.cPages;
  if (!Array.isArray(cp.pages) || !cp.pages.length || cp.pages.length > 256 || !Array.isArray(cp.uuids) || !cp.uuids.length || !object(cp.original)) fail('missing cPages registry or original count');
  const original = await PDFDocument.load(files[pdfNames[0]],{updateMetadata:false});
  const additional = await PDFDocument.load(newPdf,{updateMetadata:false});
  const oldPageCount = original.getPageCount(), addedPageCount = additional.getPageCount();
  if (!oldPageCount || !addedPageCount || oldPageCount + addedPageCount > 256 || cp.original.value !== oldPageCount || (content.originalPageCount !== undefined && content.originalPageCount !== oldPageCount)) fail('physical PDF count mismatch or limit');
  const actors = new Set<number>(), actorUUIDs = new Set<string>();
  for (const registry of cp.uuids) {
    if (!object(registry) || typeof registry.first !== 'string' || !UUID.test(registry.first) || !Number.isSafeInteger(registry.second) || registry.second < 1 || registry.second >= 65535 || actors.has(registry.second) || actorUUIDs.has(registry.first.toLowerCase())) fail('invalid actor registry');
    actors.add(registry.second); actorUUIDs.add(registry.first.toLowerCase());
  }
  let clock = 0;
  const inspectClocks = (value: any, depth = 0): void => {
    if (depth > 32) fail('metadata too deeply nested');
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'timestamp') {
        if (typeof child !== 'string' || !/^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.test(child)) fail('unknown timestamp encoding');
        const [actor, counter] = child.split(':').map(Number);
        if (!Number.isSafeInteger(counter) || counter >= Number.MAX_SAFE_INTEGER - 1 || !Number.isSafeInteger(actor) || (actor === 0 ? counter !== 0 : !actors.has(actor))) fail('unregistered or invalid timestamp');
        clock = Math.max(clock,counter);
      } else inspectClocks(child,depth+1);
    }
  };
  inspectClocks(cp);
  if (typeof cp.original.timestamp !== 'string') fail('original count lacks clock');
  const ids = new Set<string>(), keys = new Set<string>();
  for (const page of cp.pages) {
    if (!object(page) || typeof page.id !== 'string' || !UUID.test(page.id) || ids.has(page.id) || !object(page.idx) || typeof page.idx.timestamp !== 'string' || typeof page.idx.value !== 'string' || !/^[a-z]{1,64}$/.test(page.idx.value) || keys.has(page.idx.value) || (page.redir != null && (!object(page.redir) || typeof page.redir.timestamp !== 'string' || !Number.isInteger(page.redir.value) || page.redir.value < -1 || page.redir.value >= oldPageCount)) || (page.deleted !== undefined && (!object(page.deleted) || typeof page.deleted.timestamp !== 'string' || ![0,1].includes(page.deleted.value)))) fail('unsupported page record, ordering key, or redirect');
    ids.add(page.id); keys.add(page.idx.value);
  }
  const active = cp.pages.filter((page:any)=>page.deleted?.value !== 1).slice().sort((a:any,b:any)=>a.idx.value < b.idx.value ? -1:1);
  if (!active.length || active.length !== content.pageCount) fail('logical page count mismatch');
  const selected = options.pageIds.map(id=>active.find((page:any)=>page.id===id));
  if (selected.some(page=>!page)) fail('selected page is missing or deleted');
  if (selected.some(page=>!object(page.redir) || page.redir.value < 0)) fail('selected native blank pages cannot be redirected');
  const firstIndex = selected.length ? active.indexOf(selected[0]) : active.length;
  if (selected.some((page,index)=>active[firstIndex+index] !== page)) fail('selected pages are not a contiguous ordered entry');
  const growth = Math.max(0,addedPageCount-selected.length);
  if (cp.pages.length + growth > 256) fail('logical record limit');
  const permittedInk = new Set(options.pageIds.map(id=>`${documentId}/${id}.rm`));
  for (const file of options.processedInkFiles) if (typeof file !== 'string' || !permittedInk.has(file) || !names.has(file)) fail('processed ink is not an existing selected page member');
  for (const file of permittedInk) if (names.has(file) && !options.processedInkFiles.includes(file)) fail('selected page has handwriting not explicitly marked processed');
  const actorUUID = identity(`cPages-experimental-actor:${documentId}`);
  let registry = cp.uuids.find((actor:any)=>actor.first.toLowerCase() === actorUUID);
  if (!registry) {
    const actorNumber = Math.max(...actors)+1;
    if (actorNumber >= 65535) fail('actor registry exhausted');
    registry = {first:actorUUID,second:actorNumber}; cp.uuids.push(registry);
  }
  const timestamp = `${registry.second}:${clock+1}`;
  const pages: PreparedCPagesUpdate['pages'] = [];
  let leftKey: string = selected.length ? selected.at(-1).idx.value : [...keys].sort().at(-1)!;
  // Real tablet insertion observed ba < bab < bb. Restrict interpolation to
  // that alphabetic suffix pattern; this remains experimental, not a general
  // implementation of the tablet's unknown fractional-index algorithm.
  const rightKey = [...keys].sort().find(key=>key > leftKey);
  const nextKey = (): string => {
    if (!rightKey && /^[a-z]{2}$/.test(leftKey)) {
      const next = (leftKey.charCodeAt(0)-97)*26 + leftKey.charCodeAt(1)-97 + 1;
      if (next < 676) return String.fromCharCode(97+Math.floor(next/26),97+next%26);
    }
    for (let padding=''; leftKey.length+padding.length+1 <= 64; padding+='a') {
      const candidate = leftKey+padding+'b';
      if ((!rightKey || candidate < rightKey) && !keys.has(candidate)) return candidate;
    }
    return fail('no supported alphabetic ordering interval remains');
  };
  const operationHash = sha(archive)+':'+sha(newPdf)+':'+options.pageIds.join(',');
  for (let index=0;index<addedPageCount;index++) {
    let page = selected[index];
    if (page) page.redir = {...page.redir,timestamp,value:oldPageCount+index};
    else {
      const key = nextKey(); leftKey = key; keys.add(key);
      const id = identity(`cPages-page:${documentId}:${operationHash}:${index}`);
      if (ids.has(id)) fail('new page UUID collision');
      page = {id,idx:{timestamp,value:key},redir:{timestamp,value:oldPageCount+index},template:{timestamp,value:'Blank'}};
      cp.pages.push(page); ids.add(id);
    }
    pages.push({pageId:page.id,pdfPage:oldPageCount+index+1});
  }
  for (const page of selected.slice(addedPageCount)) page.deleted = {...page.deleted,timestamp,value:1};
  cp.original = {...cp.original,timestamp,value:oldPageCount+addedPageCount};
  content.pageCount = active.length-selected.length+addedPageCount;
  if (content.originalPageCount !== undefined) content.originalPageCount = oldPageCount+addedPageCount;
  for (const page of await original.copyPages(additional,additional.getPageIndices())) original.addPage(page);
  const pdf = await original.save({addDefaultPage:false});
  if (pdf.length > LIMIT) fail('resulting PDF exceeds limit');
  return {pdf,content:strToU8(JSON.stringify(content)),deleteFiles:[...options.processedInkFiles].sort(),pages,oldPageCount,addedPageCount};
}

/** Initialized legacy maps have no CRDT clocks. Keep their logical IDs stable
 * while appending backgrounds; never synthesize maps for an unvisited upload. */
async function prepareLegacyUpdate(archive:Uint8Array,newPdf:Uint8Array,options:CPagesUpdateOptions,content:Record<string,any>,oldPdf:Uint8Array,documentId:string,names:Set<string>):Promise<PreparedCPagesUpdate> {
  const ids = content.pages, redirects = content.redirectionPageMap;
  if (!Array.isArray(ids) || !ids.length || ids.length > 256 || !Array.isArray(redirects) || redirects.length !== ids.length || content.pageCount !== ids.length || ids.some(id=>typeof id !== 'string' || !UUID.test(id)) || new Set(ids).size !== ids.length)
    fail('requires initialized legacy page IDs and redirections');
  const original=await PDFDocument.load(oldPdf,{updateMetadata:false}), additional=await PDFDocument.load(newPdf,{updateMetadata:false});
  const oldPageCount=original.getPageCount(), addedPageCount=additional.getPageCount();
  if (!oldPageCount || !addedPageCount || oldPageCount+addedPageCount > 256 || content.originalPageCount !== oldPageCount || redirects.some(page=>!Number.isInteger(page) || page < -1 || page >= oldPageCount) || new Set(redirects.filter(page=>page>=0)).size !== redirects.filter(page=>page>=0).length)
    fail('legacy physical PDF count or redirect mismatch');
  const start=options.pageIds.length ? ids.indexOf(options.pageIds[0]) : ids.length;
  if (start < 0 || options.pageIds.some((id,index)=>ids[start+index] !== id)) fail('selected legacy pages are not a contiguous ordered entry');
  if (options.pageIds.some((_,index)=>redirects[start+index] < 0)) fail('selected native blank pages cannot be redirected');
  if (ids.length-options.pageIds.length+addedPageCount > 256) fail('logical record limit');
  const permittedInk=new Set(options.pageIds.map(id=>`${documentId}/${id}.rm`));
  for (const file of options.processedInkFiles) if (typeof file !== 'string' || !permittedInk.has(file) || !names.has(file)) fail('processed ink is not an existing selected page member');
  for (const file of permittedInk) if (names.has(file) && !options.processedInkFiles.includes(file)) fail('selected page has handwriting not explicitly marked processed');
  const operationHash=sha(archive)+':'+sha(newPdf)+':'+options.pageIds.join(',');
  const refreshedIds=Array.from({length:addedPageCount},(_,index)=>options.pageIds[index] ?? identity(`legacy-page:${documentId}:${operationHash}:${index}`));
  if (refreshedIds.slice(options.pageIds.length).some(id=>ids.includes(id)) || new Set(refreshedIds).size !== refreshedIds.length) fail('new page UUID collision');
  content.pages=[...ids.slice(0,start),...refreshedIds,...ids.slice(start+options.pageIds.length)];
  content.redirectionPageMap=[...redirects.slice(0,start),...refreshedIds.map((_,index)=>oldPageCount+index),...redirects.slice(start+options.pageIds.length)];
  content.pageCount=content.pages.length;content.originalPageCount=oldPageCount+addedPageCount;
  for (const page of await original.copyPages(additional,additional.getPageIndices())) original.addPage(page);
  const pdf=await original.save({addDefaultPage:false});if (pdf.length > LIMIT) fail('resulting PDF exceeds limit');
  return {pdf,content:strToU8(JSON.stringify(content)),deleteFiles:[...options.processedInkFiles].sort(),pages:refreshedIds.map((pageId,index)=>({pageId,pdfPage:oldPageCount+index+1})),oldPageCount,addedPageCount};
}

/** Format-dispatching name for new callers; historical export remains compatible. */
export const prepareNotebookUpdate = prepareCPagesUpdate;
