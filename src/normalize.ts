import type { RawError } from './sources/types.js';

/**
 * Turns a volatile error message into a stable string so that
 * "order 8891 not found" and "order 8892 not found" collapse together.
 *
 * Replacement order matters: URLs first (so their query strings do not
 * leak digits into later passes), then structured tokens, then bare numbers.
 */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Strip query strings and fragments from URLs, keep the path.
  [/(https?:\/\/[^\s'"?#]+)[?#][^\s'"]*/gi, '$1'],
  // ISO 8601 timestamps: 2026-09-10T12:34:56.789Z, 2026-09-10 12:34:56
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?\b/g, '<ts>'],
  // UUIDs
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  // Hex hashes / ids (at least one digit, 7+ chars, e.g. git shas, chunk hashes)
  [/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, '<hex>'],
  // IPv4 addresses
  [/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>'],
  // Long mixed alphanumeric tokens (Stripe ids, session tokens, ...)
  [/\b(?=[a-z0-9_-]*\d)(?=[a-z0-9_-]*[a-z])[a-z0-9_-]{16,}\b/gi, '<id>'],
  // Any remaining numbers, including decimals and negatives
  [/-?\b\d+(\.\d+)?\b/g, '<n>'],
  // Collapse whitespace
  [/\s+/g, ' '],
];

export function normalizeMessage(message: string): string {
  let out = message;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out.trim();
}

const MAX_FRAMES = 3;

/**
 * Extracts the first N frames of a stack trace and strips line/column
 * numbers so minified builds with shifting offsets still match.
 */
export function topFrames(stack: string | undefined, limit = MAX_FRAMES): string[] {
  if (!stack) return [];
  const frames: string[] = [];
  for (const rawLine of stack.split('\n')) {
    const line = rawLine.trim();
    // V8 style ("at fn (file:1:2)") or Firefox/Safari style ("fn@file:1:2")
    if (!/^at\s|@/.test(line)) continue;
    const cleaned = line
      .replace(/^at\s+/, '')
      .replace(/:\d+:\d+(\)?)$/, '$1')
      .replace(/:\d+(\)?)$/, '$1')
      .replace(/\?[^\s)]*/g, '')
      .replace(/\([^)]*\/node_modules\/([^)]*)\)/, '(node_modules/$1)');
    frames.push(normalizeMessage(cleaned));
    if (frames.length >= limit) break;
  }
  return frames;
}

/** Stable identity of an error: normalised message plus the top frames. */
export function fingerprint(error: Pick<RawError, 'message' | 'stack'>): string {
  const parts = [normalizeMessage(error.message), ...topFrames(error.stack)];
  return parts.join(' | ');
}
