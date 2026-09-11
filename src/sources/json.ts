import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { ErrorSource, FetchOptions, RawError } from './types.js';
import { rawErrorSchema, SourceError } from './types.js';

const fileSchema = z.array(rawErrorSchema);

/**
 * Reads errors from a JSON array file. Used by the demo, by tests, and as an
 * escape hatch for any source that can export JSON.
 */
export class JsonFileSource implements ErrorSource {
  readonly name = 'json';

  constructor(private readonly path: string) {}

  async fetch({ since }: FetchOptions): Promise<RawError[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      throw new SourceError(this.name, `cannot read ${this.path}: ${String(error)}`);
    }

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      throw new SourceError(this.name, `${this.path} is not valid JSON: ${String(error)}`);
    }

    const parsed = fileSchema.safeParse(data);
    if (!parsed.success) {
      throw new SourceError(
        this.name,
        `${this.path} has invalid records:\n${z.prettifyError(parsed.error)}`,
      );
    }

    const cutoff = since.getTime();
    return parsed.data.filter((error) => new Date(error.timestamp).getTime() >= cutoff);
  }
}
