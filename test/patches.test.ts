import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPatchOperation, PatchError, planPatches, type PatchPlan, type TextPatch } from '../src/patches.js';

function rejects(code: string): (error: unknown) => boolean {
  return error => error instanceof PatchError && error.code === code;
}

function wellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);
}

function apply(before: string, operation: unknown[], type: 'history-ot' | 'sharejs-text-ot'): string {
  if (type === 'sharejs-text-ot') {
    let text = before;
    for (const component of operation as Array<{ p: number; d?: string; i?: string }>) {
      assert.equal(wellFormed(text.slice(0, component.p)), true);
      if (component.d !== undefined) {
        assert.equal(wellFormed(component.d), true);
        assert.equal(text.slice(component.p, component.p + component.d.length), component.d);
        text = text.slice(0, component.p) + text.slice(component.p + component.d.length);
      }
      if (component.i !== undefined) text = text.slice(0, component.p) + component.i + text.slice(component.p);
      assert.equal(wellFormed(text), true);
    }
    return text;
  }
  let cursor = 0;
  let result = '';
  for (const component of (operation[0] as { textOperation: Array<number | string> }).textOperation) {
    if (typeof component === 'string') result += component;
    else {
      assert.equal(component === 0, false);
      assert.equal(wellFormed(before.slice(cursor, cursor + Math.abs(component))), true);
      if (component > 0) result += before.slice(cursor, cursor + component);
      cursor += Math.abs(component);
    }
  }
  assert.equal(cursor, before.length);
  assert.equal(wellFormed(result), true);
  return result;
}

test('multiple distant hunks preserve original gaps in both OT formats', () => {
  const gap = '\\newcommand{\\shared}{untouched 😀}\n'.repeat(50);
  const before = `Alpha ${gap}middle ${gap}Omega`;
  const plan = planPatches(before, [{ search: 'Omega', replace: 'Ω' }, { search: 'Alpha', replace: 'Beginning α' }, { search: 'middle', replace: 'm' }]);
  assert.equal(plan.content, `Beginning α ${gap}m ${gap}Ω`);
  assert.equal(plan.changedCharacters, 5 + 11 + 6 + 1 + 5 + 1);
  assert.deepEqual(plan.ranges.map(range => before.slice(range.start, range.end)), ['Alpha', 'middle', 'Omega']);
  for (const type of ['history-ot', 'sharejs-text-ot'] as const) {
    const operation = buildPatchOperation(before, plan.ranges, type);
    assert.equal(apply(before, operation, type), plan.content);
    assert.equal(JSON.stringify(operation).includes('newcommand'), false);
  }
});

test('patches refer to the original document rather than earlier replacements', () => {
  const plan = planPatches('alpha beta gamma', [{ search: 'alpha', replace: 'beta' }, { search: 'beta', replace: 'delta' }]);
  assert.equal(plan.content, 'beta delta gamma');
  assert.throws(() => planPatches('alpha beta', [{ search: 'alpha', replace: 'created' }, { search: 'created', replace: 'again' }]), rejects('PATCH_NOT_FOUND'));
});

test('ambiguous matches include overlapping occurrences', () => {
  for (const [before, search] of [['same same', 'same'], ['aaa', 'aa'], ['ababa', 'aba'], ['😀😀😀', '😀😀']]) {
    assert.throws(() => planPatches(before!, [{ search: search!, replace: 'changed' }]), rejects('AMBIGUOUS_PATCH'));
  }
});

test('overlapping ranges are rejected while adjacent ranges remain valid', () => {
  assert.throws(() => planPatches('abcdef', [{ search: 'bcd', replace: 'X' }, { search: 'def', replace: 'Y' }]), rejects('OVERLAPPING_PATCHES'));
  assert.throws(() => planPatches('abcdef', [{ search: 'bcd', replace: 'X' }, { search: 'bcd', replace: 'Y' }]), rejects('OVERLAPPING_PATCHES'));
  const plan = planPatches('abcdef', [{ search: 'ab', replace: 'Q' }, { search: 'cd', replace: 'RST' }]);
  for (const type of ['history-ot', 'sharejs-text-ot'] as const) assert.equal(apply('abcdef', buildPatchOperation('abcdef', plan.ranges, type), type), 'QRSTef');
});

test('Unicode changes use correct code-unit coordinates after earlier length changes', () => {
  for (const [before, patches] of [
    ['😀 alpha 中 beta 😃', [{ search: '😀', replace: 'α' }, { search: 'beta', replace: '😀😃' }, { search: '😃', replace: 'Z' }]],
    ['first 😀 tail', [{ search: 'first', replace: '' }, { search: 'tail', replace: '尾😀' }]],
    ['a😀b😃c', [{ search: '😀', replace: '😃😄' }, { search: '😃', replace: '' }]],
    ['é\n中', [{ search: '中', replace: '文' }]],
  ] as Array<[string, TextPatch[]]>) {
    const plan = planPatches(before, patches);
    for (const type of ['history-ot', 'sharejs-text-ot'] as const) assert.equal(apply(before, buildPatchOperation(before, plan.ranges, type), type), plan.content);
  }
});

test('invalid Unicode and NUL are rejected without exposing source text', () => {
  for (const invalid of ['private\0source', 'private\uD800source', 'private\uDC00source']) {
    for (const run of [
      () => planPatches(invalid, [{ search: 'private', replace: 'x' }]),
      () => planPatches('original', [{ search: invalid, replace: 'x' }]),
      () => planPatches('original', [{ search: 'original', replace: invalid }]),
    ]) assert.throws(run, error => error instanceof PatchError && error.code === 'INVALID_PATCH' && !error.message.includes('private'));
  }
});

