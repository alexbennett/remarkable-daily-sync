import { Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, FileSystemAdapter, App } from 'obsidian';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { LocalStore, hash } from './storage';
import { today } from './daily';
import { SyncEngine, type VaultHost } from './engine';
import { RmapiTransport } from './transport';
import { NoteRenderer } from './renderer';
import { OllamaRecognizer } from './recognition';
import type { Settings, ReviewItem } from './contracts';

export default class DailySyncPlugin extends Plugin {
  declare settings: Settings;
  store!: LocalStore;
  engine!: SyncEngine;
  private status!: HTMLElement;
  private timer?: number;
  private debounce?: number;
  private pluginDirectory!: string;
  private disposed = false;
  requiresReload = false;
  lastStatus = 'Paused — finish setup';

  async onload(): Promise<void> {
    this.status = this.addStatusBarItem();
    this.status.addClass('rmd-status');
    this.status.addEventListener('click', () => this.openReviews());
    if (!(this.app.vault.adapter instanceof FileSystemAdapter) || process.platform !== 'win32') {
      this.status.setText('rM: Windows desktop required'); return;
    }
    const vaultPath = this.app.vault.adapter.getBasePath();
    this.pluginDirectory = path.join(vaultPath, this.manifest.dir!);
    const directory = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE!, 'AppData', 'Local'), 'RemarkableDailySync', hash(vaultPath.toLowerCase()).slice(0, 16));
    this.store = new LocalStore(directory);
    const state = await this.store.load();
    const defaults: Settings = {
      dailyRoot: 'Daily Notes', startDate: today(),
      cloudFolder: 'Obsidian Daily Notes', rmapiPath: path.join(this.pluginDirectory, 'bin', 'rmapi.exe'),
      ollamaUrl: 'http://localhost:11434', model: 'gemma4:26b', paused: true, automatic: false,
      validatedKinds: [], pollSeconds: 60, manualRefresh: false,
    };
    const saved = await this.store.readText('settings.json');
    this.settings = { ...defaults, ...(saved ? JSON.parse(saved) : {}) };
    await this.saveSettings();
    const host: VaultHost = {
      writeAttachment: async (filePath, bytes) => {
        if (this.disposed) throw new Error('Plugin unloaded before attachment creation.');
        if (!/^reMarkable Attachments\/[a-f0-9]{64}\.png$/.test(filePath) || !filePath.endsWith(`${hash(bytes)}.png`)) throw new Error('Invalid drawing attachment path.');
        const folder = 'reMarkable Attachments';
        if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
        const existing = this.app.vault.getAbstractFileByPath(filePath);
        if (existing) {
          if (!(existing instanceof TFile) || hash(new Uint8Array(await this.app.vault.readBinary(existing))) !== hash(bytes)) throw new Error('Existing drawing attachment differs; it was not overwritten.');
        } else await this.app.vault.createBinary(filePath, new Uint8Array(bytes).buffer);
      },
      files: () => this.app.vault.getMarkdownFiles().map(f => f.path),
      read: async filePath => { const file = this.app.vault.getAbstractFileByPath(filePath); return file instanceof TFile ? this.app.vault.read(file) : null; },
      readSaved: async filePath => {
        if (!await this.app.vault.adapter.exists(filePath)) return null;
        return this.app.vault.adapter.read(filePath);
      },
      compareAndWrite: async (filePath, expected, next) => {
        if (this.disposed) throw new Error('Plugin unloaded before the write; retry after reopening.');
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) throw new Error('Note moved or was deleted during sync');
        await this.app.vault.process(file, current => {
          if (current !== expected) throw new Error('Note changed during sync. Retry to reconcile the new text.');
          return next;
        });
      },
      status: message => { this.lastStatus = message; this.status.setText(`rM: ${message.slice(0, 100)}`); },
    };
    const fontData = await fs.readFile(path.join(this.pluginDirectory, 'assets', 'NotoSans-Regular.ttf'));
    // Construct connection clients lazily so a mistyped setting never prevents
    // loading the settings UI needed to repair it. Snapshot settings until reload.
    const activeSettings = { ...this.settings };
    let cloudClient: RmapiTransport | undefined;
    const cloud = () => cloudClient ??= new RmapiTransport(activeSettings.rmapiPath, directory, activeSettings.cloudFolder);
    const model = () => new OllamaRecognizer(activeSettings.ollamaUrl, activeSettings.model);
    this.engine = new SyncEngine(state, () => this.settings, host, this.store,
      { list: () => cloud().list(), download: id => cloud().download(id), upload: (name, pdf) => cloud().upload(name, pdf), append: (id, expected, pdf, content) => cloud().append(id, expected, pdf, content), archive: id => cloud().archive(id), rename: (id, name) => cloud().rename(id, name), check: () => cloud().check() },
      new NoteRenderer({ fontData, resolveImage: async filePath => {
        if (!/^reMarkable Attachments\/[a-f0-9]{64}\.png$/.test(filePath)) throw new Error('Invalid drawing image path.');
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) throw new Error(`Drawing attachment missing: ${filePath}`);
        const bytes = new Uint8Array(await this.app.vault.readBinary(file));
        if (!filePath.endsWith(`${hash(bytes)}.png`)) throw new Error('Drawing attachment changed; restore the original image before publishing.');
        return bytes;
      } }),
      { check: () => model().check(), interpret: (pages, blocks, baseline) => model().interpret(pages, blocks, baseline) });
    this.addSettingTab(new DailySyncSettings(this.app, this));
    this.addRibbonIcon('tablet', 'reMarkable Daily Sync', () => this.openReviews());
    this.addCommand({ id: 'review-changes', name: 'Review tablet changes', callback: () => this.openReviews() });
    this.addCommand({ id: 'sync-now', name: 'Sync now', callback: () => void this.runSync(true) });
    this.addCommand({ id: 'refresh-tablet-layout', name: 'Refresh current note on tablet', callback: () => void this.refreshTabletLayout() });
    this.addCommand({ id: 'check-connections', name: 'Check connections', callback: () => void this.checkConnections() });
    this.addCommand({ id: 'validation-note', name: 'Create and export a disposable validation note', callback: () => void this.validationNote() });
    this.addCommand({ id: 'pause-sync', name: 'Pause / resume background sync', callback: async () => { this.settings.paused = !this.settings.paused; await this.saveSettings(); this.refreshStatus(); } });
    this.registerEvent(this.app.vault.on('modify', file => {
      if (!(file instanceof TFile) || file.extension !== 'md' || this.settings.paused) return;
      if (this.debounce) window.clearTimeout(this.debounce);
      this.debounce = window.setTimeout(() => void this.runSync(), 15000);
    }));
    this.registerEvent(this.app.vault.on('create', file => {
      if (file instanceof TFile && file.extension === 'md' && !this.settings.paused) {
        if (this.debounce) window.clearTimeout(this.debounce);
        this.debounce = window.setTimeout(() => void this.runSync(), 15000);
      }
    }));
    this.registerEvent(this.app.vault.on('rename', (file, old) => { if (file instanceof TFile) void this.engine.renamed(old, file.path).catch(e => this.report(e)); }));
    this.timer = window.setInterval(() => void this.runSync(), Math.max(15, this.settings.pollSeconds) * 1000);
    this.registerInterval(this.timer);
    this.refreshStatus();
    this.app.workspace.onLayoutReady(() => { if (!this.disposed) void this.runSync(); });
  }
  onunload(): void { this.disposed = true; this.engine?.stop(); if (this.debounce) window.clearTimeout(this.debounce); }
  refreshStatus(): void { this.status.setText(`rM: ${this.settings.paused ? 'Paused' : this.lastStatus}`); }
  async saveSettings(): Promise<void> { await this.store.write('settings.json', JSON.stringify(this.settings, null, 2)); }
  async connectionChanged(): Promise<void> {
    this.requiresReload = true; this.engine.stop(); this.settings.paused = true;
    this.settings.automatic = false; this.settings.validatedKinds = [];
    for (const item of this.engine.state.reviews) item.canValidate = false;
    await this.store.save(this.engine.state); await this.saveSettings();
    this.lastStatus = 'Reload plugin to use changed connection settings'; this.refreshStatus();
  }
  report(error: unknown): void { const message = error instanceof Error ? error.message : String(error); this.lastStatus = message; this.status.setText(`rM: ${message.slice(0, 100)}`); new Notice(message, 10000); }
  async runSync(force = false): Promise<void> { if (this.disposed) return; if (this.requiresReload) { if (force) this.report(new Error('Reload the plugin after changing connection settings.')); return; } try { await this.engine.tick(force); } catch (e) { this.report(e); } }
  async checkConnections(): Promise<void> { try { if (this.requiresReload) throw new Error('Reload the plugin after changing connection settings.'); const result = await this.engine.check(); new Notice(result.join('\n'), 12000); } catch (e) { this.report(e); } }
  openReviews(): void { if (this.engine) new ReviewList(this.app, this).open(); }
  async refreshTabletLayout(): Promise<void> {
    try {
      if (this.requiresReload) throw new Error('Reload the plugin after changing connection settings.');
      const file = this.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') throw new Error('Open the Daily Note you want to refresh first.');
      await this.engine.refreshTablet(file.path);
      new Notice(this.settings.appendHistory ? 'Updated note appended to the existing tablet document. Earlier pages and handwriting are preserved.' : 'Tablet layout refreshed. Open the date-named PDF to continue; previous handwriting remains in Archive.', 12000);
    } catch (e) { this.report(e); }
  }
  async validationNote(): Promise<void> {
    try {
      if (this.requiresReload) throw new Error('Reload the plugin after changing connection settings.');
      const folder = 'reMarkable Sync Validation';
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
      const name = `${folder}/Validation ${Date.now()}.md`;
      await this.app.vault.create(name, '# Daily sync validation\n\nProject status is green.\n\n- [ ] Call the supplier\n\nThe meeting is on Tuesday.\n\nWrite a new entry on the blank page. Cross out green and replace it with blue. Change Tuesday to Thursday.\n');
      await this.engine.exportValidation(name);
      new Notice('Validation PDF uploaded. Annotate it on the tablet, wait for cloud sync, then use Sync now and review the result.', 15000);
    } catch (e) { this.report(e); }
  }
}

