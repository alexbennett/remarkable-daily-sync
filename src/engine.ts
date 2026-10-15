import { randomUUID } from 'node:crypto';
import type { Settings, SyncState, Transport, Renderer, Recognizer, NoteState, Revision, ReviewItem, Interpretation, DownloadedDocument, PageImage } from './contracts';
import { LocalStore, hash } from './storage';
import { dailyDate } from './daily';
import { buildCandidate, mergeThreeWay } from './merge';
import { prepareAppend, UnsupportedAppendFormatError } from './append';
import { CloudRateLimitError } from './transport';

const RENDERED_VERSION = 4;
const RECOGNITION_VERSION = 6;

export interface VaultHost {
  writeAttachment?(path: string, bytes: Uint8Array): Promise<void>;
  files(): string[];
  read(path: string): Promise<string | null>;
  /** Read persisted file contents independently of the editor's in-memory state. */
  readSaved(path: string): Promise<string | null>;
  compareAndWrite(path: string, expected: string, next: string): Promise<void>;
  status(message: string): void;
}
interface CommitJournal { noteId: string; revisionId: string; before: string; after: string; tabletText: string; fingerprint: string; reviewId?: string; }
interface AppendJournal { noteId: string; documentId: string; expectedFile: string; contentFile: string; pdfFile: string; oldPageCount: number; revision: Revision; }
const remoteId = (revision: Revision) => revision.documentId ?? revision.id;

export class SyncEngine {
  private running = false;
  private faulted = false;
  private stopped = false;
  private cloudRetryAfter = 0;
  private pageRecognition = new Map<string, { result: Interpretation; bytes: number }>();
  private pageRecognitionBytes = 0;
  private pullCache = new Map<string, { downloaded: DownloadedDocument; pages?: PageImage[] }>();
  constructor(readonly state: SyncState, private settings: () => Settings, private host: VaultHost,
    private store: LocalStore, private transport: Transport, private renderer: Renderer, private recognizer: Recognizer) {}

  private async persist(): Promise<void> { await this.store.save(this.state); }
  stop(): void { this.stopped = true; }
  private assertActive(): void { if (this.stopped) throw new Error('Plugin stopped; synchronization will resume after reopening.'); }
  private noteByPath(path: string): NoteState | undefined { return Object.values(this.state.notes).find(n => n.path === path); }
  async renamed(oldPath: string, newPath: string): Promise<void> {
    const note = this.noteByPath(oldPath);
    if (note) { note.path = newPath; await this.persist(); }
  }
  async check(): Promise<string[]> { return [await this.transport.check(), await this.recognizer.check()]; }

  async tick(force = false): Promise<void> {
    if (this.running || this.faulted || this.stopped || (!force && this.settings().paused)) return;
    this.running = true;
    try {
      await this.recoverCommit();
      await this.recoverSavedHandwriting();
      if (Date.now() < this.cloudRetryAfter) { this.host.status('Cloud rate limited; waiting before retrying automatically'); return; }
      await this.recoverAppend();
      this.host.status('Checking tablet');
      const cloud = await this.transport.list();
      const ids = new Set(cloud.map(d => d.id));
      for (const note of Object.values(this.state.notes)) {
        note.missing = (await this.host.read(note.path)) === null;
        if (note.missing) continue;
        for (const rev of note.revisions) {
          if (!ids.has(remoteId(rev))) continue; // Remote deletions never delete local text.
          await this.pull(note, rev);
        }
      }
      for (const file of this.host.files()) {
        if (this.noteByPath(file)) continue;
        const date = dailyDate(file, this.settings().dailyRoot);
        if (!date || date < this.settings().startDate) continue;
        const note: NoteState = { id: randomUUID(), path: file, date, revisions: [] };
        this.state.notes[note.id] = note;
      }
      await this.persist();
      let waitingForRefresh = 0;
      const deferredLayouts: string[] = [];
      for (const note of Object.values(this.state.notes)) {
        if (this.state.reviews.some(r => r.noteId === note.id)) continue;
        const text = await this.host.read(note.path);
        if (text === null) continue;
        if (note.lastPublishedHash !== hash(text) || note.renderedVersion !== RENDERED_VERSION) {
          if (this.settings().manualRefresh && note.revisions.length) waitingForRefresh++;
          else {
            try { await this.publish(note, text); }
            catch (error) {
              if (!(error instanceof UnsupportedAppendFormatError)) throw error;
              // Keep importing handwriting and publishing other dates. Do not
              // acknowledge a layout that has not reached the tablet.
              deferredLayouts.push(note.date);
            }
          }
        }
        else await this.finishPublication(note);
      }
      const status = this.state.reviews.length ? `${this.state.reviews.length} to review` : waitingForRefresh ? `Notes synced; ${waitingForRefresh} tablet layout(s) waiting for refresh` : 'Up to date';
      this.host.status(deferredLayouts.length
        ? `Tablet layout pending for ${deferredLayouts.join(', ')}: cPages append is unsupported. Handwriting imports continue.${this.state.reviews.length ? ` ${status}.` : ''} Turn off history-page appending to publish new PDFs.`
        : status);
    } catch (error) {
      if (error instanceof CloudRateLimitError) this.cloudRetryAfter = Date.now() + error.retryAfterMs;
      this.host.status(`Sync stopped: ${(error as Error).message}`);
      // A durable pending commit is recovered before any new work on the next tick.
      throw error;
    } finally { this.pullCache.clear(); this.running = false; }
  }

