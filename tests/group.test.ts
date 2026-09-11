import { describe, expect, it } from 'vitest';
import { groupErrors } from '../src/group.js';
import { makeError } from './helpers.js';

const opts = { maxGroups: 10 };

describe('groupErrors', () => {
  it('merges errors that differ only by volatile ids', () => {
    const groups = groupErrors(
      [
        makeError({
          message: 'Order 1 not found',
          userId: 'u1',
          timestamp: '2026-09-10T10:00:00Z',
        }),
        makeError({
          message: 'Order 2 not found',
          userId: 'u2',
          timestamp: '2026-09-10T11:00:00Z',
        }),
        makeError({
          message: 'Order 3 not found',
          userId: 'u1',
          timestamp: '2026-09-10T09:00:00Z',
        }),
      ],
      opts,
    );
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.count).toBe(3);
    expect(group.affectedUsers).toBe(2);
    expect(group.firstSeen).toBe('2026-09-10T09:00:00Z');
    expect(group.lastSeen).toBe('2026-09-10T11:00:00Z');
    expect(group.sample.message).toBe('Order 2 not found');
  });

  it('honours the count field of pre-aggregated records', () => {
    const groups = groupErrors(
      [makeError({ message: 'x', count: 40 }), makeError({ message: 'x', count: 2 })],
      opts,
    );
    expect(groups[0]?.count).toBe(42);
  });

  it('sorts by count descending', () => {
    const groups = groupErrors(
      [
        makeError({ message: 'rare' }),
        makeError({ message: 'common' }),
        makeError({ message: 'common' }),
        makeError({ message: 'common' }),
        makeError({ message: 'medium' }),
        makeError({ message: 'medium' }),
      ],
      opts,
    );
    expect(groups.map((g) => g.sample.message)).toEqual(['common', 'medium', 'rare']);
  });

  it('caps the number of groups', () => {
    const errors = Array.from({ length: 8 }, (_, i) =>
      makeError({ message: `distinct ${'x'.repeat(i)}` }),
    );
    expect(groupErrors(errors, { maxGroups: 3 })).toHaveLength(3);
  });

  it('keeps at most three examples, oldest first', () => {
    const errors = Array.from({ length: 5 }, (_, i) =>
      makeError({ message: 'same', timestamp: `2026-09-10T1${i}:00:00Z` }),
    );
    const group = groupErrors(errors, opts)[0]!;
    expect(group.examples).toHaveLength(3);
    expect(group.examples[0]?.timestamp).toBe('2026-09-10T10:00:00Z');
    expect(group.examples[2]?.timestamp).toBe('2026-09-10T12:00:00Z');
  });

  it('returns an empty list for no input', () => {
    expect(groupErrors([], opts)).toEqual([]);
  });

  it('is deterministic regardless of input order', () => {
    const errors = [
      makeError({ message: 'a', timestamp: '2026-09-10T10:00:00Z' }),
      makeError({ message: 'b', timestamp: '2026-09-10T10:00:00Z' }),
      makeError({ message: 'a', timestamp: '2026-09-10T12:00:00Z' }),
    ];
    const forward = groupErrors(errors, opts).map((g) => g.fingerprint);
    const backward = groupErrors([...errors].reverse(), opts).map((g) => g.fingerprint);
    expect(forward).toEqual(backward);
  });
});
