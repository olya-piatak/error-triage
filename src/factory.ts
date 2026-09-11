import type { LLMConfig, SourceConfig } from './config.js';
import type { LLM } from './llm/client.js';
import { OpenAICompatibleClient, StubLLM } from './llm/client.js';
import { JsonFileSource } from './sources/json.js';
import { PostHogSource } from './sources/posthog.js';
import { SentrySource } from './sources/sentry.js';
import type { ErrorSource } from './sources/types.js';

/** The only place that knows about concrete source implementations. */
export function createSource(config: SourceConfig): ErrorSource {
  switch (config.kind) {
    case 'json':
      return new JsonFileSource(config.path);
    case 'posthog':
      return new PostHogSource(config);
    case 'sentry':
      return new SentrySource(config);
  }
}

export function createLLM(config: LLMConfig): LLM {
  return config.provider === 'stub' ? new StubLLM() : new OpenAICompatibleClient(config);
}
