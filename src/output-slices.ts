const MAX_LOG_BYTES = 50 * 1024 * 1024;
const MAX_SLICE_BYTES = 65_536;
const MAX_DIAGNOSTICS = 20;
const MAX_DIAGNOSTIC_CHARS = 512;
const MAX_PARSE_CHARS = 2 * 1024 * 1024;

export interface OutputSlice {
  data: Buffer;
  offset: number;
  nextOffset: number | null;
  complete: boolean;
  totalBytes: number | null;
}

/**
 * Read a byte window without buffering the skipped prefix or the rest of a log.
 * Completion and totalBytes come from EOF, never from Content-Length. A larger
 * log can be paged up to the limit, but cannot be represented as complete there.
 */
export async function readOutputSlice(response: Response, offset: number, length: number): Promise<OutputSlice> {
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_LOG_BYTES) {
    throw new Error('Log offset must be an integer from 0 to 52428800 bytes.');
  }
  if (!Number.isInteger(length) || length < 1 || length > MAX_SLICE_BYTES) {
    throw new Error('Log length must be an integer from 1 to 65536 bytes.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Unable to read compile log (HTTP ${response.status}).`);
  }
  if (!response.body) return { data: Buffer.alloc(0), offset, nextOffset: null, complete: true, totalBytes: 0 };

  const windowLength = Math.min(length, MAX_LOG_BYTES - offset);
  const end = offset + windowLength;
  const header = response.headers.get('content-length');
  const hintedSize = header && /^\d{1,16}$/.test(header) ? Number(header) : NaN;
  // The hint only reduces an initial allocation. A short or false hint cannot
  // truncate the result or make us report EOF prematurely.
  const capacity = Number.isSafeInteger(hintedSize)
    ? Math.min(windowLength, Math.max(0, hintedSize - offset))
    : windowLength;
  let data = Buffer.alloc(capacity);
  let captured = 0;
  let observed = 0;
  let ended = false;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); }
  catch { throw new Error('Unable to read compile log stream.'); }
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        ended = true;
        return { data: data.subarray(0, captured), offset, nextOffset: null, complete: true, totalBytes: observed };
      }
      if (!(result.value instanceof Uint8Array)) throw new Error('Invalid log stream.');
      const chunk = result.value;
      const start = observed;
      observed += chunk.byteLength;
      const from = Math.max(0, offset - start);
      const to = Math.min(chunk.byteLength, end - start);
      if (to > from) {
        if (captured + to - from > data.length) {
          const expanded = Buffer.alloc(windowLength);
          data.copy(expanded, 0, 0, captured);
          data = expanded;
        }
        data.set(chunk.subarray(from, to), captured);
        captured += to - from;
      }
      // One byte of lookahead proves this is not the final window, even when
      // the server's Content-Length is missing, stale, or compressed.
      if (observed > end) {
        if (end === MAX_LOG_BYTES) throw new LogLimitError();
        return { data: data.subarray(0, captured), offset, nextOffset: offset + captured, complete: false, totalBytes: null };
      }
    }
  } catch (error) {
    if (error instanceof LogLimitError) throw error;
    // Transport exceptions can contain URLs, cookies, or response content.
    throw new Error('Unable to read compile log stream.');
  } finally {
    if (!ended) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

class LogLimitError extends Error {
  constructor() { super('Compile log exceeds the 52428800-byte readable limit.'); }
}

export interface LogDiagnostics {
  errors: Array<{ message: string; file?: string; line?: number }>;
  warnings: string[];
}

function boundedMessage(value: string): string {
  return value.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, MAX_DIAGNOSTIC_CHARS);
}

/** Best-effort diagnostics from a bounded log excerpt; an empty result is not proof of a clean compile. */
export function parseDiagnostics(log: string): LogDiagnostics {
  const errors: LogDiagnostics['errors'] = [];
  const warnings: string[] = [];
  const excerpt = log.slice(0, MAX_PARSE_CHARS);
  const limit = excerpt.length;
  let cursor = 0;
  let pendingError: LogDiagnostics['errors'][number] | undefined;
  let pendingLines = 0;
  while (cursor < limit && (errors.length < MAX_DIAGNOSTICS || warnings.length < MAX_DIAGNOSTICS)) {
    const newline = excerpt.indexOf('\n', cursor);
    const end = newline < 0 ? limit : Math.min(newline, limit);
    // Bound work per line before regular expressions or copying the message.
    const line = excerpt.slice(cursor, Math.min(end, cursor + 2048)).trim();
    cursor = end + 1;
    const location = /^(.{1,300}?):(\d{1,9}):\s*(.+)$/.exec(line);
    const warning = /^(?:LaTeX(?: Font)?|Package\s+\S+|Class\s+\S+)\s+Warning\b/i.test(location?.[3] ?? line)
      || /^(?:Overfull|Underfull) \\[hv]box\b/.test(line);
    if (warning) {
      if (warnings.length < MAX_DIAGNOSTICS) warnings.push(boundedMessage(line));
    } else if (location || line.startsWith('!') || /^LaTeX Error:/.test(line)) {
      pendingError = undefined;
      if (errors.length < MAX_DIAGNOSTICS) {
        const error: LogDiagnostics['errors'][number] = { message: boundedMessage(location?.[3] ?? line.replace(/^!\s*/, '')) };
        if (location) { error.file = boundedMessage(location[1]); error.line = Number(location[2]); }
        errors.push(error);
        if (!location) { pendingError = error; pendingLines = 4; }
      }
    } else if (pendingError && pendingLines-- > 0) {
      const number = /^l\.(\d{1,9})\b/.exec(line);
      if (number) { pendingError.line = Number(number[1]); pendingError = undefined; }
    } else {
      pendingError = undefined;
    }
  }
  return { errors, warnings };
}
