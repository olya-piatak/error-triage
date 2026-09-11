import { z } from 'zod';

/**
 * The one shape every source must produce. Everything downstream
 * (normalise, group, prompt, report) only ever sees RawError.
 */
export const rawErrorSchema = z.object({
  /** Source-specific identifier (event uuid, issue id, ...). */
  id: z.string().min(1),
  /** ISO 8601 timestamp of the occurrence (or lastSeen for aggregated sources). */
  timestamp: z.string().datetime({ offset: true }),
  message: z.string().min(1),
  stack: z.string().optional(),
  url: z.string().optional(),
  userId: z.string().optional(),
  tags: z.record(z.string(), z.string()).default({}),
  /** Number of occurrences this record represents. Defaults to 1. */
  count: z.number().int().positive().optional(),
});

export type RawError = z.infer<typeof rawErrorSchema>;

export interface FetchOptions {
  /** Only errors at or after this instant are returned. */
  since: Date;
}

export interface ErrorSource {
  readonly name: string;
  fetch(options: FetchOptions): Promise<RawError[]>;
}

/** Minimal fetch signature so sources and clients can be tested without the network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class SourceError extends Error {
  constructor(
    readonly source: string,
    message: string,
    readonly status?: number,
  ) {
    super(`${source}: ${message}`);
    this.name = 'SourceError';
  }
}