test('missing, empty, malformed, or no-op patches are rejected', () => {
  for (const patches of [[], [{ search: '', replace: 'x' }], [{ search: 'original', replace: 'original' }], [null], [{ search: 1, replace: 'x' }], [{ search: 'original' }], null]) {
    assert.throws(() => planPatches('original', patches as unknown as TextPatch[]), rejects('INVALID_PATCH'));
  }
  assert.throws(() => planPatches('original', [{ search: 'missing secret text', replace: 'x' }]), error => error instanceof PatchError && error.code === 'PATCH_NOT_FOUND' && !error.message.includes('secret'));
  assert.throws(() => planPatches('', [{ search: 'x', replace: 'y' }]), rejects('PATCH_NOT_FOUND'));
  assert.throws(() => planPatches('abc', [{ search: 'a', replace: 'ab' }, { search: 'b', replace: '' }]), rejects('INVALID_PATCH'));
});

test('1 through 20 hunks are accepted, 21 hunks are rejected', () => {
  const before = Array.from({ length: 21 }, (_, index) => `[${index}]`).join(' ');
  const patches = Array.from({ length: 21 }, (_, index) => ({ search: `[${index}]`, replace: `(${index})` }));
  assert.equal(planPatches(before, patches.slice(0, 20)).ranges.length, 20);
  assert.throws(() => planPatches(before, patches), rejects('INVALID_PATCH'));
});

test('short document floor permits exactly 200 deleted plus inserted code units', () => {
  assert.equal(planPatches('A rest', [{ search: 'A', replace: 'Z'.repeat(199) }]).changedCharacters, 200);
  assert.throws(() => planPatches('A rest', [{ search: 'A', replace: 'Z'.repeat(200) }]), rejects('PATCH_TOO_LARGE'));
});

test('long document budget is one quarter of original length, capped at 10000', () => {
  for (const [length, budget] of [[1000, 250], [1003, 250], [40_000, 10_000], [100_000, 10_000]]) {
    const before = `A${'x'.repeat(length! - 1)}`;
    assert.equal(planPatches(before, [{ search: 'A', replace: 'Z'.repeat(budget! - 1) }]).changedCharacters, budget);
    assert.throws(() => planPatches(before, [{ search: 'A', replace: 'Z'.repeat(budget!) }]), rejects('PATCH_TOO_LARGE'));
  }
});

test('budget is aggregate across hunks, including deletion and match context', () => {
  const before = `A${'x'.repeat(998)}B`;
  assert.throws(() => planPatches(before, [{ search: 'A', replace: 'y'.repeat(125) }, { search: 'B', replace: 'z'.repeat(125) }]), rejects('PATCH_TOO_LARGE'));
  assert.throws(() => planPatches('a'.repeat(1000), [{ search: 'a'.repeat(1000), replace: `${'a'.repeat(999)}b` }]), rejects('PATCH_TOO_LARGE'));
});

test('whole-file clearing and large truncation are rejected', () => {
  assert.throws(() => planPatches('small file', [{ search: 'small file', replace: '' }]), rejects('INVALID_PATCH'));
  assert.throws(() => planPatches('a'.repeat(1000), [{ search: 'a'.repeat(1000), replace: 'a' }]), rejects('PATCH_TOO_LARGE'));
  assert.throws(() => planPatches('abc', [{ search: 'a', replace: '' }, { search: 'bc', replace: '' }]), rejects('INVALID_PATCH'));
});

test('operation builder validates raw ranges and rejects surrogate splits', () => {
  for (const range of [
    { start: -1, end: 1, replacement: '' },
    { start: 0.5, end: 1, replacement: '' },
    { start: 3, end: 2, replacement: '' },
    { start: 0, end: 5, replacement: '' },
    { start: 1, end: 2, replacement: '' },
    { start: 2, end: 3, replacement: '' },
    { start: 0, end: 1, replacement: '\uD800' },
    null,
  ]) assert.throws(() => buildPatchOperation('a😀b', [range] as PatchPlan['ranges'], 'history-ot'), rejects('INVALID_PATCH'));
  assert.throws(() => buildPatchOperation('abc', [{ start: 0, end: 2, replacement: '' }, { start: 1, end: 3, replacement: '' }], 'history-ot'), rejects('OVERLAPPING_PATCHES'));
});

test('builder supports inverse insertion ranges and does not mutate its inputs', () => {
  const ranges = [{ start: 3, end: 3, replacement: 'Ω' }, { start: 0, end: 0, replacement: '😀' }];
  const original = structuredClone(ranges);
  for (const type of ['history-ot', 'sharejs-text-ot'] as const) {
    assert.equal(apply('abc', buildPatchOperation('abc', ranges, type), type), '😀abcΩ');
    assert.equal(apply('abc', buildPatchOperation('abc', [], type), type), 'abc');
  }
  assert.deepEqual(ranges, original);
});

test('adjacent deletion hunks yield a normalized history operation', () => {
  const before = 'ABC remainder';
  const plan = planPatches(before, [{ search: 'A', replace: '' }, { search: 'BC', replace: '' }]);
  const operation = buildPatchOperation(before, plan.ranges, 'history-ot');
  assert.deepEqual(operation, [{ textOperation: [-3, 10] }]);
  assert.equal(apply(before, operation, 'history-ot'), ' remainder');
});