  async refreshTablet(file: string): Promise<void> {
    if (this.running) throw new Error('Wait for the current sync to finish');
    this.running = true;
    try {
      this.assertActive();
      await this.recoverCommit();
      await this.recoverAppend();
      const note = this.noteByPath(file);
      if (!note) throw new Error('This note has not been enrolled. Run Sync now first.');
      // Pull every revision first so an explicit layout refresh includes the
      // latest cloud handwriting and cannot bypass a pending conflict review.
      const ids = new Set((await this.transport.list()).map(d => d.id));
      for (const rev of note.revisions) if (ids.has(remoteId(rev))) await this.pull(note, rev);
      if (this.state.reviews.some(r => r.noteId === note.id)) throw new Error('Review pending tablet changes before refreshing this layout.');
      const text = await this.host.read(file);
      if (text === null) throw new Error('Note moved or was deleted.');
      if (note.lastPublishedHash !== hash(text) || note.renderedVersion !== RENDERED_VERSION) await this.publish(note, text);
      else await this.finishPublication(note);
      this.host.status('Tablet layout refreshed');
    } finally { this.pullCache.clear(); this.running = false; }
  }

  /** A single disposable note may be exported before enrolling the real daily folder. */
  async exportValidation(file: string): Promise<void> {
    if (this.running) throw new Error('A sync operation is already running');
    this.running = true;
    try {
      const text = await this.host.read(file);
      if (text === null) throw new Error('Validation note not found');
      let note = this.noteByPath(file);
      if (!note) { note = { id: randomUUID(), path: file, date: 'validation', revisions: [] }; this.state.notes[note.id] = note; }
      await this.persist(); await this.publish(note, text);
    } finally { this.running = false; }
  }

  private async publish(note: NoteState, text: string): Promise<void> {
    this.assertActive();
    this.host.status(`Publishing ${note.date}`);
    const sequence = note.revisions.length + 1;
    // The stable name makes a retry after a cloud success/local crash idempotent.
    const name = `${note.date} - ${note.id.slice(0, 8)} - r${String(sequence).padStart(4, '0')} - ${hash(text).slice(0, 12)} - p${RENDERED_VERSION}`;
    const rendered = await this.renderer.render(text, note.path.split('/').pop()!.replace(/\.md$/, ''));
    const previous = note.revisions.at(-1);
    if (this.settings().appendHistory && previous) {
      if (!this.transport.append) throw new Error('Install the page-append cloud helper before enabling history pages.');
      const downloaded = await this.transport.download(remoteId(previous));
      if (previous.fingerprint !== downloaded.fingerprint) throw new Error('Tablet changed before publication. The next sync will import it before appending pages.');
      const prepared = await prepareAppend(downloaded.bytes, rendered.pdf);
      const operation = randomUUID();
      const pdfFile = await this.store.write(`pdf/${note.id}/append-${operation}.pdf`, prepared.pdf);
      const expectedFile = await this.store.write(`append/${operation}.rmdoc`, downloaded.bytes);
      const contentFile = await this.store.write(`append/${operation}.content`, prepared.content);
      const revision: Revision = { id: operation, documentId: remoteId(previous), name: previous.name, baseline: text,
        blocks: rendered.blocks.map(block => ({ ...block, page: block.page + prepared.oldPageCount })),
        firstPage: prepared.oldPageCount + 1, lastPage: prepared.oldPageCount + prepared.addedPageCount,
        pdfFile, tabletText: text, archived: false, createdAt: new Date().toISOString() };
      const journal: AppendJournal = { noteId: note.id, documentId: remoteId(previous), expectedFile, contentFile, pdfFile, oldPageCount: prepared.oldPageCount, revision };
      await this.store.write('pending-append.json', JSON.stringify(journal));
      await this.recoverAppend();
      return;
    }
    const pdfFile = await this.store.write(`pdf/${note.id}/${name}.pdf`, rendered.pdf);
    this.assertActive();
    const doc = await this.transport.upload(name, rendered.pdf);
    note.revisions.push({ id: doc.id, name: doc.name, baseline: text, blocks: rendered.blocks, pdfFile,
      tabletText: text, archived: false, createdAt: new Date().toISOString() });
    note.lastPublishedHash = hash(text);
    note.renderedVersion = RENDERED_VERSION;
    await this.persist();
    await this.finishPublication(note);
  }

