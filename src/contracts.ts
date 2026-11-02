export interface SourceBlock { id: string; start: number; end: number; markdown: string; page: number; }
export interface RenderedNote { pdf: Uint8Array; blocks: SourceBlock[]; pageCount: number; }
export interface PageImage { page: number; pageId?: string; base: string; annotated: string; inkHash: string; changes?: string; }
export interface CloudDocument { id: string; name: string; parent: string; version: number; modifiedClient: string; contentHash?: string; }
export interface DownloadedDocument { bytes: Uint8Array; fingerprint: string; }
export interface Transport {
  list(): Promise<CloudDocument[]>;
  download(id: string): Promise<DownloadedDocument>;
  upload(name: string, pdf: Uint8Array): Promise<CloudDocument>;
  archive(id: string): Promise<void>;
  rename?(id: string, name: string): Promise<CloudDocument>;
  append?(id: string, expectedArchive: Uint8Array, pdf: Uint8Array, content: Uint8Array): Promise<void>;
  getNotebookWriteCapability?(): { supported: false; reason: string };
  replaceNotebook?(id: string, expectedArchive: Uint8Array, pdf: Uint8Array, content: Uint8Array, processedInkFiles: string[], gate: { authorizedDocumentId: string }): Promise<void>;
  check(): Promise<string>;
}
export interface Renderer {
  hasNewDrawingInk?(page: PageImage, region: DrawingRegion): Promise<boolean>;
  drawingImage?(page: PageImage, region: DrawingRegion): Promise<Uint8Array>;
  render(markdown: string, title: string): Promise<RenderedNote>;
  images(archive: Uint8Array, originalPdf: Uint8Array): Promise<PageImage[]>;
}
export interface ProposedEdit { blockId: string; before: string; after: string; kind: 'insert' | 'replace' | 'delete'; page: number; ambiguous: boolean; reason: string; }
export interface DrawingRegion { page: number; x: number; y: number; width: number; height: number; }
export interface Interpretation { edits: ProposedEdit[]; warnings: string[]; drawings?: DrawingRegion[]; }
export interface Recognizer {
  check(): Promise<string>;
  interpret(pages: PageImage[], blocks: SourceBlock[], baseline: string): Promise<Interpretation>;
}
export interface MergeResult { text: string; conflicts: string[]; }
export interface CandidateResult { text: string; errors: string[]; kinds: Array<ProposedEdit['kind']>; }
export interface Settings {
  dailyRoot: string; startDate: string; cloudFolder: string; rmapiPath: string;
  ollamaUrl: string; model: string; paused: boolean; automatic: boolean;
  validatedKinds: Array<ProposedEdit['kind']>; pollSeconds: number;
  manualRefresh?: boolean;
  appendHistory?: boolean;
  notebookMappings?: NotebookMapping[];
}
/** Explicit vault-folder to tablet-notebook mapping; id is stable across renames. */
export interface NotebookMapping { id: string; folder: string; title: string; enabled: boolean; }
/** Physical PDF pages are one-based; pageId is the tablet's stable page identity. */
export interface NotebookPage { pageId: string; pdfPage: number; noteId: string; revisionId: string; }
export interface NotebookState {
  id: string; mappingId: string; documentId?: string;
  pdfFile?: string; format?: string;
  entryIds: string[]; generation: number; pages: NotebookPage[];
  /** Lifecycle metadata only: never overrides the transport's notebook-write gate. */
  validation: 'pending' | 'validated';
  pendingReason?: string;
  layoutConflict?: { fingerprint: string; archiveFile: string; reason: string };
}
export interface Revision {
  notebookId?: string; pageIds?: string[]; superseded?: boolean;
  documentId?: string; firstPage?: number; lastPage?: number;
  id: string; name: string; baseline: string; blocks: SourceBlock[]; pdfFile: string;
  fingerprint?: string; tabletText: string; archived: boolean; createdAt: string;
}
export interface NoteState { id: string; path: string; date: string; revisions: Revision[]; lastPublishedHash?: string; renderedVersion?: number; missing?: boolean; }
export interface ReviewItem {
  recognitionVersion?: number;
  id: string; noteId: string; revisionId: string; fingerprint: string; createdAt: string;
  base: string; current: string; proposed: string; tabletText: string; reasons: string[];
  kinds: Array<ProposedEdit['kind']>; images: string[];
  suggestions?: ProposedEdit[];
  canValidate?: boolean;
}
export interface SyncState { version: 2; notes: Record<string, NoteState>; reviews: ReviewItem[]; notebooks: Record<string, NotebookState>; }
