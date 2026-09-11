import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildState, readState, writeState } from '../src/state.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'error-triage-state-'));
});

describe('state', () => {
  it('returns undefined when the file does not exist', async () => {
    expect(await readState(join(dir, 'missing.json'))).toBeUndefined();
  });

  it('round-trips through disk', async () => {
    const path = join(dir, 'state.json');
    const state = buildState(['b', 'a', 'b'], new Date('2026-09-11T07:00:00Z'));
    await writeState(path, state);
    expect(await readState(path)).toEqual({
      updatedAt: '2026-09-11T07:00:00.000Z',
      fingerprints: ['a', 'b'],
    });
  });

  it('ignores a corrupt or foreign file instead of crashing the run', async () => {
    const corrupt = join(dir, 'corrupt.json');
    await writeFile(corrupt, '{not json');
    expect(await readState(corrupt)).toBeUndefined();

    const foreign = join(dir, 'foreign.json');
    await writeFile(foreign, JSON.stringify({ something: 'else' }));
    expect(await readState(foreign)).toBeUndefined();
  });
});
