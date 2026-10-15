import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidate, mergeThreeWay, handwritingText } from '../src/merge';
import type { ProposedEdit, SourceBlock } from '../src/contracts';

const block = (markdown: string): SourceBlock => ({ id: 'a', start: 0, end: markdown.length, markdown, page: 1 });
const edit = (values: Partial<ProposedEdit> = {}): ProposedEdit => ({ blockId: 'a', before: 'old', after: 'new', kind: 'replace', page: 1, ambiguous: false, reason: 'clear replacement', ...values });

test('handwriting preserves task and bullet boundaries while unwrapping item text', () => {
  assert.equal(handwritingText('Personal\n\n☐ Order office supplies\n☐ Prep for weekly meeting'), 'Personal\n- [ ] Order office supplies\n- [ ] Prep for weekly meeting');
  assert.equal(handwritingText('- Discussion on\nhigh level control impl.\npigeon-holing into UAV\ncontrol VS betaflight mods\nor making PX4 work on\nthe test device\n- Lot of R&D\n- Obtain training data'), '- Discussion on high level control impl. pigeon-holing into UAV control VS betaflight mods or making PX4 work on the test device\n- Lot of R&D\n- Obtain training data');
  assert.equal(handwritingText('☑ Completed\ntask\n☐ Next task'), '- [x] Completed task\n- [ ] Next task');
});
test('replacements and strike-through deletion preserve other Markdown and CRLF', () => {
  const text = '---\r\ntitle: x\r\n---\r\n- [ ] old [[link]]\r\n';
  const result = buildCandidate(text, [block(text)], { edits: [edit()], warnings: [] });
  assert.equal(result.text, text.replace('old', 'new'));
  assert.deepEqual(result.errors, []);
  assert.equal(buildCandidate(text, [block(text)], { edits: [edit({ after: '', kind: 'delete' })], warnings: [] }).text, text.replace('old', ''));
});
test('duplicate anchors and overlapping proposals fail closed', () => {
  for (const [text, edits] of [['old old', [edit()]], ['old', [edit(), edit({ after: 'other' })]]] as const) {
    const result = buildCandidate(text, [block(text)], { edits: [...edits], warnings: [] });
    assert.equal(result.text, text); assert.ok(result.errors.length);
  }
});
test('ambiguous marks, warning, and incorrect source map never change text', () => {
  for (const input of [
    { edits: [edit({ ambiguous: true })], warnings: [] },
    { edits: [edit()], warnings: ['unreadable'] },
    { edits: [edit({ page: 2 })], warnings: [] }
  ]) assert.equal(buildCandidate('old', [block('old')], input).text, 'old');
  assert.ok(buildCandidate('old', [{ ...block('old'), markdown: 'bad' }], { edits: [edit()], warnings: [] }).errors.length);
});
test('insertions need a preserved unique anchor or an empty writing block', () => {
  assert.equal(buildCandidate('old', [block('old')], { edits: [edit({ kind: 'insert', after: 'old\naddition' })], warnings: [] }).text, 'old\naddition');
  assert.ok(buildCandidate('old', [block('old')], { edits: [edit({ kind: 'insert', before: '', after: 'addition' })], warnings: [] }).errors.length);
  assert.equal(buildCandidate('', [block('')], { edits: [edit({ kind: 'insert', before: '', after: 'addition' })], warnings: [] }).text, 'addition');
});
test('three-way merge preserves disjoint changes and line endings', () => {
  assert.deepEqual(mergeThreeWay('alpha\r\nbeta\r\ngamma', 'ALPHA\r\nbeta\r\ngamma', 'alpha\r\nbeta\r\nGAMMA'), { text: 'ALPHA\r\nbeta\r\nGAMMA', conflicts: [] });
  assert.equal(mergeThreeWay('one two three', 'ONE two three', 'one two THREE').text, 'ONE two THREE');
});
test('conflicts never overwrite the current document', () => {
  for (const [base, current, incoming] of [
    ['hello', 'HELLO', 'goodbye'], ['ab', 'aXb', 'aYb'], ['abc', 'ac', 'aXbc']
  ]) { const result = mergeThreeWay(base, current, incoming); assert.equal(result.text, current); assert.ok(result.conflicts.length); }
});
test('identical incoming changes are idempotent, including shared and disjoint edits', () => {
  assert.deepEqual(mergeThreeWay('abc', 'aXbc', 'aXbc'), { text: 'aXbc', conflicts: [] });
  assert.deepEqual(mergeThreeWay('abc\ndef\nghi', 'ABC\ndef\nghi', 'ABC\ndef\nGHI'), { text: 'ABC\ndef\nGHI', conflicts: [] });
});

test('two tablet pages append at the same boundary without replacing the anchor or desktop additions', () => {
  const base = '- [ ] Task';
  const result = buildCandidate(base, [block(base), { id: 'append', start: base.length, end: base.length, markdown: '', page: 2 }], {
    edits: [edit({kind:'insert', before:base, after:base+'\n\nPersonal\nOrder supplies'}),
      edit({kind:'insert', blockId:'append', page:2, before:'', after:'Additional handwritten notes\n\nLong handwritten\nparagraph'})], warnings:[]
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.text, base+'\n\nPersonal Order supplies\n\nLong handwritten paragraph');
  const current = '- [x] Task\n- Desktop task';
  const merged = mergeThreeWay(base, current, result.text);
  assert.deepEqual(merged.conflicts, []);
  assert.equal(merged.text, current+'\n\nPersonal Order supplies\n\nLong handwritten paragraph');
  assert.equal(mergeThreeWay(base, merged.text, result.text).text, merged.text);
});
