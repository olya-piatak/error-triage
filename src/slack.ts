import type { FetchLike } from './sources/types.js';

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export interface SlackPayload {
  /** Fallback text for notifications and clients that cannot render blocks. */
  text: string;
  blocks: SlackBlock[];
}

export interface SlackOptions {
  fetchFn?: FetchLike;
  timeoutMs?: number;
}

export class SlackError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SlackError';
  }
}

/** Posts a payload to a Slack incoming webhook. Throws on non-2xx. */
export async function postToSlack(
  webhookUrl: string,
  payload: SlackPayload,
  options: SlackOptions = {},
): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  const response = await fetchFn(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new SlackError(`Slack webhook returned ${response.status}: ${body}`, response.status);
  }
}
