import { fingerprint } from './normalize.js';
import type { RawError } from './sources/types.js';

export interface ErrorGroup {
  fingerprint: string;
  /** Most recent occurrence; used for the title and top example. */
  sample: RawError;
  count: number;
  firstSeen: string;
  lastSeen: string;
  affectedUsers: number;
  /** Up to three occurrences, oldest first. */
  examples: RawError[];
}

export interface GroupOptions {
  maxGroups: number;
}

const MAX_EXAMPLES = 3;

interface Accumulator {
  fingerprint: string;
  occurrences: RawError[];
  count: number;
  users: Set<string>;
}

/**
 * Deterministically groups errors by fingerprint.
 * Output is sorted by count (desc), then lastSeen (desc), then fingerprint,
 * and capped at `maxGroups`.
 */
export function groupErrors(errors: RawError[], options: GroupOptions): ErrorGroup[] {
  const sorted = [...errors].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const buckets = new Map<string, Accumulator>();

  for (const error of sorted) {
    const key = fingerprint(error);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { fingerprint: key, occurrences: [], count: 0, users: new Set() };
      buckets.set(key, bucket);
    }
    bucket.occurrences.push(error);
    bucket.count += error.count ?? 1;
    if (error.userId) bucket.users.add(error.userId);
  }

  const groups: ErrorGroup[] = [];
  for (const bucket of buckets.values()) {
    const first = bucket.occurrences[0];
    const last = bucket.occurrences[bucket.occurrences.length - 1];
    if (!first || !last) continue;
    groups.push({
      fingerprint: bucket.fingerprint,
      sample: last,
      count: bucket.count,
      firstSeen: first.timestamp,
      lastSeen: last.timestamp,
      affectedUsers: bucket.users.size,
      examples: bucket.occurrences.slice(0, MAX_EXAMPLES),
    });
  }

  groups.sort(
    (a, b) =>
      b.count - a.count ||
      b.lastSeen.localeCompare(a.lastSeen) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );

  return groups.slice(0, Math.max(0, options.maxGroups));
}
