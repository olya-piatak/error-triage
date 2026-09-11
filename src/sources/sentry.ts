import { z } from 'zod';
import type { ErrorSource, FetchLike, FetchOptions, RawError } from './types.js';
import { SourceError } from './types.js';

export interface SentryOptions {
  baseUrl: string;
  org: string;
  project: string;
  /** Auth token with project:read and event:read scopes. */
  authToken: string;
  limit?: number;
  fetchFn?: FetchLike;
  now?: () => Date;
}

export const sentryIssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  culprit: z.string().nullable().optional(),
  level: z.string().optional(),
  count: z.union([z.string(), z.number()]),
  userCount: z.number().optional(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  permalink: z.string().optional(),
  metadata: z
    .object({
      type: z.string().optional(),
      value: z.string().optional(),
      filename: z.string().optional(),
      function: z.string().optional(),
    })
    .optional(),
});

export type SentryIssue = z.infer<typeof sentryIssueSchema>;

/**
 * Sentry already groups events into issues, so each issue becomes one
 * RawError carrying its `count`. Our own grouping then mostly passes them
 * through, but still merges issues whose messages differ only by ids.
 */
export function mapSentryIssue(issue: SentryIssue): RawError {
  const type = issue.metadata?.type;
  const value = issue.metadata?.value ?? issue.title;
  const message = type && !value.startsWith(type) ? `${type}: ${value}` : value;
  const count = Math.max(1, Math.floor(Number(issue.count) || 1));

  const frame =
    issue.metadata?.function || issue.metadata?.filename
      ? `    at ${issue.metadata?.function ?? '<anonymous>'} (${issue.metadata?.filename ?? issue.culprit ?? 'unknown'})`
      : issue.culprit
        ? `    at ${issue.culprit}`
        : undefined;

  const tags: Record<string, string> = { firstSeen: issue.firstSeen };
  if (issue.level) tags.level = issue.level;
  if (issue.culprit) tags.culprit = issue.culprit;
  if (issue.userCount !== undefined) tags.userCount = String(issue.userCount);

  return {
    id: issue.id,
    timestamp: issue.lastSeen,
    message,
    ...(frame ? { stack: `${message}\n${frame}` } : {}),
    ...(issue.permalink ? { url: issue.permalink } : {}),
    tags,
    count,
  };
}

/** Sentry wants "24h" or "7d", not a timestamp. */
export function toStatsPeriod(since: Date, now: Date): string {
  const hours = Math.max(1, Math.ceil((now.getTime() - since.getTime()) / 3_600_000));
  return hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
}

/** Fetches unresolved issues for one project, ordered by frequency. Single page. */
export class SentrySource implements ErrorSource {
  readonly name = 'sentry';
  private readonly fetchFn: FetchLike;
  private readonly limit: number;
  private readonly now: () => Date;

  constructor(private readonly options: SentryOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.limit = options.limit ?? 100;
    this.now = options.now ?? (() => new Date());
  }

  async fetch({ since }: FetchOptions): Promise<RawError[]> {
    const { baseUrl, org, project, authToken } = this.options;
    const params = new URLSearchParams({
      statsPeriod: toStatsPeriod(since, this.now()),
      query: 'is:unresolved',
      sort: 'freq',
      limit: String(this.limit),
    });
    const url = `${baseUrl.replace(/\/+$/, '')}/api/0/projects/${org}/${project}/issues/?${params}`;

    const response = await this.fetchFn(url, {
      headers: { authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new SourceError(
        this.name,
        `issues API returned ${response.status}: ${text.slice(0, 300)}`,
        response.status,
      );
    }

    const parsed = z.array(sentryIssueSchema).safeParse(await response.json());
    if (!parsed.success) throw new SourceError(this.name, 'unexpected issues API response shape');

    const cutoff = since.getTime();
    return parsed.data
      .filter((issue) => new Date(issue.lastSeen).getTime() >= cutoff)
      .map(mapSentryIssue);
  }
}