class DailySyncSettings extends PluginSettingTab {
  constructor(app: App, private plugin: DailySyncPlugin) { super(app, plugin); }
  display(): void {
    const p = this.plugin, el = this.containerEl; el.empty();
    el.createEl('h2', { text: 'reMarkable Daily Sync' });
    el.createEl('p', { text: 'Local Gemma recognition. reMarkable cloud transfers. Settings, credentials, backups, and review images stay on this Windows computer.' });
    el.createEl('p', { text: 'First pair the bundled rMAPI, check connections, and export a disposable validation note. Start with review mode. Connection-setting changes take effect after reloading this plugin.' });
    el.createEl('code', { text: p.store.directory });
    new Setting(el).setName('Pause background sync').setDesc('Sync now still performs a complete sync when paused.').addToggle(t => t.setValue(p.settings.paused).onChange(async value => { p.settings.paused = value; await p.saveSettings(); p.refreshStatus(); }));
    new Setting(el).setName('Keep tablet layout until I refresh it').setDesc('New daily notes upload automatically. Keep writing in the same PDF while handwriting imports; Obsidian changes wait for Refresh current note on tablet.').addToggle(t => t.setValue(!!p.settings.manualRefresh).onChange(async value => { p.settings.manualRefresh = value; await p.saveSettings(); }));
    new Setting(el).setName('Append updated layouts as history pages').setDesc('Append each changed note to the same tablet document. Existing pages and handwriting stay intact. Turn off manual layout refresh for automatic updates.').addToggle(t => t.setValue(!!p.settings.appendHistory).onChange(async value => { p.settings.appendHistory = value; await p.saveSettings(); }));
    new Setting(el).setName('Refresh current note on tablet').setDesc('First sync the tablet to the cloud. Publishes the current layout using your history-page setting; prior handwriting stays preserved.').addButton(b => b.setButtonText('Refresh layout').onClick(() => void p.refreshTabletLayout()));
    const text = (name: string, key: 'dailyRoot' | 'startDate' | 'cloudFolder' | 'rmapiPath' | 'ollamaUrl' | 'model', desc: string) => {
      new Setting(el).setName(name).setDesc(desc).addText(t => t.setValue(p.settings[key]).onChange(async value => {
        p.settings[key] = value.trim();
        if (['model', 'ollamaUrl', 'cloudFolder', 'rmapiPath'].includes(key)) await p.connectionChanged();
        else await p.saveSettings();
      }));
    };
    text('Daily Notes root', 'dailyRoot', 'Month subfolders must look like (10) October 2026; note names like October 11, 2026.md.');
    text('Enroll notes from', 'startDate', 'YYYY-MM-DD. Already enrolled notes continue syncing.');
    text('Tablet folder', 'cloudFolder', 'A dedicated top-level cloud folder. Reload after changing.');
    text('rMAPI executable', 'rmapiPath', 'Use the bundled, pinned Windows binary. Reload after changing.');
    text('Ollama endpoint', 'ollamaUrl', 'Loopback only. Default http://localhost:11434. Reload after changing.');
    text('Gemma model', 'model', 'Default gemma4:26b. Must be installed locally with vision support. Reload after changing.');
    new Setting(el).setName('Apply clear handwriting edits automatically').setDesc('Save recognized text edits, highlights, and drawing images automatically. Conflicts, unclear marks, and recognition warnings still require review.').addToggle(t => t.setValue(p.settings.automatic).onChange(async value => {
      p.settings.automatic = value; await p.saveSettings();
    }));
    new Setting(el).setName('Connections').addButton(b => b.setButtonText('Check').onClick(() => void p.checkConnections()));
    new Setting(el).setName('Tablet validation').addButton(b => b.setButtonText('Export test note').onClick(() => void p.validationNote()));
    new Setting(el).setName('Pending changes').addButton(b => b.setButtonText('Review').onClick(() => p.openReviews()));
    el.createEl('p', { text: 'Pairing command (run in PowerShell; the script asks for reMarkable’s one-time device code):' });
    const script = path.join(path.dirname(p.settings.rmapiPath), '..', 'scripts', 'pair-rmapi.ps1');
    el.createEl('pre', { text: `& '${script.replace(/'/g, "''")}' -StateDirectory '${p.store.directory.replace(/'/g, "''")}'` });
  }
}