  // Persist the uploaded ID before changing display names. Retrying this sequence
  // after interruption uses the same documents and never replaces tablet ink.
  private async finishPublication(note: NoteState): Promise<void> {
    const latest = note.revisions.at(-1);
    if (!latest) return;
    for (const prior of note.revisions.slice(0, -1)) {
      if (remoteId(prior) === remoteId(latest)) continue;
      if (prior.archived) continue;
      this.assertActive();
      if (this.transport.rename) {
        const index = note.revisions.indexOf(prior) + 1;
        const archiveName = `${note.date} - ${note.id.slice(0, 8)} - r${String(index).padStart(4, '0')} - ${hash(prior.baseline).slice(0, 12)}`;
        const renamed = await this.transport.rename(remoteId(prior), archiveName);
        prior.name = renamed.name; await this.persist();
      }
      await this.transport.archive(remoteId(prior)); prior.archived = true; await this.persist();
    }
    if (this.transport.rename) {
      const displayName = /^\d{4}-\d{2}-\d{2}$/.test(note.date) ? note.date : note.path.split('/').pop()!.replace(/\.md$/, '');
      if (latest.name === displayName) return;
      this.assertActive();
      const renamed = await this.transport.rename(remoteId(latest), displayName);
      if (latest.name !== renamed.name) { latest.name = renamed.name; await this.persist(); }
    }
  }

