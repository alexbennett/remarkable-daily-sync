import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SyncState } from './contracts';

export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const freshState = (): SyncState => ({ version: 2, notes: {}, reviews: [], notebooks: {} });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function validateNotebooks(value: unknown): void {
  if (!isRecord(value)) throw new Error('Invalid notebook state; restore state.json from a backup before syncing.');
  for (const [key, notebook] of Object.entries(value)) {
    if (!isRecord(notebook) || notebook.id !== key || typeof notebook.mappingId !== 'string' || !notebook.mappingId ||
        !Number.isInteger(notebook.generation) || Number(notebook.generation) < 0 ||
        !Array.isArray(notebook.entryIds) || notebook.entryIds.some(id => typeof id !== 'string' || !id) || new Set(notebook.entryIds).size !== notebook.entryIds.length ||
        !['pending', 'validated'].includes(notebook.validation as string) ||
        (notebook.documentId !== undefined && (typeof notebook.documentId !== 'string' || !notebook.documentId)) ||
        (notebook.pendingReason !== undefined && typeof notebook.pendingReason !== 'string') || !Array.isArray(notebook.pages)) {
      throw new Error('Invalid notebook state; restore state.json from a backup before syncing.');
    }
    const pageIds = new Set<string>(), pdfPages = new Set<number>();
    for (const page of notebook.pages) {
      if (!isRecord(page) || typeof page.pageId !== 'string' || !page.pageId || typeof page.noteId !== 'string' || !page.noteId ||
          typeof page.revisionId !== 'string' || !page.revisionId || !Number.isInteger(page.pdfPage) || Number(page.pdfPage) < 1 ||
          pageIds.has(page.pageId) || pdfPages.has(Number(page.pdfPage))) throw new Error('Invalid notebook page manifest; restore state.json from a backup before syncing.');
      pageIds.add(page.pageId); pdfPages.add(Number(page.pdfPage));
    }
  }
}

/** Machine-local state is intentionally not placed in the synced vault. */
export class LocalStore {
  constructor(readonly directory: string) {}
  private resolve(name: string): string {
    const target = path.resolve(this.directory, name);
    if (!target.startsWith(path.resolve(this.directory) + path.sep)) throw new Error('Invalid local state path');
    return target;
  }
  async initialize(): Promise<void> { await fs.mkdir(this.directory, { recursive: true }); }
  async load(): Promise<SyncState> {
    await this.initialize();
    let source: string;
    try { source = await fs.readFile(this.resolve('state.json'), 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return freshState(); throw e; }
    const state: unknown = JSON.parse(source);
    if (!isRecord(state) || (state.version !== 1 && state.version !== 2) || !isRecord(state.notes) || !Array.isArray(state.reviews)) throw new Error('Unknown sync state; restore state.json from a backup before syncing.');
    if (state.version === 1) {
      // Save the exact original before changing the durable state. The hash makes
      // interrupted migrations repeatable without overwriting unrelated backups.
      await this.write(`backups/state-v1-${hash(source)}.json`, source);
      const migrated = { ...state, version: 2, notebooks: {} } as unknown as SyncState;
      await this.save(migrated);
      return migrated;
    }
    validateNotebooks(state.notebooks);
    return state as unknown as SyncState;
  }
  async save(state: SyncState): Promise<void> { await this.write('state.json', JSON.stringify(state, null, 2)); }
  async write(name: string, bytes: Uint8Array | string): Promise<string> {
    const target = this.resolve(name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, target);
    return name;
  }
  async read(name: string): Promise<Uint8Array> { return fs.readFile(this.resolve(name)); }
  async readText(name: string): Promise<string | null> {
    try { return await fs.readFile(this.resolve(name), 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  async remove(name: string): Promise<void> { await fs.rm(this.resolve(name), { force: true }); }
  assetPath(name: string): string { return this.resolve(name); }
  async backup(noteId: string, text: string): Promise<void> {
    await this.write(`backups/${noteId}/${Date.now()}-${hash(text).slice(0, 12)}.md`, text);
  }
}
