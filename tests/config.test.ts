import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('falls back to the json source and OpenAI defaults with an empty environment', () => {
    const config = loadConfig({});
    expect(config).toEqual({
      source: { kind: 'json', path: 'fixtures/errors.sample.json' },
      llm: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini',
      },
      timezone: 'UTC',
      maxGroups: 15,
      statePath: '.triage-state.json',
    });
    expect(config.slackWebhookUrl).toBeUndefined();
  });

  it('treats empty strings as unset', () => {
    const config = loadConfig({ LLM_API_KEY: '', SLACK_WEBHOOK_URL: '  ', MAX_GROUPS: '' });
    expect(config.slackWebhookUrl).toBeUndefined();
    expect(config.maxGroups).toBe(15);
  });

  it('builds a PostHog source when every field is present', () => {
    const config = loadConfig({
      SOURCE: 'posthog',
      POSTHOG_HOST: 'https://eu.posthog.com',
      POSTHOG_PROJECT_ID: '42',
      POSTHOG_API_KEY: 'phx_test',
    });
    expect(config.source).toEqual({
      kind: 'posthog',
      host: 'https://eu.posthog.com',
      projectId: '42',
      apiKey: 'phx_test',
    });
  });

  it('names the missing variable for a partially configured source', () => {
    expect(() => loadConfig({ SOURCE: 'sentry', SENTRY_ORG: 'acme' })).toThrow(
      /SENTRY_PROJECT is required when SOURCE=sentry/,
    );
    expect(() => loadConfig({ SOURCE: 'posthog' })).toThrow(ConfigError);
  });

  it('selects the stub model without any credentials', () => {
    expect(loadConfig({ LLM_PROVIDER: 'stub' }).llm).toEqual({ provider: 'stub' });
  });

  it('passes through a custom LLM endpoint and Slack webhook', () => {
    const config = loadConfig({
      LLM_BASE_URL: 'http://localhost:11434/v1',
      LLM_MODEL: 'llama3.1',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/x',
      REPORT_TIMEZONE: 'Europe/London',
      MAX_GROUPS: '7',
    });
    expect(config.llm).toMatchObject({ baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' });
    expect(config.slackWebhookUrl).toBe('https://hooks.slack.com/services/T/B/x');
    expect(config.timezone).toBe('Europe/London');
    expect(config.maxGroups).toBe(7);
  });

  it('rejects invalid values with a readable message', () => {
    expect(() => loadConfig({ SOURCE: 'datadog' })).toThrow(ConfigError);
    expect(() => loadConfig({ MAX_GROUPS: '0' })).toThrow(/MAX_GROUPS/);
    expect(() => loadConfig({ REPORT_TIMEZONE: 'Mars/Olympus' })).toThrow(/IANA time zone/);
    expect(() => loadConfig({ LLM_BASE_URL: 'not a url' })).toThrow(/LLM_BASE_URL/);
  });
});