  private async pull(note: NoteState, rev: Revision): Promise<void> {
    const id = remoteId(rev);
    let cached = this.pullCache.get(id);
    if (!cached) { cached = { downloaded: await this.transport.download(id) }; this.pullCache.set(id, cached); }
    const downloaded = cached.downloaded;
    if (downloaded.fingerprint === rev.fingerprint || this.state.reviews.some(r => r.revisionId === rev.id && r.fingerprint === downloaded.fingerprint && r.recognitionVersion === RECOGNITION_VERSION)) return;
    await this.store.write(`originals/${rev.id}/${downloaded.fingerprint}.rmdoc`, downloaded.bytes);
    this.host.status(`Rendering tablet pages for ${note.date}`);
    cached.pages ??= await this.renderer.images(downloaded.bytes, await this.store.read(rev.pdfFile));
    const pages = cached.pages
      .filter(page => page.page >= (rev.firstPage ?? 1) && page.page <= (rev.lastPage ?? Infinity));
    const pageHash = hash(pages.map(p => `${p.page}:${p.inkHash}`).join('|'));
    const previous = await this.store.readText(`ink/${rev.id}.json`);
    if (previous === JSON.stringify({ pageHash, tabletHash: hash(rev.tabletText) })) {
      rev.fingerprint = downloaded.fingerprint;
      this.state.reviews = this.state.reviews.filter(r => r.revisionId !== rev.id);
      await this.persist(); return;
    }
    // Recognition always sees the complete current annotation state, including erased pages.
    const writtenPages = pages.filter(page => page.annotated !== page.base);
    if (writtenPages.length) this.host.status(`Reading ${writtenPages.length} handwritten page(s) with local Gemma`);
    const recoverable = this.state.reviews.find(r => r.revisionId === rev.id && r.fingerprint === downloaded.fingerprint &&
      (r.recognitionVersion ?? 0) < RECOGNITION_VERSION && r.reasons.length > 0 &&
      r.reasons.every(reason => reason === 'Handwriting proposals overlap.') && r.suggestions?.length);
    const interpretation: Interpretation = recoverable ? { edits: recoverable.suggestions!, warnings: [] as string[] } :
      writtenPages.length ? await this.interpretChangedPages(writtenPages, rev.blocks, rev.baseline,
        this.state.reviews.some(r => r.revisionId === rev.id && r.recognitionVersion !== RECOGNITION_VERSION)) : { edits: [], warnings: [] };
    if (writtenPages.length && !interpretation.edits.length && !interpretation.drawings?.length && !interpretation.warnings.length) interpretation.warnings.push('Handwriting is present but no text edit was recognized. Review the original pages.');
    const candidate = buildCandidate(rev.baseline, rev.blocks, interpretation);
    if (interpretation.drawings?.length && !candidate.errors.length) {
      if (!this.renderer.drawingImage || !this.host.writeAttachment) throw new Error('Drawing attachment support is unavailable.');
      const embeds = new Set<string>();
      for (const region of interpretation.drawings) {
        const page = writtenPages.find(p => p.page === region.page);
        if (!page) throw new Error('Drawing references a page without tablet changes.');
        // A printed embed is already part of the note. OCR must not import it
        // again simply because another area of this page has new handwriting.
        if (this.renderer.hasNewDrawingInk && !await this.renderer.hasNewDrawingInk(page, region)) continue;
        const bytes = await this.renderer.drawingImage(page, region);
        const attachment = `reMarkable Attachments/${hash(bytes)}.png`;
        this.assertActive();
        await this.host.writeAttachment(attachment, bytes);
        const embed = `![[${attachment}]]`;
        if (!candidate.text.includes(embed)) embeds.add(embed);
      }
      if (embeds.size) {
        candidate.text = candidate.text.trimEnd() + '\n\n' + [...embeds].join('\n\n') + '\n';
        candidate.kinds = [...new Set([...candidate.kinds, 'insert' as const])];
      }
    }
    if (candidate.text !== rev.tabletText && !candidate.kinds.length && !candidate.errors.length) candidate.kinds.push('delete');
    const current = await this.host.read(note.path);
    if (current === null) return;
    const refillEmpty = this.settings().automatic && !current.trim() && !rev.baseline.trim() &&
      !!candidate.text.trim() && !candidate.errors.length && !interpretation.warnings.length;
    const merged = refillEmpty ? { text: candidate.text, conflicts: [] } : mergeThreeWay(rev.tabletText, current, candidate.text);
    const reasons = [...interpretation.warnings, ...candidate.errors, ...merged.conflicts];
    const canValidate = reasons.length === 0;
    if (merged.conflicts.length) reasons.push('Manual reconciliation is required: the proposed text preserves the current Obsidian note; use the tablet interpretation as a reference.');
    const settings = this.settings();
    if (candidate.text !== rev.tabletText && !settings.automatic) {
      reasons.push('Automatic application is disabled.');
    }
    if (reasons.length) {
      const images: string[] = [];
      for (const page of pages) images.push(await this.store.write(`review-images/${rev.id}/${downloaded.fingerprint}-${page.page}.png`, Buffer.from(page.annotated, 'base64')));
      this.state.reviews = this.state.reviews.filter(r => r.revisionId !== rev.id);
      this.state.reviews.push({ recognitionVersion: RECOGNITION_VERSION, id: randomUUID(), noteId: note.id, revisionId: rev.id, fingerprint: downloaded.fingerprint,
        createdAt: new Date().toISOString(), base: rev.tabletText, current, proposed: merged.conflicts.length ? current : merged.text,
        tabletText: candidate.text, reasons, kinds: candidate.kinds, images, canValidate, suggestions: interpretation.edits });
      await this.persist(); return;
    }
    await this.commit({ noteId: note.id, revisionId: rev.id, before: current, after: merged.text, tabletText: candidate.text, fingerprint: downloaded.fingerprint });
    await this.store.write(`ink/${rev.id}.json`, JSON.stringify({ pageHash, tabletHash: hash(rev.tabletText) }));
  }

