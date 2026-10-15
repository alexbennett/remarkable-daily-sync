// Explicit opt-in local inference smoke: synthetic image only, no vault access.
import { createCanvas } from '@napi-rs/canvas';
import { OllamaRecognizer } from '../src/recognition';
const canvas = createCanvas(700, 250), ctx = canvas.getContext('2d');
ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 700, 250);
ctx.fillStyle = '#000'; ctx.font = '28px sans-serif'; ctx.fillText('b1  Project status is green.', 40, 80);
const base = canvas.toBuffer('image/png').toString('base64');
const model = process.argv[2] ?? 'gemma4:26b';
const recognizer = new OllamaRecognizer('http://localhost:11434', model);
console.log(await recognizer.check());
const began = Date.now();
const result = await recognizer.interpret([{ page: 1, base, annotated: base, inkHash: 'synthetic' }],
  [{ id: 'b1', start: 0, end: 24, markdown: 'Project status is green.', page: 1 }], 'Project status is green.');
if (result.edits.length) throw new Error('Synthetic unchanged page unexpectedly produced edits. Keep automatic application disabled.');
console.log(JSON.stringify({ syntheticVisionSmoke: 'passed', seconds: Math.round((Date.now() - began) / 1000), warnings: result.warnings }));
