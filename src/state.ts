import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * Persists the fingerprints seen on the previous run so the next report
 * can mark groups that are new. Lives in a small JSON file so the pipeline
 * has no database dependency.
 */
const stateSchema = z.object({
  updatedAt: z.string().datetime({ offset: true }),
  fingerprints: z.array(z.string()),
});

export type TriageState = z.infer<typeof stateSchema>;

export const DEFAULT_STATE_PATH = '.triage-state.json';

/** Returns undefined when the file does not exist or cannot be parsed. */
export async function readState(path: string): Promise<TriageState | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = stateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function writeState(path: string, state: TriageState): Promise<void> {
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function buildState(fingerprints: Iterable<string>, now: Date): TriageState {
  return { updatedAt: now.toISOString(), fingerprints: [...new Set(fingerprints)].sort() };
}