  private async interpretChangedPages(pages: PageImage[], blocks: Revision['blocks'], baseline: string, force = false): Promise<Interpretation> {
    const settings = this.settings();
    const keys = pages.map(page => hash(JSON.stringify([RECOGNITION_VERSION, settings.model, settings.ollamaUrl,
      baseline, blocks.filter(b => b.page === page.page), page.page, page.base, page.annotated, page.changes])));
    if (force) for (const key of keys) {
      const old = this.pageRecognition.get(key);
      if (old) { this.pageRecognitionBytes -= old.bytes; this.pageRecognition.delete(key); }
    }
    const missing = pages.filter((_, i) => !this.pageRecognition.has(keys[i]));
    const fresh: Interpretation = missing.length ? await this.recognizer.interpret(missing, blocks, baseline) : { edits: [], warnings: [] };
    const result: Interpretation = { edits: [], warnings: [...fresh.warnings], drawings: [] };
    const cacheable = !fresh.warnings.length && !fresh.edits.some(edit => edit.ambiguous) &&
      !buildCandidate(baseline, blocks, fresh).errors.length;
    for (let i = 0; i < pages.length; i++) {
      const key = keys[i], page = pages[i];
      const cached = this.pageRecognition.get(key);
      const part: Interpretation = cached?.result ?? { edits: fresh.edits.filter(edit => edit.page === page.page),
        warnings: [], drawings: fresh.drawings?.filter(drawing => drawing.page === page.page) };
      if (cached) { this.pageRecognition.delete(key); this.pageRecognition.set(key, cached); }
      else if (cacheable && (part.edits.length || part.drawings?.length)) {
        const encoded = JSON.stringify(part), bytes = Buffer.byteLength(encoded);
        if (bytes <= 16 * 1024 * 1024) {
          while (this.pageRecognition.size >= 64 || this.pageRecognitionBytes + bytes > 16 * 1024 * 1024) {
            const oldest = this.pageRecognition.keys().next().value!;
            this.pageRecognitionBytes -= this.pageRecognition.get(oldest)!.bytes;
            this.pageRecognition.delete(oldest);
          }
          this.pageRecognition.set(key, { result: JSON.parse(encoded), bytes }); this.pageRecognitionBytes += bytes;
        }
      }
      result.edits.push(...part.edits.map(edit => ({ ...edit })));
      result.drawings!.push(...(part.drawings ?? []).map(drawing => ({ ...drawing })));
    }
    return result;
  }

  async review(id: string, action: 'accept' | 'reject', edited?: string): Promise<ReviewItem> {
    if (this.running) throw new Error('Wait for the current sync to finish');
    this.running = true;
    try {
      const item = this.state.reviews.find(r => r.id === id);
      if (!item) throw new Error('This review is no longer pending');
      const note = this.state.notes[item.noteId];
      const current = await this.host.read(note.path);
      if (current === null) throw new Error('The note has moved or been deleted');
      if (action === 'accept' && current !== item.current) throw new Error('The Obsidian note changed while this review was open. Refresh the review before applying.');
      await this.commit({ noteId: item.noteId, revisionId: item.revisionId, before: current,
        after: action === 'reject' ? current : (edited ?? item.proposed), tabletText: item.tabletText,
        fingerprint: item.fingerprint, reviewId: id });
      return item;
    } finally { this.running = false; }
  }

  async refreshReview(id: string): Promise<void> {
    if (this.running) throw new Error('Wait for the current sync to finish');
    this.running = true;
    try {
    const item = this.state.reviews.find(r => r.id === id);
    if (!item) return;
    const current = await this.host.read(this.state.notes[item.noteId].path);
    if (current === null) throw new Error('Note is missing');
    const merged = mergeThreeWay(item.base, current, item.tabletText);
    item.current = current; item.proposed = merged.conflicts.length ? current : merged.text;
    if (merged.conflicts.length) item.canValidate = false;
    item.reasons = [...item.reasons, ...merged.conflicts]; await this.persist();
    } finally { this.running = false; }
  }

