import { randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { LocalStore, hash } from './storage';
import { mappingForFile, renderNotebook, notebookTitle, type NotebookEntryManifest } from './notebooks';
import { prepareCPagesUpdate } from './cpages';
import type { NotebookState, NoteState, Revision, Settings, SyncState, Transport, Renderer } from './contracts';

export interface NotebookSyncCallbacks {
  pull(note: NoteState, revision: Revision): Promise<void>;
  authorize(documentId: string | undefined, format: string): boolean;
  assertActive?(): void;
}
export interface NotebookSyncHost { read(path: string): Promise<string | null>; status(message: string): void; }
interface Snapshot { pdf: Uint8Array; format: string; pages: Array<{ pageId: string; pdfPage: number }>; unassignedPageIds: string[]; inkFiles: string[]; }
interface EntryCommit { noteId: string; revision: Revision; }
interface Journal {
  kind: 'create' | 'update'; notebookId: string; generation: number; documentId?: string;
  uploadName?: string; pdfFile: string; expectedFile?: string; contentFile?: string;
  deleteFiles?: string[]; entries: EntryCommit[];
}
class NotebookDeferred extends Error {}

/** Read tablet-assigned page identities; never guess IDs for an uninitialized PDF. */
async function snapshot(bytes: Uint8Array): Promise<Snapshot> {
  let expanded = 0; const names: string[] = [];
  const files = unzipSync(bytes, { filter: entry => {
    expanded += entry.originalSize;
    if (expanded > 160 * 1024 * 1024 || entry.originalSize > 80 * 1024 * 1024) throw new Error('Notebook archive exceeds the size limit.');
    names.push(entry.name); return entry.name.endsWith('.pdf') || entry.name.endsWith('.content');
  } });
  const pdfKeys = Object.keys(files).filter(n => n.endsWith('.pdf')), contentKeys = Object.keys(files).filter(n => n.endsWith('.content'));
  if (pdfKeys.length !== 1 || contentKeys.length !== 1 || pdfKeys[0].slice(0, -4) !== contentKeys[0].slice(0, -8)) throw new NotebookDeferred('Notebook archive does not contain one matching PDF and content file.');
  const pdf = files[pdfKeys[0]], count = (await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount();
  const content = JSON.parse(strFromU8(files[contentKeys[0]]));
  let pages: Snapshot['pages'], format: string; const unassignedPageIds: string[] = [];
  if (content.cPages) {
    format = 'cPages-v2';
    if (content.formatVersion !== 2 || !Array.isArray(content.cPages.pages)) throw new NotebookDeferred('Notebook cPages metadata is not supported.');
    const records = content.cPages.pages.filter((p: any) => !p.deleted?.value);
    if (records.some((p: any) => typeof p.idx?.value !== 'string' || !p.idx.value || typeof p.id !== 'string' || !p.id)) throw new NotebookDeferred('Notebook page identities or ordering are incomplete.');
    if (new Set(records.map((p: any) => p.idx.value)).size !== records.length || new Set(records.map((p: any) => p.id)).size !== records.length) throw new NotebookDeferred('Notebook page ordering or identities are ambiguous.');
    const ordered = records.sort((a: any, b: any) => a.idx.value < b.idx.value ? -1 : a.idx.value > b.idx.value ? 1 : 0);
    const backed = ordered.filter((p: any) => {
      if (p.redir == null || p.redir.value === -1) { unassignedPageIds.push(p.id); return false; }
      if (!Number.isInteger(p.redir.value) || p.redir.value < 0) throw new NotebookDeferred('Notebook PDF page redirection is invalid.');
      return true;
    });
    pages = backed.map((p: any) => ({ pageId: p.id, pdfPage: p.redir.value + 1 }));
  } else {
    format = 'legacy';
    if (!Array.isArray(content.pages) || !Array.isArray(content.redirectionPageMap) || content.pages.length !== content.redirectionPageMap.length) throw new NotebookDeferred('Open the uploaded notebook on the tablet and let it sync before publishing updates.');
    pages = content.pages.map((pageId: string, i: number) => ({ pageId, pdfPage: content.redirectionPageMap[i] + 1 }));
  }
  if (!pages.length || pages.some(p => typeof p.pageId !== 'string' || !p.pageId || !Number.isInteger(p.pdfPage) || p.pdfPage < 1 || p.pdfPage > count) || new Set(pages.map(p => p.pageId)).size !== pages.length || new Set(pages.map(p => p.pdfPage)).size !== pages.length) throw new NotebookDeferred('Notebook page mapping requires review before publishing.');
  return { pdf, pages, format, unassignedPageIds, inkFiles: names.filter(n => n.endsWith('.rm')) };
}
const unassignedNotice = (value: Snapshot): string | undefined => value.unassignedPageIds.length
  ? `${value.unassignedPageIds.length} tablet-added page(s) have no source note. Their pages and handwriting are preserved; existing note synchronization continues.` : undefined;

/** Durable, scoped notebook publication. Permission is checked independently for every operation. */
export class NotebookSync {
  constructor(private state: SyncState, private settings: () => Settings, private host: NotebookSyncHost,
    private store: LocalStore, private transport: Transport, private renderer: Renderer, private callbacks: NotebookSyncCallbacks) {}

  private active(notebook: NotebookState): Array<{ note: NoteState; revision: Revision }> {
    return Object.values(this.state.notes).flatMap(note => note.revisions.filter(r => r.notebookId === notebook.id && !r.superseded).map(revision => ({ note, revision })));
  }
  private async save(): Promise<void> { await this.store.save(this.state); }
  private assertActive(): void { this.callbacks.assertActive?.(); }
  private async pending(notebook: NotebookState, reason: string): Promise<void> { notebook.pendingReason = reason; await this.save(); this.host.status(reason); }
  private makeRevision(notebook: NotebookState, entry: NotebookEntryManifest, pdfFile: string): Revision {
    return { id: randomUUID(), notebookId: notebook.id, documentId: notebook.documentId, name: notebook.mappingId,
      baseline: entry.baseline, tabletText: entry.baseline, blocks: entry.blocks, firstPage: entry.firstPage,
      lastPage: entry.lastPage, pdfFile, archived: false, createdAt: new Date().toISOString() };
  }

  async sync(): Promise<void> {
    await this.recover();
    if (await this.store.readText('pending-notebook.json')) return;
    for (const notebook of Object.values(this.state.notebooks)) {
      const mapping = this.settings().notebookMappings?.find(m => m.id === notebook.mappingId);
      if (!mapping?.enabled) continue;
      try {
        this.assertActive();
        if (!notebook.documentId) { await this.create(notebook, mapping.title); }
        else { await this.update(notebook); await this.finishLegacyArchive(notebook); }
      } catch (error) {
        if (!(error instanceof NotebookDeferred)) throw error;
        await this.pending(notebook, error.message);
      }
      if (await this.store.readText('pending-notebook.json')) return;
    }
  }

  private async inputs(notebook: NotebookState) {
    const result: Array<{ id: string; path: string; markdown: string }> = [];
    for (const id of notebook.entryIds) {
      const note = this.state.notes[id];
      if (!note || mappingForFile(this.settings().notebookMappings ?? [], note.path)?.id !== notebook.mappingId) continue;
      const markdown = await this.host.read(note.path);
      if (markdown !== null) result.push({ id, path: note.path, markdown });
    }
    return result;
  }
  private async create(notebook: NotebookState, title: string): Promise<void> {
    if (!this.callbacks.authorize(undefined, 'create')) throw new NotebookDeferred('Notebook creation is awaiting disposable-tablet validation.');
    if (this.state.reviews.some(r => notebook.entryIds.includes(r.noteId))) throw new NotebookDeferred('Resolve pending handwriting reviews before creating this notebook.');
    const collision = (await this.transport.list()).find(doc => doc.name.trim().toLowerCase() === title.trim().toLowerCase());
    if (collision) throw new NotebookDeferred(`A tablet document named "${title}" already exists. Choose a distinct notebook title before publishing.`);
    const inputs = await this.inputs(notebook); if (!inputs.length) return;
    const rendered = await renderNotebook(this.renderer, notebook.mappingId, inputs);
    const operation = randomUUID(), pdfFile = await this.store.write(`notebooks/${notebook.id}/${operation}.pdf`, rendered.pdf);
    const journal: Journal = { kind: 'create', notebookId: notebook.id, generation: notebook.generation + 1,
      uploadName: `${title} - ${notebook.id.slice(0, 8)} - initial`, pdfFile,
      entries: rendered.manifest.entries.map(entry => ({ noteId: entry.noteId, revision: this.makeRevision(notebook, entry, pdfFile) })) };
    await this.store.write('pending-notebook.json', JSON.stringify(journal)); await this.recover();
  }

  private async update(notebook: NotebookState): Promise<void> {
    if (!this.callbacks.authorize(notebook.documentId, 'cPages-v2')) throw new NotebookDeferred('Notebook updates are awaiting validation for this tablet document and format.');
    if (!this.transport.replaceNotebook) throw new NotebookDeferred('The installed cloud helper does not support notebook updates.');
    const active = this.active(notebook);
    // All affected handwriting must reach durable notes before any ink is removed.
    for (const { note, revision } of active) await this.callbacks.pull(note, revision);
    const reviewNotes = new Set(this.state.reviews.filter(r => notebook.entryIds.includes(r.noteId)).map(r => r.noteId));
    const inputs = await this.inputs(notebook);
    const changed = inputs.find(input => !reviewNotes.has(input.id) && active.find(a => a.note.id === input.id)?.revision.baseline !== input.markdown);
    const downloaded = await this.transport.download(notebook.documentId!);
    if (active.some(a => a.revision.fingerprint !== downloaded.fingerprint && !this.state.reviews.some(r => r.revisionId === a.revision.id && r.fingerprint === downloaded.fingerprint))) throw new NotebookDeferred('Notebook changed during handwriting import; it will be retried on the next sync.');
    const before = await snapshot(downloaded.bytes);
    if (before.pages.length !== notebook.pages.length || before.pages.some(p => !notebook.pages.some(known => known.pageId === p.pageId && known.pdfPage === p.pdfPage))) throw new NotebookDeferred('Tablet notebook page mapping changed; preserve the original and review its new pages before publishing.');
    if (!changed) { notebook.pendingReason = reviewNotes.size ? 'Resolve pending notebook entry reviews before publishing those entries.' : unassignedNotice(before); await this.save(); if (notebook.pendingReason) this.host.status(notebook.pendingReason); return; }
    if (before.format !== 'cPages-v2') throw new NotebookDeferred('Open this notebook on the tablet and sync its cPages metadata before updating it.');
    const prior = active.find(a => a.note.id === changed.id)?.revision;
    const ids = prior?.pageIds ?? [];
    const inkFiles = before.inkFiles.filter(file => ids.some(id => file.endsWith(`/${id}.rm`)));
    const rendered = await this.renderer.render(changed.markdown, notebookTitle(changed.path));
    let prepared;
    try { prepared = await prepareCPagesUpdate(downloaded.bytes, rendered.pdf, { pageIds: ids, processedInkFiles: inkFiles }); }
    catch (error) { throw new NotebookDeferred((error as Error).message); }
    const operation = randomUUID(), pdfFile = await this.store.write(`notebooks/${notebook.id}/${operation}.pdf`, prepared.pdf);
    const revision: Revision = { id: operation, notebookId: notebook.id, documentId: notebook.documentId, name: notebook.mappingId,
      baseline: changed.markdown, tabletText: changed.markdown, blocks: rendered.blocks.map(b => ({ ...b, page: prepared.pages[b.page - 1].pdfPage })),
      firstPage: prepared.pages[0].pdfPage, lastPage: prepared.pages.at(-1)!.pdfPage, pageIds: prepared.pages.map(p => p.pageId),
      pdfFile, archived: false, createdAt: new Date().toISOString() };
    const journal: Journal = { kind: 'update', notebookId: notebook.id, generation: notebook.generation + 1, documentId: notebook.documentId,
      pdfFile, expectedFile: await this.store.write(`notebooks/${notebook.id}/${operation}.before.rmdoc`, downloaded.bytes),
      contentFile: await this.store.write(`notebooks/${notebook.id}/${operation}.content`, prepared.content), deleteFiles: prepared.deleteFiles,
      entries: [{ noteId: changed.id, revision }] };
    await this.store.write('pending-notebook.json', JSON.stringify(journal)); await this.recover();
  }

  async recover(): Promise<void> {
    const raw = await this.store.readText('pending-notebook.json'); if (!raw) return;
    const journal = JSON.parse(raw) as Journal, notebook = this.state.notebooks[journal.notebookId];
    if (!notebook) throw new Error('Pending notebook operation refers to an unknown notebook.');
    this.assertActive();
    if (!this.settings().notebookMappings?.some(mapping => mapping.id === notebook.mappingId && mapping.enabled)) {
      await this.pending(notebook, 'Pending notebook operation is paused because its folder mapping is disabled or removed.'); return;
    }
    if (!this.callbacks.authorize(journal.documentId, journal.kind === 'create' ? 'create' : 'cPages-v2')) {
      await this.pending(notebook, 'A pending notebook operation is waiting for scoped tablet validation.'); return;
    }
    const pdf = await this.store.read(journal.pdfFile);
    if (journal.kind === 'create' && !journal.documentId) {
      const uploaded = await this.transport.upload(journal.uploadName!, pdf);
      journal.documentId = uploaded.id;
      await this.store.write('pending-notebook.json', JSON.stringify(journal));
    } else if (journal.kind === 'update') {
      if (!this.transport.replaceNotebook) throw new Error('Notebook replacement support is unavailable during recovery.');
      try {
        await this.transport.replaceNotebook(journal.documentId!, await this.store.read(journal.expectedFile!), pdf,
          await this.store.read(journal.contentFile!), journal.deleteFiles!, { authorizedDocumentId: journal.documentId! });
      } catch (error) {
        if ((error as Error).name === 'NotebookUpdateConflictError') {
          await this.store.remove('pending-notebook.json'); await this.pending(notebook, 'Tablet changed before the notebook update; handwriting will be imported before retrying.'); return;
        }
        throw error;
      }
    }
    const downloaded = await this.transport.download(journal.documentId!);
    let verified: Snapshot;
    try { verified = await snapshot(downloaded.bytes); }
    catch (error) { if (error instanceof NotebookDeferred) { await this.pending(notebook, error.message); return; } throw error; }
    if (hash(verified.pdf) !== hash(pdf)) throw new Error('Notebook publication PDF verification failed; recovery journal preserved.');
    for (const commit of journal.entries) {
      const revision = commit.revision;
      if (journal.kind === 'create') {
        const pages = verified.pages.slice(revision.firstPage! - 1, revision.lastPage!);
        if (pages.length !== revision.lastPage! - revision.firstPage! + 1 || pages.some((p, i) => p.pdfPage !== revision.firstPage! + i)) throw new Error('Initial notebook page routing differs from its rendered manifest.');
        revision.pageIds = pages.map(p => p.pageId);
      } else if (revision.pageIds?.some((id, i) => !verified.pages.some(p => p.pageId === id && p.pdfPage === revision.firstPage! + i))) throw new Error('Notebook update page identities failed verification.');
      revision.documentId = journal.documentId;
    }
    // Acknowledgement follows remote verification and is replay-safe after save failure.
    for (const commit of journal.entries) {
      const note = this.state.notes[commit.noteId]; if (!note) throw new Error('Notebook source note is missing from state.');
      for (const old of note.revisions) if (old.notebookId === notebook.id && old.id !== commit.revision.id) old.superseded = true;
      if (!note.revisions.some(r => r.id === commit.revision.id)) note.revisions.push(commit.revision);
    }
    notebook.documentId = journal.documentId; notebook.pdfFile = journal.pdfFile; notebook.format = verified.format;
    notebook.generation = Math.max(notebook.generation, journal.generation); notebook.pendingReason = unassignedNotice(verified);
    notebook.pages = [];
    for (const { note, revision } of this.active(notebook)) {
      revision.pdfFile = journal.pdfFile;
      revision.pageIds?.forEach((pageId, index) => notebook.pages.push({ pageId, pdfPage: revision.firstPage! + index, noteId: note.id, revisionId: revision.id }));
    }
    await this.save(); await this.store.remove('pending-notebook.json');
    await this.finishLegacyArchive(notebook);
    if (notebook.pendingReason) this.host.status(notebook.pendingReason);
  }

  private async finishLegacyArchive(notebook: NotebookState): Promise<void> {
    if (!notebook.documentId || !notebook.generation) return;
    const ids = new Set<string>();
    for (const noteId of notebook.entryIds) for (const revision of this.state.notes[noteId]?.revisions ?? []) {
      if (!revision.notebookId && !revision.archived && (revision.documentId ?? revision.id) !== notebook.documentId) ids.add(revision.documentId ?? revision.id);
    }
    for (const id of ids) {
      this.assertActive(); await this.transport.archive(id);
      for (const note of Object.values(this.state.notes)) for (const rev of note.revisions) if (!rev.notebookId && (rev.documentId ?? rev.id) === id) rev.archived = true;
      await this.save();
    }
    const title = this.settings().notebookMappings?.find(m => m.id === notebook.mappingId)?.title;
    if (title && this.transport.rename) await this.transport.rename(notebook.documentId, title);
  }
}
