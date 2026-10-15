import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zipSync } from 'fflate';
const prefix = 'remarkable-daily-sync/';
const files = {};
async function include(relative) {
  const entries = await readdir(relative, { withFileTypes: true });
  for (const item of entries) {
    const child = path.join(relative, item.name);
    if (item.isDirectory()) await include(child);
    else files[prefix + child.replaceAll('\\', '/')] = new Uint8Array(await readFile(child));
  }
}
for (const name of ['main.js', 'manifest.json', 'styles.css', 'README.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'esbuild.config.mjs']) files[prefix + name] = new Uint8Array(await readFile(name));
for (const folder of ['src', 'tests', 'scripts', 'bin', 'licenses']) await include(folder);
for (const file of ['NotoSans-Regular.ttf', 'FONT-LICENSE.txt']) files[prefix + 'assets/' + file] = new Uint8Array(await readFile('assets/' + file));
const output = path.resolve('..', 'remarkable-daily-sync-0.1.0.zip');
await writeFile(output, zipSync(files, { level: 6 }));
console.log(output);
