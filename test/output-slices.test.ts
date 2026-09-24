import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDiagnostics, readOutputSlice } from '../src/output-slices.js';

function streamingResponse(total: number, chunkSize = 1024 * 1024, headers?: Record<string, string>) {
  let emitted = 0;
  let cancelled = false;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (emitted >= total) { controller.close(); return; }
      const size = Math.min(chunkSize, total - emitted);
      controller.enqueue(new Uint8Array(size).fill(97));
      emitted += size;
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { response: new Response(stream, { headers }), state: () => ({ emitted, cancelled, pulls }) };
}

test('oversized logs remain readable in bounded pages without buffering the whole response', async () => {
  const log = streamingResponse(100 * 1024 * 1024, 4096, { 'Content-Length': String(100 * 1024 * 1024) });
  const page = await readOutputSlice(log.response, 0, 1024);
  assert.equal(page.data.length, 1024);
  assert.equal(page.data.toString(), 'a'.repeat(1024));
  assert.deepEqual({ ...page, data: undefined }, { data: undefined, offset: 0, nextOffset: 1024, complete: false, totalBytes: null });
  assert.deepEqual(log.state(), { emitted: 4096, cancelled: true, pulls: 1 });
});

test('byte offsets, arbitrary chunk boundaries, and lookahead preserve the requested window', async () => {
  const bytes = Buffer.from('aébcdefgh');
  const chunks = [bytes.subarray(0, 2), bytes.subarray(2, 4), bytes.subarray(4, 7), bytes.subarray(7)];
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()!); else controller.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  const page = await readOutputSlice(response, 1, 4);
  assert.deepEqual(page.data, bytes.subarray(1, 5));
  assert.equal(page.offset, 1);
  assert.equal(page.nextOffset, 5);
  assert.equal(page.complete, false);
  assert.equal(page.totalBytes, null);
  assert.equal(cancelled, true);
});

test('actual EOF determines completion and size, including exact windows and offsets beyond EOF', async () => {
  for (const [offset, length, expected] of [[0, 5, 'hello'], [2, 10, 'llo'], [5, 2, ''], [9, 2, '']] as const) {
    const result = await readOutputSlice(new Response('hello'), offset, length);
    assert.deepEqual(result, { data: Buffer.from(expected), offset, nextOffset: null, complete: true, totalBytes: 5 });
  }
  assert.deepEqual(await readOutputSlice(new Response(null, { status: 204 }), 0, 1), {
    data: Buffer.alloc(0), offset: 0, nextOffset: null, complete: true, totalBytes: 0,
  });
});

test('Content-Length is only an allocation hint and cannot fabricate completion or truncate content', async () => {
  for (const hint of ['0', '2', '5', '5000000000', 'bogus']) {
    const partial = await readOutputSlice(new Response('hello', { headers: { 'Content-Length': hint } }), 1, 2);
    assert.deepEqual(partial, { data: Buffer.from('el'), offset: 1, nextOffset: 3, complete: false, totalBytes: null });
    const final = await readOutputSlice(new Response('hello', { headers: { 'Content-Length': hint } }), 1, 10);
    assert.deepEqual(final, { data: Buffer.from('ello'), offset: 1, nextOffset: null, complete: true, totalBytes: 5 });
  }
});

test('unknown length requires lookahead and EOF, with cancellation only for partial reads', async () => {
  const partial = streamingResponse(5, 1);
  assert.equal((await readOutputSlice(partial.response, 0, 3)).complete, false);
  assert.deepEqual(partial.state(), { emitted: 4, cancelled: true, pulls: 4 });
  const final = streamingResponse(3, 1);
  assert.equal((await readOutputSlice(final.response, 0, 3)).complete, true);
  assert.deepEqual(final.state(), { emitted: 3, cancelled: false, pulls: 4 });
});

test('the 50 MiB boundary never reports a truncated oversized log as complete', async () => {
  const max = 50 * 1024 * 1024;
  const exact = streamingResponse(max);
  const final = await readOutputSlice(exact.response, max - 4, 16);
  assert.deepEqual(final, { data: Buffer.from('aaaa'), offset: max - 4, nextOffset: null, complete: true, totalBytes: max });
  const emptyFinal = await readOutputSlice(streamingResponse(max).response, max, 1);
  assert.equal(emptyFinal.data.length, 0);
  assert.equal(emptyFinal.complete, true);
  const over = streamingResponse(max + 1);
  await assert.rejects(readOutputSlice(over.response, max - 4, 16), /52428800-byte readable limit/);
  assert.equal(over.state().cancelled, true);
  await assert.rejects(readOutputSlice(streamingResponse(max + 1).response, max, 1), /readable limit/);
});