class ReviewList extends Modal {
  private statusTimer?: number;
  constructor(app: App, private plugin: DailySyncPlugin) { super(app); }
  onOpen(): void {
    if (this.statusTimer !== undefined) window.clearInterval(this.statusTimer);
    this.contentEl.empty(); this.contentEl.createEl('h2', { text: 'Tablet changes' });
    const status = this.contentEl.createEl('p', { text: this.plugin.lastStatus });
    this.statusTimer = window.setInterval(() => {
      if (status.textContent !== this.plugin.lastStatus) status.setText(this.plugin.lastStatus);
    }, 500);
    if (!this.plugin.engine.state.reviews.length) this.contentEl.createEl('p', { text: 'No changes awaiting review.' });
    for (const review of this.plugin.engine.state.reviews) {
      new Setting(this.contentEl).setName(this.plugin.engine.state.notes[review.noteId].path).setDesc(review.reasons.join(' '))
        .addButton(b => b.setButtonText('Review').onClick(() => { this.close(); new EditReview(this.app, this.plugin, review).open(); }));
    }
    new Setting(this.contentEl).addButton(b => b.setButtonText('Sync now').onClick(async () => { await this.plugin.runSync(true); this.onOpen(); }));
  }
  onClose(): void {
    if (this.statusTimer !== undefined) window.clearInterval(this.statusTimer);
    this.statusTimer = undefined;
    this.contentEl.empty();
  }
}