  private async recoverSavedHandwriting(): Promise<void> {
    if (!this.settings().automatic) return;
    for (const item of [...this.state.reviews]) {
      const emptyNote = this.state.notes[item.noteId];
      const emptyRevision = emptyNote?.revisions.find(r => r.id === item.revisionId);
      const mergeOnly = item.reasons.length > 0 && item.reasons.every(reason =>
        reason === 'Obsidian and tablet edits overlap or share an insertion boundary.' ||
        reason === 'Manual reconciliation is required: the proposed text preserves the current Obsidian note; use the tablet interpretation as a reference.');
      if (emptyRevision && !emptyRevision.baseline.trim() && emptyRevision.tabletText === item.base &&
          item.tabletText.trim() && mergeOnly && item.suggestions?.every(edit => !edit.ambiguous)) {
        const current = await this.host.read(emptyNote.path);
        if (current !== null && !current.trim()) {
          await this.commit({ noteId: emptyNote.id, revisionId: emptyRevision.id, before: current, after: item.tabletText,
            tabletText: item.tabletText, fingerprint: item.fingerprint, reviewId: item.id });
          continue;
        }
      }
      if (item.recognitionVersion !== 5 || !item.suggestions?.length || !item.reasons.length ||
          !item.reasons.every(reason => reason === 'Handwriting proposals overlap.')) continue;
      const note = this.state.notes[item.noteId];
      const rev = note?.revisions.find(r => r.id === item.revisionId);
      if (!rev || rev.tabletText !== item.base) continue;
      const candidate = buildCandidate(rev.baseline, rev.blocks, { edits: item.suggestions, warnings: [] });
      if (candidate.errors.length) continue;
      const current = await this.host.read(note.path);
      if (current === null) continue;
      const merged = mergeThreeWay(item.base, current, candidate.text);
      if (merged.conflicts.length) continue;
      // Already-downloaded, recognized handwriting needs no fresh cloud request.
      // The next pull still sees and reconciles newer tablet changes normally.
      await this.commit({ noteId: note.id, revisionId: rev.id, before: current, after: merged.text,
        tabletText: candidate.text, fingerprint: item.fingerprint, reviewId: item.id });
    }
  }

  private async recoverAppend(): Promise<void> {
    const raw = await this.store.readText('pending-append.json');
    if (!raw) return;
    this.assertActive();
    if (!this.transport.append) throw new Error('Page-append support is required to recover the pending update.');
    const journal: AppendJournal = JSON.parse(raw);
    const note = this.state.notes[journal.noteId];
    if (!note) throw new Error('Pending page append refers to an unknown note.');
    try {
      await this.transport.append(journal.documentId, await this.store.read(journal.expectedFile),
        await this.store.read(journal.pdfFile), await this.store.read(journal.contentFile));
    } catch (error) {
      if ((error as Error).name === 'AppendConflictError') await this.store.remove('pending-append.json');
      throw error;
    }
    for (const prior of note.revisions) if (remoteId(prior) === journal.documentId) {
      prior.firstPage ??= 1;
      prior.lastPage ??= journal.oldPageCount;
      prior.pdfFile = journal.pdfFile;
    }
    if (!note.revisions.some(rev => rev.id === journal.revision.id)) note.revisions.push(journal.revision);
    note.lastPublishedHash = hash(journal.revision.baseline);
    note.renderedVersion = RENDERED_VERSION;
    await this.persist();
    await this.store.remove('pending-append.json');
  }

  private async commit(journal: CommitJournal): Promise<void> {
    this.assertActive();
    const note = this.state.notes[journal.noteId];
    await this.store.backup(note.id, journal.before);
    await this.store.write('pending-commit.json', JSON.stringify(journal));
    if (journal.before !== journal.after) await this.host.compareAndWrite(note.path, journal.before, journal.after);
    await this.verifySaved(note.path, journal.after);
    this.finishCommit(journal); await this.persist(); await this.store.remove('pending-commit.json');
  }
  private async verifySaved(file: string, expected: string): Promise<void> {
    this.assertActive();
    if (await this.host.readSaved(file) !== expected) {
      throw new Error('Obsidian save could not be verified. Handwriting is still pending and will retry automatically; its recovery journal is preserved.');
    }
  }
  private finishCommit(journal: CommitJournal): void {
    const rev = this.state.notes[journal.noteId].revisions.find(r => r.id === journal.revisionId);
    if (!rev) throw new Error('Revision missing from recovery journal');
    rev.tabletText = journal.tabletText; rev.fingerprint = journal.fingerprint;
    this.state.reviews = this.state.reviews.filter(r => r.revisionId !== journal.revisionId);
  }
  private async recoverCommit(): Promise<void> {
    const raw = await this.store.readText('pending-commit.json');
    if (!raw) return;
    const journal: CommitJournal = JSON.parse(raw);
    const note = this.state.notes[journal.noteId];
    if (!note) throw new Error('Recovery journal refers to an unknown note');
    const current = await this.host.read(note.path);
    if (current === journal.after) { await this.verifySaved(note.path, journal.after); this.finishCommit(journal); await this.persist(); await this.store.remove('pending-commit.json'); return; }
    if (current === journal.before) { await this.commit(journal); return; }
    this.faulted = true;
    throw new Error('A pending write conflicts with newer vault text. Backups and pending-commit.json are preserved; restore or reconcile before restarting sync.');
  }
}
