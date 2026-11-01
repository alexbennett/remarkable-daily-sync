import { PDFDocument } from 'pdf-lib';
import type { NotebookMapping, Renderer, SourceBlock } from './contracts';

/** Vault-relative folders match direct Markdown children only. */
export interface NotebookInput { id: string; path: string; markdown: string; date?: string; }
export interface NotebookEntryManifest {
  noteId: string; path: string; title: string; baseline: string;
  firstPage: number; lastPage: number;
  /** Pages are notebook-global, character offsets are local to baseline. */
  blocks: SourceBlock[];
}
export interface NotebookManifest { mappingId: string; entries: NotebookEntryManifest[]; pageCount: number; }

export function notebookPath(path: string): string {
  if (typeof path !== 'string' || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Notebook paths must be text without control characters.');
  const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
  if (/^[\/\\]/.test(path) || /[:*?"<>|]/.test(normalized) || normalized.split('/').some(part => /[. ]$/.test(part) || (!part && normalized !== '')))
    throw new Error('Notebook paths must be vault-relative paths without empty or traversal segments.');
  return normalized;
}
export function notebookTitle(path: string): string {
  const name = notebookPath(path).split('/').pop()!;
  if (!/\.md$/i.test(name)) throw new Error('Notebook entries must be Markdown files.');
  return name.slice(0, -3);
}
export const normalizeNotebookFolder = notebookPath;
export function validateNotebookMappings(mappings: NotebookMapping[]): void {
  if (!Array.isArray(mappings)) throw new Error('Notebook mappings must be an array.');
  const ids = new Set<string>(), folders = new Set<string>(), titles = new Set<string>();
  for (const mapping of mappings) {
    if (!mapping || typeof mapping.id !== 'string' || typeof mapping.title !== 'string' || typeof mapping.enabled !== 'boolean') throw new Error('Invalid notebook mapping.');
    const folder = notebookPath(mapping.folder).toLowerCase(), title = mapping.title.trim().toLowerCase();
    if (!mapping.id.trim() || /[\x00-\x1f\x7f]/.test(mapping.id) || !title || /[\/\\\x00-\x1f\x7f]/.test(mapping.title)) throw new Error('Notebook mappings require an ID and a nonempty title without slashes or control characters.');
    if (ids.has(mapping.id) || folders.has(folder) || titles.has(title)) throw new Error('Notebook mappings have duplicate IDs, folders, or tablet titles.');
    ids.add(mapping.id); folders.add(folder); titles.add(title);
  }
}
const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function dailyDate(note: NotebookInput): string | undefined {
  const value = note.date ?? notebookTitle(note.path);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
}
export function mappingForFile(mappings: NotebookMapping[], path: string): NotebookMapping | undefined {
  validateNotebookMappings(mappings);
  const normalized = notebookPath(path), slash = normalized.lastIndexOf('/');
  if (!/\.md$/i.test(normalized)) return undefined;
  const folder = slash < 0 ? '' : normalized.slice(0, slash);
  // Paused mappings still own their folder: callers must not fall back to a
  // different publishing mode while this notebook is disabled.
  return mappings.find(mapping => notebookPath(mapping.folder).toLowerCase() === folder.toLowerCase());
}
export function selectNotebookEntries(mapping: NotebookMapping, notes: NotebookInput[], options: {daily?: boolean} = {}): NotebookInput[] {
  validateNotebookMappings([mapping]);
  if (!mapping.enabled) return [];
  const folder = notebookPath(mapping.folder).toLowerCase();
  const selected = notes.filter(note => {
    const path = notebookPath(note.path), slash = path.lastIndexOf('/');
    return /\.md$/i.test(path) && (slash < 0 ? '' : path.slice(0, slash).toLowerCase()) === folder;
  });
  validateEntries(selected);
  return selected.slice().sort((a, b) => {
    if (options.daily) {
      const ad = dailyDate(a), bd = dailyDate(b);
      if (ad && bd) return lexical(ad, bd) || lexical(a.path, b.path);
      if (ad || bd) return ad ? -1 : 1;
    }
    return natural.compare(notebookTitle(a.path), notebookTitle(b.path)) || lexical(a.path, b.path);
  });
}
function validateEntries(notes: NotebookInput[]): void {
  const ids = new Set<string>(), paths = new Set<string>(), titles = new Set<string>();
  for (const note of notes) {
    const path = notebookPath(note.path).toLowerCase(), title = notebookTitle(note.path).toLowerCase();
    if (!note.id || !title || ids.has(note.id) || paths.has(path) || titles.has(title)) throw new Error('Notebook entries have missing identities or duplicate IDs, paths, or titles.');
    ids.add(note.id); paths.add(path); titles.add(title);
  }
}

/** Input order is explicit. Rendering each entry separately guarantees a new page,
 * without injecting writing pages or altering per-note Markdown source offsets. */
export async function renderNotebook(renderer: Pick<Renderer, 'render'>, mappingId: string, orderedEntries: NotebookInput[]): Promise<{pdf: Uint8Array; manifest: NotebookManifest}> {
  if (!mappingId || !orderedEntries.length) throw new Error('Cannot render an empty notebook.');
  validateEntries(orderedEntries);
  const pdf = await PDFDocument.create();
  pdf.setCreationDate(new Date('2000-01-01T00:00:00Z'));
  pdf.setModificationDate(new Date('2000-01-01T00:00:00Z'));
  pdf.setCreator('Obsidian Daily Notes Sync');
  const entries: NotebookEntryManifest[] = [];
  for (const note of orderedEntries) {
    const title = notebookTitle(note.path), rendered = await renderer.render(note.markdown, title);
    const source = await PDFDocument.load(rendered.pdf, { updateMetadata: false });
    const count = source.getPageCount(), offset = pdf.getPageCount();
    if (!count || count !== rendered.pageCount || offset + count > 256) throw new Error('Invalid notebook PDF page count or notebook exceeds 256 pages.');
    for (const block of rendered.blocks) {
      if (!Number.isInteger(block.page) || block.page < 1 || block.page > count || !Number.isInteger(block.start) || !Number.isInteger(block.end) || block.start < 0 || block.end < block.start || block.end > note.markdown.length || note.markdown.slice(block.start, block.end) !== block.markdown)
        throw new Error('Renderer returned an invalid notebook source block.');
    }
    for (const page of await pdf.copyPages(source, source.getPageIndices())) pdf.addPage(page);
    entries.push({ noteId: note.id, path: notebookPath(note.path), title, baseline: note.markdown,
      firstPage: offset + 1, lastPage: offset + count,
      blocks: rendered.blocks.map(block => ({ ...block, page: block.page + offset })) });
  }
  return { pdf: await pdf.save({ addDefaultPage: false }), manifest: { mappingId, entries, pageCount: pdf.getPageCount() } };
}

/** Existing page assignments never move when an earlier-sorting file appears. */
export function newlyDiscoveredEntries(manifest: NotebookManifest, orderedEntries: NotebookInput[]): NotebookInput[] {
  validateEntries(orderedEntries);
  const existing = new Set(manifest.entries.map(entry => entry.noteId));
  return orderedEntries.filter(entry => !existing.has(entry.id));
}
export function routeNotebookPage(manifest: NotebookManifest, page: number): NotebookEntryManifest | undefined {
  if (!Number.isInteger(page) || page < 1 || page > manifest.pageCount) return undefined;
  validateManifest(manifest);
  const matches = manifest.entries.filter(entry => page >= entry.firstPage && page <= entry.lastPage);
  if (matches.length > 1) throw new Error('Notebook page routes overlap.');
  return matches[0];
}

/** Apply only after the transport verifies that these pages were appended. */
export function appendNotebookManifest(existing: NotebookManifest, addition: NotebookManifest): NotebookManifest {
  validateManifest(existing); validateManifest(addition);
  if (existing.mappingId !== addition.mappingId) throw new Error('Cannot combine different notebook mappings.');
  if (existing.pageCount + addition.pageCount > 256) throw new Error('Notebook exceeds 256 pages.');
  const ids = new Set(existing.entries.map(entry => entry.noteId));
  if (addition.entries.some(entry => ids.has(entry.noteId))) throw new Error('A notebook entry was already published.');
  const offset = existing.pageCount;
  return { mappingId: existing.mappingId, pageCount: offset + addition.pageCount,
    entries: [...existing.entries.map(entry => ({ ...entry, blocks: entry.blocks.map(block => ({ ...block })) })),
      ...addition.entries.map(entry => ({ ...entry, firstPage: entry.firstPage + offset, lastPage: entry.lastPage + offset,
        blocks: entry.blocks.map(block => ({ ...block, page: block.page + offset })) }))] };
}

function validateManifest(manifest: NotebookManifest): void {
  if (!manifest || !manifest.mappingId || !Number.isInteger(manifest.pageCount) || manifest.pageCount < 1 || manifest.pageCount > 256 || !Array.isArray(manifest.entries))
    throw new Error('Invalid notebook page manifest.');
  const ids = new Set<string>();
  let next = 1;
  for (const entry of manifest.entries) {
    if (!entry || !entry.noteId || ids.has(entry.noteId) || entry.firstPage !== next || !Number.isInteger(entry.lastPage) || entry.lastPage < next || entry.lastPage > manifest.pageCount || !Array.isArray(entry.blocks) || typeof entry.baseline !== 'string')
      throw new Error('Notebook page routes have invalid, overlapping, or missing ranges.');
    ids.add(entry.noteId);
    for (const block of entry.blocks) {
      if (!Number.isInteger(block.page) || block.page < entry.firstPage || block.page > entry.lastPage || !Number.isInteger(block.start) || !Number.isInteger(block.end) || block.start < 0 || block.end < block.start || block.end > entry.baseline.length || entry.baseline.slice(block.start, block.end) !== block.markdown)
        throw new Error('Notebook source blocks do not match their page route.');
    }
    next = entry.lastPage + 1;
  }
  if (next !== manifest.pageCount + 1) throw new Error('Notebook page routes leave unassigned pages.');
}
