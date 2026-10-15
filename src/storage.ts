import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SyncState } from './contracts';

export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const freshState = (): SyncState => ({ version: 1, notes: {}, reviews: [] });

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
    const state = JSON.parse(source) as SyncState;
    if (state.version !== 1 || !state.notes || !Array.isArray(state.reviews)) throw new Error('Unknown sync state; restore state.json from a backup before syncing.');
    return state;
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
