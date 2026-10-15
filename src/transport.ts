import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { CloudDocument, DownloadedDocument, Transport } from './contracts';

export const RMAPI_COMMIT = 'aa60dac8a8dbb1b4eb6a25f2caf2f3daea573373';
export type CommandRunner = (binary: string, args: string[], options: {cwd: string; env: NodeJS.ProcessEnv}) => Promise<string>;
const runCommand: CommandRunner = (binary, args, options) => new Promise((resolve, reject) => {
  execFile(binary, args, { ...options, windowsHide: true, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    // Never include rmapi stderr: it can contain account information or tokens.
    if (error && /(?:status(?: code)?[ :]+|HTTP[ /])429\b/i.test(stderr)) reject(new CloudRateLimitError(Number(/retry after (\d+) seconds/i.exec(stderr)?.[1] ?? 60) * 1000));
    else if (error) reject(new Error(`rMAPI ${args.find(a => !a.startsWith('-')) ?? 'command'} failed (${error.code ?? 'timeout'}). The cloud request could not complete; background sync will retry. If this persists, use Check connections.`));
    else resolve(stdout);
  });
});
interface Node extends CloudDocument { type: string }
export class CloudRateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs = 60_000) {
    const delay = Number.isFinite(retryAfterMs) ? Math.max(60_000, retryAfterMs) : 60_000;
    super(`reMarkable cloud rate limit (HTTP 429). Retrying automatically in ${Math.ceil(delay / 1000)} seconds.`);
    this.name = 'CloudRateLimitError'; this.retryAfterMs = delay;
  }
}
export class AppendConflictError extends Error {
  constructor() { super('Tablet changed during append. Synchronize its latest handwriting before retrying.'); this.name = 'AppendConflictError'; }
}
function safeName(name: string): string {
  if (!name || name.length > 180 || /[\\/:*?"<>|\[\]\x00-\x1f]/.test(name) || name === '.' || name === '..' || /[. ]$/.test(name) || /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(name)) throw new Error('Unsafe reMarkable document or folder name.');
  return name;
}
function parseNodes(output: string): Node[] {
  let data: unknown;
  try { data = JSON.parse(output); } catch { throw new Error('rMAPI did not return valid JSON. Install the pinned build.'); }
  if (data === null) return [];
  if (!Array.isArray(data)) throw new Error('Unexpected rMAPI JSON.');
  const ids = new Set<string>();
  for (const n of data) {
    if (!n || typeof n.id !== 'string' || typeof n.name !== 'string' || typeof n.parent !== 'string' || typeof n.type !== 'string' || typeof n.version !== 'number' || typeof n.modifiedClient !== 'string' || ids.has(n.id)) throw new Error('Invalid or duplicate rMAPI metadata.');
    // Older helpers omit this field. Never substitute mutable version/timestamps.
    if (typeof n.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(n.contentHash)) delete n.contentHash;
    ids.add(n.id);
  }
  return data;
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function archiveDigests(bytes: Uint8Array): { fingerprint: string; contentHash: string } {
  if (bytes.length > 80 * 1024 * 1024) throw new Error('Tablet archive exceeds 80 MB limit.');
  let total = 0;
  const entries = unzipSync(bytes, { filter: entry => {
    total += entry.originalSize;
    if (entry.originalSize > 80 * 1024 * 1024 || total > 160 * 1024 * 1024) throw new Error('Tablet archive expands beyond the safe size limit.');
    return true;
  } });
  const hash = createHash('sha256');
  const cloudHash = createHash('sha256');
  const names = Object.keys(entries).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const name of names) {
    const entryHash = sha(entries[name]);
    hash.update(JSON.stringify([name, entryHash]) + '\n');
    // Exactly api/sync15.HashEntries: SHA256 over binary file hashes in filename order.
    cloudHash.update(Buffer.from(entryHash, 'hex'));
  }
  return { fingerprint: hash.digest('hex'), contentHash: cloudHash.digest('hex') };
}
export function archiveFingerprint(bytes: Uint8Array): string { return archiveDigests(bytes).fingerprint; }
export function archiveContentHash(bytes: Uint8Array): string { return archiveDigests(bytes).contentHash; }

/** No shell expansion; all cloud access is limited to one dedicated top-level folder. */
export class RmapiTransport implements Transport {
  private folder: string;
  private retryAfter = 0;
  private listedDocs?: CloudDocument[];
  private downloads = new Map<string, { contentHash: string; result: DownloadedDocument }>();
  private downloadBytes = 0;
  constructor(private binaryPath: string, private stateDir: string, cloudFolder: string, private runner: CommandRunner = runCommand, private downloadLimit = 64 * 1024 * 1024) {
    this.downloadLimit = Math.max(0, Math.min(64 * 1024 * 1024, Number.isFinite(downloadLimit) ? downloadLimit : 0));
    this.folder = safeName(cloudFolder.replace(/^\//, ''));
    if (!path.isAbsolute(binaryPath) || !path.isAbsolute(stateDir)) throw new Error('rMAPI binary and private state directory must be absolute paths.');
  }
  private async command(args: string[], cwd = this.stateDir): Promise<string> {
    if (Date.now() < this.retryAfter) throw new CloudRateLimitError(this.retryAfter - Date.now());
    await mkdir(cwd, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, RMAPI_CONFIG: path.join(this.stateDir, 'rmapi.conf'), LOCALAPPDATA: this.stateDir, XDG_CACHE_HOME: this.stateDir };
    delete env.RMAPI_TRACE;
    // Ignore inherited endpoint overrides, which could redirect authentication.
    delete env.RMAPI_HOST; delete env.RMAPI_AUTH; delete env.RMAPI_DOC;
    const operation = args.find(arg => !arg.startsWith('-'));
    if (!['ls', 'find', 'get', 'version'].includes(operation ?? '')) {
      this.listedDocs = undefined;
      // Invalidate before invocation: even failed mutations can have committed.
      this.downloads.clear(); this.downloadBytes = 0;
    }
    // Read operations are safe to retry after a transient helper/cloud failure.
    // Never automatically repeat a cloud mutation whose outcome is unknown.
    const attempts = ['ls', 'find'].includes(operation ?? '') ? 3 : 1;
    for (let attempt = 0; ; attempt++) {
      try { return await this.runner(this.binaryPath, ['-ni', ...args], { cwd, env }); }
      catch (error) {
        if (error instanceof CloudRateLimitError) { this.retryAfter = Date.now() + error.retryAfterMs; this.listedDocs = undefined; throw error; }
        if (attempt + 1 >= attempts) throw error;
        await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
  }
  private async root(create = false): Promise<Node | undefined> {
    const roots = parseNodes(await this.command(['-json', 'ls', '/']));
    const matches = roots.filter(n => n.name === this.folder);
    if (matches.length > 1 || (matches[0] && matches[0].type !== 'CollectionType')) throw new Error('Dedicated cloud folder is ambiguous or is a document.');
    if (!matches.length && create) {
      await this.command(['mkdir', '/' + this.folder]);
      return this.root(false);
    }
    return matches[0];
  }
  private async tree(): Promise<{root?: Node; nodes: Node[]}> {
    const root = await this.root();
    if (!root) return { nodes: [] };
    const nodes = parseNodes(await this.command(['-json', 'find', '/' + this.folder]));
    const permitted = new Set([root.id]);
    for (let i = 0; i <= nodes.length; i++) for (const n of nodes) if (permitted.has(n.parent)) permitted.add(n.id);
    if (nodes.some(n => !permitted.has(n.id))) throw new Error('Cloud listing escaped the dedicated folder.');
    return { root, nodes };
  }
  async list(): Promise<CloudDocument[]> {
    this.listedDocs = undefined;
    this.listedDocs = (await this.tree()).nodes.filter(n => n.type === 'DocumentType');
    for (const [id, cached] of this.downloads) {
      if (!this.listedDocs.some(doc => doc.id === id && doc.contentHash === cached.contentHash)) this.dropDownload(id);
    }
    return this.listedDocs;
  }
  private dropDownload(id: string): void {
    const cached = this.downloads.get(id);
    if (cached) this.downloadBytes -= cached.result.bytes.byteLength;
    this.downloads.delete(id);
  }
  private cacheDownload(id: string, contentHash: string, result: DownloadedDocument): void {
    this.dropDownload(id);
    if (result.bytes.byteLength > this.downloadLimit) return;
    while (this.downloadBytes + result.bytes.byteLength > this.downloadLimit && this.downloads.size) this.dropDownload(this.downloads.keys().next().value!);
    this.downloads.set(id, {contentHash, result: {bytes: new Uint8Array(result.bytes), fingerprint: result.fingerprint}});
    this.downloadBytes += result.bytes.byteLength;
  }
  async check(): Promise<string> {
    const version = (await this.command(['version'])).trim();
    if (!version.includes(RMAPI_COMMIT)) throw new Error('Install the pinned rMAPI build with scripts/setup-rmapi.ps1.');
    const root = await this.root();
    return root ? 'Cloud connected; dedicated folder found.' : 'Cloud connected; dedicated folder will be created on first upload.';
  }
  async download(id: string): Promise<DownloadedDocument> {
    const doc = (this.listedDocs ?? await this.list()).find(n => n.id === id);
    if (!doc) throw new Error('Document is outside the dedicated folder or no longer exists.');
    safeName(doc.name);
    const cached = this.downloads.get(id);
    if (doc.contentHash && cached?.contentHash === doc.contentHash) {
      this.downloads.delete(id); this.downloads.set(id, cached);
      return {bytes: new Uint8Array(cached.result.bytes), fingerprint: cached.result.fingerprint};
    }
    this.dropDownload(id);
    await mkdir(this.stateDir, { recursive: true });
    const dir = await mkdtemp(path.join(this.stateDir, 'download-'));
    try {
      await this.command(['get', '--id', id], dir);
      const files = await readdir(dir);
      if (files.length !== 1 || files[0] !== doc.name + '.rmdoc') throw new Error('Unexpected rMAPI download output.');
      const bytes = await readFile(path.join(dir, files[0]));
      const digests = archiveDigests(bytes);
      const result = { bytes, fingerprint: digests.fingerprint };
      // Download may race a newer cloud revision. Return it for normal merge,
      // but cache only when the ZIP proves it belongs to the listed full hash.
      if (doc.contentHash === digests.contentHash) this.cacheDownload(id, doc.contentHash, result);
      return result;
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  private async verifyPdf(doc: CloudDocument, pdf: Uint8Array): Promise<CloudDocument> {
    const entries = unzipSync((await this.download(doc.id)).bytes);
    const pdfs = Object.keys(entries).filter(n => n.endsWith('.pdf'));
    if (!pdfs.some(n => sha(entries[n]) === sha(pdf))) throw new Error('Uploaded revision PDF verification failed; original remains untouched.');
    return doc;
  }
  async upload(name: string, pdf: Uint8Array): Promise<CloudDocument> {
    safeName(name);
    const root = await this.root(true);
    if (!root) throw new Error('Cloud folder creation could not be verified.');
    const existing = (await this.list()).filter(n => n.name === name);
    if (existing.length > 1) throw new Error('Revision name is ambiguous.');
    if (existing.length) return this.verifyPdf(existing[0], pdf);
    const dir = await mkdtemp(path.join(this.stateDir, 'upload-'));
    try {
      const file = path.join(dir, name + '.pdf');
      await writeFile(file, pdf, { flag: 'wx' });
      // rMAPI derives the cloud title using Go path.Base (POSIX separators).
      // A Windows absolute path becomes the title, so pass a basename from cwd.
      await this.command(['put', name + '.pdf', '/' + this.folder], dir);
      const matches = (await this.list()).filter(n => n.name === name && n.parent === root.id);
      if (matches.length !== 1) throw new Error('Upload could not be verified; retry uses the same revision name.');
      return await this.verifyPdf(matches[0], pdf);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async append(id: string, expectedArchive: Uint8Array, pdf: Uint8Array, content: Uint8Array): Promise<void> {
    const {root, nodes} = await this.tree();
    if (!root || !nodes.some(n => n.id === id && n.parent === root.id && n.type === 'DocumentType')) throw new Error('Only an active managed document can receive appended pages.');
    archiveFingerprint(expectedArchive); // Validate compressed and expanded size limits.
    const expected = unzipSync(expectedArchive);
    if (!expected[`${id}.pdf`] || !expected[`${id}.content`]) throw new Error('Append baseline archive does not belong to the requested document.');
    const dir = await mkdtemp(path.join(this.stateDir, 'append-'));
    try {
      await writeFile(path.join(dir, 'expected.rmdoc'), expectedArchive, {flag: 'wx'});
      await writeFile(path.join(dir, 'combined.pdf'), pdf, {flag: 'wx'});
      await writeFile(path.join(dir, 'appended.content'), content, {flag: 'wx'});
      const output = await this.command(['append-pages', '--id', id, '--expected-archive', 'expected.rmdoc', '--pdf', 'combined.pdf', '--content', 'appended.content'], dir);
      if (output.split(/\r?\n/).includes('APPEND_CONFLICT')) throw new AppendConflictError();
      if (!output.split(/\r?\n/).includes('APPEND_OK')) throw new Error('Guarded append was not confirmed. Install the bundled append-enabled helper.');
      // A later ink upload is allowed; only verify our immutable PDF and newly
      // appended page IDs/maps, never overwrite newer annotations for recovery.
      const actual = unzipSync((await this.download(id)).bytes);
      if (!actual[`${id}.pdf`] || sha(actual[`${id}.pdf`]) !== sha(pdf)) throw new Error('Appended PDF could not be verified.');
      const wanted = JSON.parse(Buffer.from(content).toString('utf8'));
      const current = JSON.parse(Buffer.from(actual[`${id}.content`] ?? []).toString('utf8'));
      if (!appendMappingsPresent(wanted, current)) throw new Error('Appended page mappings could not be verified.');
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async rename(id: string, name: string): Promise<CloudDocument> {
    safeName(name);
    const {root, nodes} = await this.tree();
    const doc = nodes.find(n => n.id === id && n.type === 'DocumentType');
    if (!root || !doc) throw new Error('Cannot rename an unmanaged document.');
    safeName(doc.name);
    let parentPath = '/' + this.folder;
    if (doc.parent !== root.id) {
      const archives = nodes.filter(n => n.parent === root.id && n.name === 'Archive');
      if (archives.length !== 1 || archives[0].type !== 'CollectionType' || doc.parent !== archives[0].id) {
        throw new Error('Only active revisions and direct archived revisions can be renamed.');
      }
      parentPath += '/Archive';
    }
    const siblings = nodes.filter(n => n.parent === doc.parent);
    if (siblings.filter(n => n.name === doc.name).length !== 1) throw new Error('Source revision name is ambiguous.');
    // rMAPI mv treats an existing directory as a move destination. Reject both
    // document and directory collisions to keep a rename within its parent.
    if (siblings.some(n => n.id !== id && n.name === name)) throw new Error('Rename destination is already occupied.');
    if (doc.name === name) return doc;
    await this.command(['mv', `${parentPath}/${doc.name}`, `${parentPath}/${name}`]);
    const updated = (await this.list()).find(n => n.id === id);
    if (!updated || updated.name !== name || updated.parent !== doc.parent) throw new Error('Revision rename could not be verified.');
    return updated;
  }
  async archive(id: string): Promise<void> {
    let {root, nodes} = await this.tree();
    const doc = nodes.find(n => n.id === id && n.type === 'DocumentType');
    if (!root || !doc) throw new Error('Cannot archive an unmanaged document.');
    let archives = nodes.filter(n => n.parent === root!.id && n.name === 'Archive');
    if (archives.length > 1 || (archives[0] && archives[0].type !== 'CollectionType')) throw new Error('Archive folder is ambiguous.');
    if (archives[0] && doc.parent === archives[0].id) return;
    // Only active top-level revisions are archived; never move arbitrary nested documents.
    if (doc.parent !== root.id) throw new Error('Only active revisions can be archived.');
    safeName(doc.name);
    if (nodes.filter(n => n.parent === root!.id && n.name === doc.name).length !== 1) throw new Error('Source revision name is ambiguous.');
    if (!archives.length) {
      await this.command(['mkdir', '/' + this.folder + '/Archive']);
      ({root, nodes} = await this.tree());
      archives = nodes.filter(n => n.parent === root!.id && n.name === 'Archive' && n.type === 'CollectionType');
    }
    if (archives.length !== 1 || nodes.some(n => n.parent === archives[0].id && n.name === doc.name)) throw new Error('Archive destination is missing or already occupied.');
    await this.command(['mv', '/' + this.folder + '/' + doc.name, '/' + this.folder + '/Archive']);
    if (!(await this.list()).some(n => n.id === id && n.parent === archives[0].id)) throw new Error('Archive move could not be verified.');
  }
}

/** Read-only verification: absent legacy arrays must never verify a CRDT document. */
export function appendMappingsPresent(wanted: any, current: any): boolean {
  if (!wanted || !current) return false;
  if (wanted.cPages != null) {
    const pages = wanted.cPages.pages, actual = current.cPages?.pages;
    return Array.isArray(pages) && pages.length > 0 && Array.isArray(actual) && actual.length >= pages.length && pages.every((p: any, i: number) => {
      const q = actual[i];
      return p && q && typeof p.id === 'string' && p.id.length > 0 && p.id === q.id && typeof p.idx?.value === 'string' && p.idx.value.length > 0 && p.idx.value === q.idx?.value && Number.isInteger(p.redir?.value) && p.redir.value === q.redir?.value && (p.deleted == null || p.deleted.value === 0) && (q.deleted == null || q.deleted.value === 0);
    });
  }
  return current.cPages == null && Array.isArray(wanted.pages) && wanted.pages.length > 0 && Array.isArray(wanted.redirectionPageMap) && wanted.pages.length === wanted.redirectionPageMap.length && ['pages', 'redirectionPageMap'].every(key => Array.isArray(current[key]) && JSON.stringify(current[key].slice(0, wanted[key].length)) === JSON.stringify(wanted[key]));
}
