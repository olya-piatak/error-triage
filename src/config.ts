import { z } from 'zod';

/**
 * Environment is the only configuration surface. Everything is validated
 * up front so a misconfigured cron job fails fast with a readable message
 * instead of half-way through a run.
 */
const envSchema = z.object({
  SOURCE: z.enum(['posthog', 'sentry', 'json']).default('json'),

  JSON_PATH: z.string().default('fixtures/errors.sample.json'),

  POSTHOG_HOST: z.url().default('https://us.posthog.com'),
  POSTHOG_PROJECT_ID: z.string().optional(),
  POSTHOG_API_KEY: z.string().optional(),

  SENTRY_BASE_URL: z.url().default('https://sentry.io'),
  SENTRY_ORG: z.string().optional(),
  SENTRY_PROJECT: z.string().optional(),
  SENTRY_AUTH_TOKEN: z.string().optional(),

  LLM_PROVIDER: z.enum(['openai', 'stub']).default('openai'),
  LLM_BASE_URL: z.url().default('https://api.openai.com/v1'),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default('gpt-4o-mini'),

  SLACK_WEBHOOK_URL: z.url().optional(),

  REPORT_TIMEZONE: z.string().default('UTC').refine(isValidTimeZone, {
    message: 'must be an IANA time zone such as UTC or Europe/London',
  }),
  MAX_GROUPS: z.coerce.number().int().min(1).max(50).default(15),
  STATE_PATH: z.string().default('.triage-state.json'),
});

export type SourceConfig =
  | { kind: 'json'; path: string }
  | { kind: 'posthog'; host: string; projectId: string; apiKey: string }
  | { kind: 'sentry'; baseUrl: string; org: string; project: string; authToken: string };

export type LLMConfig =
  { provider: 'stub' } | { provider: 'openai'; baseUrl: string; apiKey: string; model: string };

export interface Config {
  source: SourceConfig;
  llm: LLMConfig;
  slackWebhookUrl?: string;
  timezone: string;
  maxGroups: number;
  statePath: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(dropEmpty(env));
  if (!parsed.success) {
    throw new ConfigError(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;

  return {
    source: sourceConfig(e),
    llm:
      e.LLM_PROVIDER === 'stub'
        ? { provider: 'stub' }
        : {
            provider: 'openai',
            baseUrl: e.LLM_BASE_URL,
            apiKey: e.LLM_API_KEY ?? '',
            model: e.LLM_MODEL,
          },
    ...(e.SLACK_WEBHOOK_URL ? { slackWebhookUrl: e.SLACK_WEBHOOK_URL } : {}),
    timezone: e.REPORT_TIMEZONE,
    maxGroups: e.MAX_GROUPS,
    statePath: e.STATE_PATH,
  };
}

type Env = z.infer<typeof envSchema>;

function sourceConfig(e: Env): SourceConfig {
  switch (e.SOURCE) {
    case 'json':
      return { kind: 'json', path: e.JSON_PATH };
    case 'posthog':
      return {
        kind: 'posthog',
        host: e.POSTHOG_HOST,
        projectId: require(e, 'POSTHOG_PROJECT_ID', 'posthog'),
        apiKey: require(e, 'POSTHOG_API_KEY', 'posthog'),
      };
    case 'sentry':
      return {
        kind: 'sentry',
        baseUrl: e.SENTRY_BASE_URL,
        org: require(e, 'SENTRY_ORG', 'sentry'),
        project: require(e, 'SENTRY_PROJECT', 'sentry'),
        authToken: require(e, 'SENTRY_AUTH_TOKEN', 'sentry'),
      };
  }
}

function require(e: Env, key: keyof Env, source: string): string {
  const value = e[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(`${key} is required when SOURCE=${source}`);
  }
  return value;
}

/** `.env` files often contain `KEY=` placeholders; treat those as unset. */
function dropEmpty(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== '') out[key] = value.trim();
  }
  return out;
}

function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
