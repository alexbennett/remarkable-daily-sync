import esbuild from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
await mkdir('assets', { recursive: true });
await copyFile('node_modules/remarkable-rm/fonts/NotoSans-Regular.ttf', 'assets/NotoSans-Regular.ttf');
await copyFile('node_modules/remarkable-rm/fonts/OFL.txt', 'assets/FONT-LICENSE.txt');
await esbuild.build({ entryPoints: ['src/main.ts'], outfile: 'main.js', bundle: true, format: 'cjs', platform: 'node', target: 'es2022',
  define: { 'import.meta.url': '__bundleMetaUrl' }, banner: { js: "const __bundleMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  alias: { 'remarkable-rm': path.resolve('node_modules/remarkable-rm/dist/index.cjs') },
  external: ['obsidian', 'electron', '@napi-rs/canvas', '@resvg/resvg-js', 'sharp'], mainFields: ['main', 'module'], sourcemap: false, logLevel: 'info' });
await import('./scripts/licenses.mjs');
