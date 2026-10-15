import { mkdir, readdir, readFile, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const modules = ['@pdf-lib/fontkit', '@pdf-lib/standard-fonts', '@pdf-lib/upng', 'pako', 'tslib', 'diff', 'fflate', 'pdf-lib', 'pdfjs-dist', 'remarkable-rm'];
await mkdir('licenses', { recursive: true });
const lines = ['JavaScript libraries bundled in main.js', 'Version details below; original license texts accompany this file.', 'The Noto Sans font license is in assets/FONT-LICENSE.txt.', 'The separate rMAPI helper and its source/licenses are in bin/.', ''];
for (const name of modules) {
  const root = path.join('node_modules', name);
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  lines.push(`${name} ${pkg.version} — ${pkg.license ?? 'see included license'} — ${typeof pkg.repository === 'object' ? pkg.repository.url : pkg.repository ?? pkg.homepage ?? ''}`);
  for (const file of await readdir(root)) {
    if (/^(LICENSE|LICENCE|COPYING|NOTICE)(\.|$)/i.test(file)) await copyFile(path.join(root, file), path.join('licenses', name.replaceAll('/', '-') + '-' + file));
  }
}
await writeFile('licenses/THIRD-PARTY.txt', lines.join('\n'));