test('offset and length reject noninteger values, booleans, and out-of-range numbers', async () => {
  for (const offset of [-1, 0.5, NaN, Infinity, 50 * 1024 * 1024 + 1, true, false, '0', null, undefined]) {
    await assert.rejects(readOutputSlice(new Response('data'), offset as number, 1), /Log offset must be an integer/);
  }
  for (const length of [0, -1, 0.5, NaN, Infinity, 65_537, true, false, '1', null, undefined]) {
    await assert.rejects(readOutputSlice(new Response('data'), 0, length as number), /Log length must be an integer/);
  }
});

test('transport and HTTP errors stay bounded without returning response or exception content', async () => {
  const secret = 'private cookie and source text'.repeat(5000);
  const failed = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(secret)); } }));
  await assert.rejects(readOutputSlice(failed, 0, 32), error => {
    assert.equal((error as Error).message, 'Unable to read compile log stream.');
    return true;
  });
  await assert.rejects(readOutputSlice(new Response(secret, { status: 403 }), 0, 32), error => {
    assert.equal((error as Error).message, 'Unable to read compile log (HTTP 403).');
    return true;
  });
  const locked = new Response('hello');
  const heldReader = locked.body!.getReader();
  try {
    await assert.rejects(readOutputSlice(locked, 0, 32), { message: 'Unable to read compile log stream.' });
  } finally { heldReader.releaseLock(); }
});

test('a rejected cancellation does not leak errors or replace an already read page', async () => {
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.from('abcdef')); },
    cancel() { throw new Error('private transport detail'); },
  }));
  assert.equal((await readOutputSlice(response, 0, 2)).data.toString(), 'ab');
});

test('diagnostics recognize TeX errors, line markers, file-line errors, and common warnings', () => {
  const result = parseDiagnostics([
    '(./main.tex',
    '! Undefined control sequence.',
    '<recently read> \\broken',
    'l.42 \\broken{test}',
    './chapters/intro.tex:8: LaTeX Error: Missing \\begin{document}.',
    'LaTeX Warning: Reference `sec:missing` undefined on input line 20.',
    'Package hyperref Warning: Token not allowed in a PDF string.',
    'LaTeX Font Warning: Font shape unavailable.',
    './main.tex:19: LaTeX Warning: Citation undefined.',
    'Overfull \\hbox (1.0pt too wide) in paragraph at lines 5--6',
  ].join('\n'));
  assert.deepEqual(result.errors, [
    { message: 'Undefined control sequence.', line: 42 },
    { message: 'LaTeX Error: Missing \\begin{document}.', file: './chapters/intro.tex', line: 8 },
  ]);
  assert.equal(result.warnings.length, 5);
  assert.match(result.warnings[3], /Citation undefined/);
});

test('diagnostic results and individual messages are bounded and do not claim clean compilation', () => {
  const result = parseDiagnostics(Array.from({ length: 100 }, (_, index) =>
    `! Error ${index} ${'x'.repeat(10_000)}\nLaTeX Warning: Warning ${index} ${'y'.repeat(10_000)}`).join('\n'));
  assert.equal(result.errors.length, 20);
  assert.equal(result.warnings.length, 20);
  assert.ok(result.errors.every(error => error.message.length <= 512));
  assert.ok(result.warnings.every(warning => warning.length <= 512));
  assert.match(result.errors[19].message, /^Error 19 /);
  assert.deepEqual(parseDiagnostics('Output written on main.pdf (51 pages).'), { errors: [], warnings: [] });
  assert.deepEqual(parseDiagnostics(''), { errors: [], warnings: [] });
  assert.deepEqual(parseDiagnostics(`${'x'.repeat(2 * 1024 * 1024)}\n! Error outside the bounded excerpt.`), { errors: [], warnings: [] });
});

test('a distant line marker is not attributed to a preceding error', () => {
  assert.deepEqual(parseDiagnostics('! Broken macro.\n1\n2\n3\n4\n5\nl.99 unrelated'), {
    errors: [{ message: 'Broken macro.' }], warnings: [],
  });
});
