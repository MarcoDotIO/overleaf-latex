/** Exact, bounded edits whose coordinates always refer to the original snapshot. */
export interface TextPatch { search: string; replace: string }

export interface PatchPlan {
  content: string;
  changedCharacters: number;
  ranges: Array<{ start: number; end: number; replacement: string }>;
}

export class PatchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'PatchError';
  }
}

/** Budgets and offsets use UTF-16 code units, as do Overleaf's text OT formats. */
export function planPatches(before: string, patches: TextPatch[]): PatchPlan {
  validateText(before);
  if (!Array.isArray(patches) || patches.length < 1 || patches.length > 20) {
    throw new PatchError('INVALID_PATCH', 'Provide between 1 and 20 exact-match patches.');
  }
  const ranges: PatchPlan['ranges'] = [];
  let changedCharacters = 0;
  for (const patch of patches) {
    if (patch === null || typeof patch !== 'object') invalidPatch();
    validateText(patch.search);
    validateText(patch.replace);
    if (patch.search.length === 0) {
      throw new PatchError('INVALID_PATCH', 'Each patch must include nonempty text to find in the original document.');
    }
    if (patch.search === patch.replace) {
      throw new PatchError('INVALID_PATCH', 'Each patch must change the matched text.');
    }
    const start = before.indexOf(patch.search);
    if (start < 0) {
      throw new PatchError('PATCH_NOT_FOUND', 'A patch does not match the original document. Read the latest document and revise the patch.');
    }
    // Advance by one code unit, rather than match length, to include overlapping matches.
    if (before.indexOf(patch.search, start + 1) >= 0) {
      throw new PatchError('AMBIGUOUS_PATCH', 'A patch matches more than once. Include enough surrounding text to identify one occurrence.');
    }
    changedCharacters += patch.search.length + patch.replace.length;
    ranges.push({ start, end: start + patch.search.length, replacement: patch.replace });
  }
  ranges.sort((left, right) => left.start - right.start);
  validateRanges(before, ranges);
  const budget = Math.min(10_000, Math.max(200, Math.floor(before.length * 0.25)));
  if (changedCharacters > budget) {
    throw new PatchError('PATCH_TOO_LARGE', `This edit changes ${changedCharacters} code units; this snapshot permits at most ${budget} deleted plus inserted code units per pass.`);
  }
  let cursor = 0;
  const parts: string[] = [];
  for (const range of ranges) {
    parts.push(before.slice(cursor, range.start), range.replacement);
    cursor = range.end;
  }
  parts.push(before.slice(cursor));
  const content = parts.join('');
  if (before.length > 0 && content.length === 0) {
    throw new PatchError('INVALID_PATCH', 'A patch pass cannot clear a nonempty document.');
  }
  if (content === before) throw new PatchError('INVALID_PATCH', 'The patch pass must change the document.');
  return { content, changedCharacters, ranges };
}

/** Build a multi-hunk operation without deleting and reinserting unchanged gaps. */
export function buildPatchOperation(before: string, ranges: PatchPlan['ranges'], type: 'history-ot' | 'sharejs-text-ot'): unknown[] {
  validateText(before);
  if (type !== 'history-ot' && type !== 'sharejs-text-ot') invalidPatch();
  if (!Array.isArray(ranges)) invalidPatch();
  const ordered = [...ranges].sort((left, right) => left?.start - right?.start);
  validateRanges(before, ordered);
  if (type === 'history-ot') {
    const textOperation: Array<number | string> = [];
    let cursor = 0;
    for (const range of ordered) {
      if (range.start > cursor) appendComponent(textOperation, range.start - cursor);
      if (range.end > range.start) appendComponent(textOperation, range.start - range.end);
      if (range.replacement.length > 0) appendComponent(textOperation, range.replacement);
      cursor = range.end;
    }
    if (cursor < before.length) appendComponent(textOperation, before.length - cursor);
    return [{ textOperation }];
  }
  const operation: Array<{ p: number; d?: string; i?: string }> = [];
  let delta = 0;
  for (const range of ordered) {
    const p = range.start + delta;
    const removed = before.slice(range.start, range.end);
    if (removed.length > 0) operation.push({ p, d: removed });
    if (range.replacement.length > 0) operation.push({ p, i: range.replacement });
    delta += range.replacement.length - removed.length;
  }
  return operation;
}

function appendComponent(operation: Array<number | string>, component: number | string): void {
  const previous = operation.at(-1);
  if (typeof previous === 'number' && typeof component === 'number' && Math.sign(previous) === Math.sign(component)) {
    operation[operation.length - 1] = previous + component;
  } else if (typeof previous === 'string' && typeof component === 'string') {
    operation[operation.length - 1] = previous + component;
  } else operation.push(component);
}

function validateText(text: string): void {
  if (typeof text !== 'string' || text.includes('\0') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)) {
    throw new PatchError('INVALID_PATCH', 'Document and patch text must be valid Unicode without NUL characters.');
  }
}

function validateRanges(before: string, ranges: PatchPlan['ranges']): void {
  let previous: PatchPlan['ranges'][number] | undefined;
  for (const range of ranges) {
    if (range === null || typeof range !== 'object' || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start || range.end > before.length) invalidPatch();
    validateText(range.replacement);
    if (!isCharacterBoundary(before, range.start) || !isCharacterBoundary(before, range.end)) {
      throw new PatchError('INVALID_PATCH', 'Patch boundaries must not split Unicode characters.');
    }
    if (previous && (range.start < previous.end || range.start === previous.start)) {
      throw new PatchError('OVERLAPPING_PATCHES', 'Patches must refer to distinct, nonoverlapping ranges in the original document.');
    }
    previous = range;
  }
}

function isCharacterBoundary(text: string, offset: number): boolean {
  const code = text.charCodeAt(offset);
  return !(code >= 0xdc00 && code <= 0xdfff);
}

function invalidPatch(): never {
  throw new PatchError('INVALID_PATCH', 'Patch ranges must be valid offsets in the original document.');
}
