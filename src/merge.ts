import { diffChars } from 'diff';
import type { CandidateResult, Interpretation, MergeResult, SourceBlock } from './contracts';

interface Change { start: number; end: number; text: string }
const overlaps = (a: Change, b: Change): boolean => {
  if (a.start === a.end || b.start === b.end) return a.start <= b.end && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
};
function apply(base: string, changes: Change[]): string {
  let text = base;
  for (const c of [...changes].sort((a, b) => b.start - a.start)) text = text.slice(0, c.start) + c.text + text.slice(c.end);
  return text;
}

export function handwritingText(text: string): string {
  // Preserve semantic structure; only join physical line wraps within an item.
  if (/^\s*\|.*\|\s*$/m.test(text) && /^\s*\|?\s*:?-{3,}/m.test(text)) return text;
  const lines = text.replace(/\r\n?/g, '\n')
    .replace(/[ \t]*☐[ \t]*/g, '\n- [ ] ')
    .replace(/[ \t]*[☑☒][ \t]*/g, '\n- [x] ').trim().split('\n');
  const result: string[] = [];
  for (const line of lines) {
    const value = line.trim();
    if (!value) { if (result.length && result.at(-1) !== '') result.push(''); continue; }
    const structural = /^(?:[-+*]\s+|\d+[.)]\s+|#{1,6}\s+|>\s*)/.test(value);
    if (structural || !result.length || result.at(-1) === '') result.push(value);
    else result[result.length - 1] += ' ' + value;
  }
  return result.join('\n').trim().replace(/\n{2,}(?=- \[[ xX]\])/g, '\n');
}

/** Every edit is anchored to an exact source substring, never to OCR of printed text. */
export function buildCandidate(baseline: string, blocks: SourceBlock[], interpretation: Interpretation): CandidateResult {
  const errors = [...interpretation.warnings];
  const changes: Change[] = [];
  const kinds: CandidateResult['kinds'] = [];
  for (const edit of interpretation.edits) {
    const matches = blocks.filter(b => b.id === edit.blockId);
    const block = matches[0];
    if (matches.length !== 1 || !block || block.page !== edit.page || block.start < 0 || block.end < block.start || block.end > baseline.length || baseline.slice(block.start, block.end) !== block.markdown) {
      errors.push(`Invalid source block ${edit.blockId}.`); continue;
    }
    if (edit.ambiguous) { errors.push(`Ambiguous handwriting: ${edit.reason}`); continue; }
    const index = block.markdown.indexOf(edit.before);
    if (!edit.before && (edit.kind !== 'insert' || block.markdown !== '' || block.start !== block.end)) {
      errors.push('An unanchored insertion requires an empty writing block.'); continue;
    }
    if (edit.before && (index < 0 || block.markdown.indexOf(edit.before, index + 1) !== -1)) {
      errors.push('The edited passage is missing or occurs more than once in its source block.'); continue;
    }
    if ((edit.kind === 'delete' && (!edit.before || edit.after !== '')) ||
        (edit.kind === 'replace' && (!edit.before || !edit.after)) ||
        (edit.kind === 'insert' && (!edit.after || (edit.before && !(edit.after.startsWith(edit.before) || edit.after.endsWith(edit.before)))))) {
      errors.push('Edit kind does not match the proposed source change.'); continue;
    }
    if (edit.before === edit.after) continue;
    let change = { start: block.start + index, end: block.start + index + edit.before.length, text: edit.after };
    if (edit.kind === 'insert') {
      const suffix = !edit.before || edit.after.startsWith(edit.before);
      let added = edit.before ? (suffix ? edit.after.slice(edit.before.length) : edit.after.slice(0, -edit.before.length)) : edit.after;
      if (block.id === 'append') added = added.replace(/^\s*Additional handwritten notes\s*(?:\r?\n|$)/i, '');
      const normalized = handwritingText(added);
      if (!normalized) continue;
      const at = suffix ? change.end : change.start;
      const separation = /\r?\n/.test(added) || !edit.before;
      const boundary = edit.before ? (/^\s*/.exec(added)![0].includes('\n') ? /^\s*/.exec(added)![0] : '\n\n') : '\n\n';
      change = { start: at, end: at, text: suffix ? (separation && at > 0 ? boundary : added.startsWith(' ') ? ' ' : '') + normalized : normalized + (separation ? '\n\n' : added.endsWith(' ') ? ' ' : '') };
      const shared = changes.find(c => c.start === at && c.end === at);
      if (shared) { if (shared.text.trim() !== change.text.trim()) shared.text = shared.text.trimEnd() + '\n\n' + change.text.trim(); kinds.push(edit.kind); continue; }
    } else if (edit.kind === 'replace') change.text = handwritingText(edit.after);
    if (changes.some(c => overlaps(c, change))) { errors.push('Handwriting proposals overlap.'); continue; }
    changes.push(change); kinds.push(edit.kind);
  }
  return { text: errors.length ? baseline : apply(baseline, changes), errors, kinds: [...new Set(kinds)] };
}

function changesFrom(base: string, target: string): Change[] | undefined {
  const diff = diffChars(base, target, { timeout: 1500, maxEditLength: 20000 });
  if (!diff) return undefined;
  const changes: Change[] = [];
  let offset = 0;
  let pending: Change | undefined;
  for (const part of diff) {
    if (!part.added && !part.removed) {
      if (pending) { changes.push(pending); pending = undefined; }
      offset += part.value.length;
    } else {
      pending ??= { start: offset, end: offset, text: '' };
      if (part.removed) { offset += part.value.length; pending.end = offset; }
      else pending.text += part.value;
    }
  }
  if (pending) changes.push(pending);
  return changes;
}

/** Conflicts retain the entire current document; the review UI resolves them explicitly. */
export function mergeThreeWay(base: string, current: string, incoming: string): MergeResult {
  if (current === incoming || incoming === base) return { text: current, conflicts: [] };
  if (current === base) return { text: incoming, conflicts: [] };
  if (Math.max(base.length, current.length, incoming.length) > 200000) return { text: current, conflicts: ['Document exceeds the automatic merge size limit.'] };
  const local = changesFrom(base, current), remote = changesFrom(base, incoming);
  if (!local || !remote) return { text: current, conflicts: ['Source changes are too large for a bounded automatic merge.'] };
  const combined = [...local];
  for (const change of remote) {
    if (local.some(c => c.start === change.start && c.end === change.end && c.text === change.text)) continue;
    const localAppend = combined.find(c => c.start === base.length && c.end === base.length);
    if (change.start === base.length && change.end === base.length && localAppend && /^\s*\n/.test(change.text) && /^\s*\n/.test(localAppend.text)) {
      if (!localAppend.text.includes(change.text.trim())) localAppend.text = localAppend.text.trimEnd() + '\n\n' + change.text.trim();
      continue;
    }
    if (local.some(c => overlaps(c, change))) return { text: current, conflicts: ['Obsidian and tablet edits overlap or share an insertion boundary.'] };
    combined.push(change);
  }
  return { text: apply(base, combined), conflicts: [] };
}
