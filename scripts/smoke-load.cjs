// Load exactly the CommonJS bundle Obsidian loads, without touching a vault or account.
const { readFileSync } = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const filename = path.resolve(__dirname, '..', 'main.js');
const builtinRequire = Module.createRequire(filename);
class Element {
  children = [];
  addClass() {}
  addEventListener() {}
  setText(value) { this.text = value; }
  empty() { this.children = []; }
  createEl(tag, attributes) { const child = new Element(); child.tag = tag; child.attributes = attributes; this.children.push(child); return child; }
}
class Control {
  setValue() { return this; }
  onChange() { return this; }
  setButtonText() { return this; }
  setCta() { return this; }
  onClick() { return this; }
}
class Setting {
  setName() { return this; }
  setDesc() { return this; }
  addToggle(callback) { callback(new Control()); return this; }
  addText(callback) { callback(new Control()); return this; }
  addButton(callback) { callback(new Control()); return this; }
}
class Plugin {
  commands = [];
  events = [];
  intervals = [];
  tabs = [];
  statusElement = new Element();
  addStatusBarItem() { return this.statusElement; }
  addSettingTab(tab) { this.tabs.push(tab); }
  addRibbonIcon() {}
  addCommand(command) { this.commands.push(command); }
  registerEvent(event) { this.events.push(event); }
  registerInterval(interval) { this.intervals.push(interval); }
}
class FileSystemAdapter {
  constructor(base) { this.base = base; }
  getBasePath() { return this.base; }
}
const obsidian = {
  Plugin, PluginSettingTab: class { containerEl = new Element(); }, Setting, Notice: class {},
  Modal: class {}, TFile: class {}, FileSystemAdapter, App: class {},
};
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled.require = id => {
  if (id === 'obsidian') return obsidian;
  if (id === 'node:child_process' || id === 'child_process') return {
    execFile() { throw new Error('Startup must not spawn a cloud helper'); },
    spawn() { throw new Error('Startup must not spawn any process'); },
  };
  // These native optional packages must not be needed just to load the plugin.
  if (['@napi-rs/canvas', '@resvg/resvg-js', 'sharp', 'electron'].includes(id)) throw new Error(`Unexpected eager optional import: ${id}`);
  return builtinRequire(id);
};
compiled._compile(readFileSync(filename, 'utf8'), filename);
assert.equal(typeof compiled.exports.default, 'function', 'Plugin default export is missing');
assert.ok(compiled.exports.default.prototype instanceof Plugin, 'Default export is not an Obsidian Plugin');
assert.equal(typeof compiled.exports.default.prototype.onload, 'function');
async function startupSmoke() {
  if (process.platform !== 'win32') {
    console.log('CommonJS load passed; Windows-only onload smoke skipped on this platform.');
    return;
  }
  const temporaryRoot = await fs.mkdtemp(path.join(tmpdir(), 'remarkable-plugin-smoke-'));
  const previousLocal = process.env.LOCALAPPDATA;
  const previousWindow = global.window;
  const previousFetch = global.fetch;
  let instance;
  try {
    const vault = path.join(temporaryRoot, 'fake-vault');
    const pluginDirectory = path.join(vault, '.obsidian', 'plugins', 'remarkable-daily-sync');
    await fs.mkdir(path.join(pluginDirectory, 'assets'), { recursive: true });
    await fs.copyFile(path.join(path.dirname(filename), 'assets', 'NotoSans-Regular.ttf'), path.join(pluginDirectory, 'assets', 'NotoSans-Regular.ttf'));
    process.env.LOCALAPPDATA = path.join(temporaryRoot, 'private-state');
    let timerId = 0;
    global.window = { setInterval: () => ++timerId, setTimeout: () => ++timerId, clearTimeout() {}, clearInterval() {} };
    global.fetch = async () => { throw new Error('Startup must not call a network endpoint'); };
    instance = new compiled.exports.default();
    instance.manifest = { dir: '.obsidian/plugins/remarkable-daily-sync' };
    instance.app = { workspace: { onLayoutReady: callback => callback() }, vault: {
      adapter: new FileSystemAdapter(vault),
      on: (name, callback) => ({ name, callback }),
      getMarkdownFiles: () => [],
      getAbstractFileByPath: () => null,
      process: async () => { throw new Error('Startup must not modify notes'); },
    } };
    await instance.onload();
    assert.equal(instance.settings.paused, true);
    assert.equal(instance.settings.automatic, false);
    assert.equal(instance.tabs.length, 1);
    assert.equal(instance.events.length, 3);
    assert.equal(instance.intervals.length, 1);
    assert.ok(instance.commands.some(command => command.id === 'sync-now'));
    assert.match(instance.status.text, /Paused/);
    assert.ok(instance.store.directory.startsWith(process.env.LOCALAPPDATA + path.sep));
    instance.tabs[0].display();
    assert.ok(instance.tabs[0].containerEl.children.length > 0);
    await instance.runSync(); // Paused startup must be a no-op, including cloud transport.
    await instance.saveSettings();
    assert.equal(JSON.parse(await instance.store.readText('settings.json')).paused, true);
    instance.onunload();
    await instance.runSync(true); // Disposed plugin must also be a no-op.
    console.log('Built CommonJS plugin: import, paused onload, settings UI, local settings save, and onunload passed in an isolated fake vault.');
  } finally {
    instance?.onunload();
    if (previousLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocal;
    if (previousWindow === undefined) delete global.window; else global.window = previousWindow;
    global.fetch = previousFetch;
    // Only remove the absolute directory created by mkdtemp within this smoke test.
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
startupSmoke().catch(error => { console.error(error); process.exitCode = 1; });