class EditReview extends Modal {
  constructor(app: App, private plugin: DailySyncPlugin, private item: ReviewItem) { super(app); }
  onOpen(): void {
    this.modalEl.addClass('rmd-review');
    const el = this.contentEl; el.empty();
    el.createEl('h2', { text: this.plugin.engine.state.notes[this.item.noteId].path });
    el.createEl('p', { text: this.item.reasons.join('\n'), cls: 'rmd-reasons' });
    for (const [label, value] of [['Previous tablet interpretation', this.item.base], ['Current Obsidian note', this.item.current], ['New tablet interpretation', this.item.tabletText]]) {
      const details = el.createEl('details'); details.createEl('summary', { text: label }); details.createEl('pre', { text: value });
    }
    if (this.item.suggestions?.length) {
      const details = el.createEl('details'); details.createEl('summary', { text: 'Recognized edit suggestions' });
      details.createEl('pre', { text: this.item.suggestions.map(e => `Page ${e.page}, ${e.blockId}: ${e.kind}\nBefore: ${e.before}\nAfter: ${e.after}\n${e.reason}`).join('\n\n') });
    }
    el.createEl('h3', { text: 'Text to save in Obsidian' });
    el.createEl('p', { text: 'Review the complete result below. For conflicts or unreadable marks, reconcile the text here using the original page images before accepting.' });
    const editor = el.createEl('textarea', { cls: 'rmd-editor' }); editor.value = this.item.proposed; editor.rows = 18;
    const buttons = new Setting(el);
    const apply = async (action: 'accept' | 'reject', validate = false) => {
      try {
        if (this.plugin.requiresReload) throw new Error('Reload the plugin after changing connection settings.');
        if (validate && editor.value !== this.item.proposed) throw new Error('A corrected result cannot validate recognition. Use Accept text, then validate a new uncorrected sample.');
        const result = await this.plugin.engine.review(this.item.id, action, editor.value);
        if (validate && result.canValidate) {
          this.plugin.settings.validatedKinds = [...new Set([...this.plugin.settings.validatedKinds, ...result.kinds])];
          await this.plugin.saveSettings();
        }
        new Notice(action === 'accept' ? 'Changes saved. A fresh tablet revision will publish on the next sync.' : 'Tablet changes rejected; the original is preserved.'); this.close();
      } catch (e) { this.plugin.report(e); }
    };
    buttons.addButton(b => b.setButtonText('Accept text').setCta().onClick(() => void apply('accept')));
    if (this.item.canValidate) buttons.addButton(b => b.setButtonText('Accept & validate pattern').onClick(() => void apply('accept', true)));
    buttons.addButton(b => b.setButtonText('Reject changes').onClick(() => void apply('reject')));
    buttons.addButton(b => b.setButtonText('Refresh current note').onClick(async () => {
      try { await this.plugin.engine.refreshReview(this.item.id); this.onOpen(); } catch (e) { this.plugin.report(e); }
    }));
    el.createEl('h3', { text: 'Original tablet pages' });
    for (const name of this.item.images) {
      const img = el.createEl('img', { cls: 'rmd-page' });
      void this.plugin.store.read(name).then(bytes => { img.src = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`; }).catch(e => this.plugin.report(e));
    }
  }
  onClose(): void { this.contentEl.empty(); }
}
