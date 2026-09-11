import { z } from 'zod';
import type { ErrorSource, FetchLike, FetchOptions, RawError } from './types.js';
import { SourceError } from './types.js';

export interface PostHogOptions {
  host: string;
  projectId: string;
  /** Personal API key with query:read scope. */
  apiKey: string;
  limit?: number;
  fetchFn?: FetchLike;
}

/** Columns are aliased so the row mapper does not depend on property paths. */
export const POSTHOG_COLUMNS = [
  'uuid',
  'timestamp',
  'distinct_id',
  'exception_type',
  'exception_message',
  'exception_stack',
  'exception_list',
  'current_url',
  'lib',
  'browser',
] as const;

export function buildHogQL(limit: number): string {
  return [
    'SELECT uuid, timestamp, distinct_id,',
    '  properties.$exception_type AS exception_type,',
    '  properties.$exception_message AS exception_message,',
    '  properties.$exception_stack_trace_raw AS exception_stack,',
    '  properties.$exception_list AS exception_list,',
    '  properties.$current_url AS current_url,',
    '  properties.$lib AS lib,',
    '  properties.$browser AS browser',
    'FROM events',
    "WHERE event = '$exception' AND timestamp >= toDateTime({since})",
    `ORDER BY timestamp DESC LIMIT ${limit}`,
  ].join('\n');
}

const responseSchema = z.object({
  columns: z.array(z.string()),
  results: z.array(z.array(z.unknown())),
});

const exceptionListSchema = z.array(
  z.object({
    type: z.string().optional(),
    value: z.string().optional(),
    stacktrace: z
      .object({
        frames: z.array(
          z.object({
            filename: z.string().optional(),
            function: z.string().optional(),
            lineno: z.number().optional(),
            colno: z.number().optional(),
          }),
        ),
      })
      .optional(),
  }),
);

export type PostHogRow = Record<(typeof POSTHOG_COLUMNS)[number], unknown>;

/** Maps one query-result row to a RawError. Returns undefined for rows without a message. */
export function mapPostHogRow(row: PostHogRow): RawError | undefined {
  const list = parseExceptionList(row.exception_list);
  const first = list?.[0];
  const type = str(row.exception_type) ?? first?.type;
  const message = str(row.exception_message) ?? first?.value;
  if (!message) return undefined;

  const stack = str(row.exception_stack) ?? framesToStack(type, message, first);
  const timestamp = str(row.timestamp);
  const uuid = str(row.uuid);
  if (!timestamp || !uuid) return undefined;

  const tags: Record<string, string> = {};
  if (type) tags.type = type;
  const lib = str(row.lib);
  if (lib) tags.lib = lib;
  const browser = str(row.browser);
  if (browser) tags.browser = browser;

  return {
    id: uuid,
    timestamp: toIso(timestamp),
    message,
    ...(stack ? { stack } : {}),
    ...(str(row.current_url) ? { url: str(row.current_url) } : {}),
    ...(str(row.distinct_id) ? { userId: str(row.distinct_id) } : {}),
    tags,
  };
}

/**
 * Fetches `$exception` events through the PostHog query API using HogQL.
 * Works with both the legacy `$exception_message` properties and the newer
 * `$exception_list` structure.
 */
export class PostHogSource implements ErrorSource {
  readonly name = 'posthog';
  private readonly fetchFn: FetchLike;
  private readonly limit: number;

  constructor(private readonly options: PostHogOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.limit = options.limit ?? 1000;
  }

  async fetch({ since }: FetchOptions): Promise<RawError[]> {
    const url = `${this.options.host.replace(/\/+$/, '')}/api/projects/${this.options.projectId}/query`;
    const body = {
      query: {
        kind: 'HogQLQuery',
        query: buildHogQL(this.limit),
        values: { since: since.toISOString().replace('T', ' ').slice(0, 19) },
      },
    };

    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new SourceError(
        this.name,
        `query API returned ${response.status}: ${text.slice(0, 300)}`,
        response.status,
      );
    }

    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) throw new SourceError(this.name, 'unexpected query API response shape');

    const { columns, results } = parsed.data;
    const errors: RawError[] = [];
    for (const values of results) {
      const row = Object.fromEntries(columns.map((column, i) => [column, values[i]])) as PostHogRow;
      const mapped = mapPostHogRow(row);
      if (mapped) errors.push(mapped);
    }
    return errors;
  }
}

function parseExceptionList(value: unknown): z.infer<typeof exceptionListSchema> | undefined {
  if (value == null) return undefined;
  const raw = typeof value === 'string' ? safeJson(value) : value;
  const parsed = exceptionListSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function framesToStack(
  type: string | undefined,
  message: string,
  exception: z.infer<typeof exceptionListSchema>[number] | undefined,
): string | undefined {
  const frames = exception?.stacktrace?.frames;
  if (!frames?.length) return undefined;
  const lines = frames.map((f) => {
    const where = [f.filename ?? '<anonymous>', f.lineno, f.colno]
      .filter((x) => x != null)
      .join(':');
    return `    at ${f.function ?? '<anonymous>'} (${where})`;
  });
  return [`${type ?? 'Error'}: ${message}`, ...lines].join('\n');
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** HogQL returns "2026-09-10 07:12:44.120000" style timestamps in UTC; normalise to ISO. */
function toIso(timestamp: string): string {
  const date = new Date(timestamp.includes('T') ? timestamp : `${timestamp.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? timestamp : date.toISOString();
}
