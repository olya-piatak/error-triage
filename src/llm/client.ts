import { z } from 'zod';
import type { FetchLike } from '../sources/types.js';
import type {
  ChatMessage,
  Owner,
  PromptGroup,
  Severity,
  TriageItem,
  TriageResult,
} from './prompt.js';

export interface LLM {
  readonly name: string;
  complete(messages: ChatMessage[]): Promise<string>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

export interface OpenAIClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Base delay for exponential backoff. Tests set this to 0. */
  retryDelayMs?: number;
  fetchFn?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Minimal client for any endpoint that speaks the OpenAI chat-completions
 * protocol (OpenAI, Groq, Together, Ollama, LM Studio, ...). Azure OpenAI uses
 * a different URL scheme and header and is not supported directly.
 * Non-streaming. Retries on 429 and 5xx with exponential backoff.
 */
export class OpenAICompatibleClient implements LLM {
  readonly name: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: OpenAIClientOptions) {
    this.name = `openai-compatible:${options.model}`;
    this.url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const body = JSON.stringify({ model: this.options.model, messages, temperature: 0 });
    let lastError: LLMError | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) await this.sleep(this.retryDelayMs * 2 ** (attempt - 1));
      try {
        return await this.request(body);
      } catch (error) {
        if (!(error instanceof LLMError) || !isRetryable(error.status)) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new LLMError('LLM request failed');
  }

  private async request(body: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchFn(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Local endpoints (Ollama, LM Studio) accept an empty key; skip the header then.
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // Network failures and timeouts are worth a retry; report as a 5xx-like status.
      throw new LLMError(`LLM request failed: ${String(error)}`, 599);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new LLMError(`LLM returned ${response.status}: ${text.slice(0, 500)}`, response.status);
    }

    const parsed = completionSchema.safeParse(await response.json());
    const content = parsed.success ? parsed.data.choices[0]?.message.content : undefined;
    if (!content) throw new LLMError('LLM response had no message content');
    return content;
  }
}

function isRetryable(status: number | undefined): boolean {
  return status === 429 || (status !== undefined && status >= 500);
}

/* ------------------------------------------------------------------ */
/* Stub                                                                */
/* ------------------------------------------------------------------ */

const P1_PATTERN =
  /payment|checkout|stripe|connection pool|ECONNREFUSED|ETIMEDOUT|status code 5\d\d|internal server error/i;
const BACKEND_PATTERN =
  /prisma|\bsql\b|\bjwt\b|status code 5\d\d|internal server error|\bstripe\b|payment|\.service\.|\.controller\./i;
const INFRA_PATTERN =
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|\bredis\b|\bdns\b/i;
const FRONTEND_PATTERN =
  /cannot read propert|undefined is not|is not a function|hydration|\bchunk\b|\breact\b|\.tsx|\.jsx|components\//i;
const TITLE_LIMIT = 80;

const NEXT_STEP: Record<Owner, string> = {
  frontend: 'Reproduce in the browser at the sample URL and add a guard or error boundary.',
  backend: 'Check API logs around the last occurrence and trace the failing request.',
  infra: 'Verify the upstream service is reachable and review connection limits.',
  unknown: 'Open the top example, identify the owning module and assign it.',
};

/**
 * Deterministic stand-in for a model. Used by `error-triage demo` and by
 * tests so that neither needs credentials or network access. It reads the
 * same prompt a real model would and answers with fixed rules.
 */
export class StubLLM implements LLM {
  readonly name = 'stub';

  async complete(messages: ChatMessage[]): Promise<string> {
    const user = [...messages].reverse().find((m) => m.role === 'user');
    const fenced = /```json\s*([\s\S]*?)```/.exec(user?.content ?? '');
    if (!fenced?.[1]) throw new LLMError('StubLLM: no JSON payload found in prompt');
    const payload = JSON.parse(fenced[1]) as { groups: PromptGroup[] };

    const items: TriageItem[] = payload.groups.map((group) => {
      const haystack = [group.message, group.url ?? '', ...group.frames].join('\n');
      const suggestedOwner = pickOwner(haystack);
      return {
        fingerprint: group.fingerprint,
        title: truncateAtWord(firstLine(group.message), TITLE_LIMIT),
        severity: pickSeverity(group, haystack),
        likelyCause: `Heuristic match on "${matchedToken(haystack)}" (stub model, no LLM call).`,
        suggestedOwner,
        nextStep: NEXT_STEP[suggestedOwner],
      };
    });

    const bySeverity = { P1: 0, P2: 0, P3: 0 };
    for (const item of items) bySeverity[item.severity] += 1;
    const occurrences = payload.groups.reduce((sum, g) => sum + g.count, 0);
    const result: TriageResult = {
      items,
      summary:
        `${payload.groups.length} distinct issues from ${occurrences} occurrences: ` +
        `${bySeverity.P1} P1, ${bySeverity.P2} P2, ${bySeverity.P3} P3. ` +
        'Generated by the stub model; connect an LLM for real analysis.',
    };
    return JSON.stringify(result);
  }
}

function pickOwner(haystack: string): Owner {
  if (BACKEND_PATTERN.test(haystack)) return 'backend';
  if (INFRA_PATTERN.test(haystack)) return 'infra';
  if (FRONTEND_PATTERN.test(haystack)) return 'frontend';
  return 'unknown';
}

function pickSeverity(group: PromptGroup, haystack: string): Severity {
  if (P1_PATTERN.test(haystack) || group.count >= 10 || group.affectedUsers >= 10) return 'P1';
  if (group.count >= 3 || group.affectedUsers >= 3) return 'P2';
  return 'P3';
}

function matchedToken(haystack: string): string {
  for (const pattern of [BACKEND_PATTERN, INFRA_PATTERN, FRONTEND_PATTERN]) {
    const match = pattern.exec(haystack);
    if (match) return match[0];
  }
  return 'no known pattern';
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? text;
}

function truncateAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 3);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut}...`;
}
