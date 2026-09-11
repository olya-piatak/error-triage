import { describe, expect, it, vi } from 'vitest';
import { groupErrors } from '../src/group.js';
import { LLMError, OpenAICompatibleClient, StubLLM } from '../src/llm/client.js';
import { buildMessages, parseTriageResponse } from '../src/llm/prompt.js';
import { fakeFetch, jsonResponse, makeError, textResponse } from './helpers.js';

const messages = [{ role: 'user' as const, content: 'hi' }];
const completion = (content: string) => jsonResponse({ choices: [{ message: { content } }] });

function client(fetchFn: ReturnType<typeof fakeFetch>['fn'], sleep = vi.fn(async () => undefined)) {
  return {
    sleep,
    client: new OpenAICompatibleClient({
      baseUrl: 'https://llm.example.com/v1/',
      apiKey: 'test-key',
      model: 'test-model',
      maxRetries: 2,
      retryDelayMs: 100,
      fetchFn,
      sleep,
    }),
  };
}

describe('OpenAICompatibleClient', () => {
  it('posts to /chat/completions with auth header and model', async () => {
    const fetch = fakeFetch([completion('ok')]);
    const { client: c } = client(fetch.fn);
    await expect(c.complete(messages)).resolves.toBe('ok');

    const call = fetch.calls[0]!;
    expect(call.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(call.init?.method).toBe('POST');
    expect((call.init?.headers as Record<string, string>).authorization).toBe('Bearer test-key');
    const body = JSON.parse(String(call.init?.body));
    expect(body).toMatchObject({ model: 'test-model', messages, temperature: 0 });
  });

  it('omits the authorization header when the key is empty', async () => {
    const fetch = fakeFetch([completion('ok')]);
    const c = new OpenAICompatibleClient({
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'llama3',
      fetchFn: fetch.fn,
    });
    await c.complete(messages);
    expect((fetch.calls[0]?.init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('retries on 429 and 5xx with exponential backoff', async () => {
    const fetch = fakeFetch([
      textResponse('slow down', 429),
      textResponse('oops', 503),
      completion('finally'),
    ]);
    const { client: c, sleep } = client(fetch.fn);
    await expect(c.complete(messages)).resolves.toBe('finally');
    expect(fetch.calls).toHaveLength(3);
    expect(sleep.mock.calls.map((args) => args[0])).toEqual([100, 200]);
  });

  it('gives up after maxRetries and surfaces the last status', async () => {
    const fetch = fakeFetch([
      textResponse('a', 500),
      textResponse('b', 500),
      textResponse('c', 502),
    ]);
    const { client: c } = client(fetch.fn);
    await expect(c.complete(messages)).rejects.toMatchObject({ name: 'LLMError', status: 502 });
    expect(fetch.calls).toHaveLength(3);
  });

  it('does not retry client errors', async () => {
    const fetch = fakeFetch([textResponse('bad request', 400)]);
    const { client: c, sleep } = client(fetch.fn);
    await expect(c.complete(messages)).rejects.toBeInstanceOf(LLMError);
    expect(fetch.calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries network failures', async () => {
    const fetch = fakeFetch([
      () => {
        throw new TypeError('fetch failed');
      },
      completion('ok'),
    ]);
    const { client: c } = client(fetch.fn);
    await expect(c.complete(messages)).resolves.toBe('ok');
  });

  it('rejects an empty completion', async () => {
    const fetch = fakeFetch([jsonResponse({ choices: [{ message: { content: null } }] })]);
    const { client: c } = client(fetch.fn);
    await expect(c.complete(messages)).rejects.toThrow(/no message content/);
  });
});

describe('StubLLM', () => {
  const groups = groupErrors(
    [
      makeError({ message: 'connect ECONNREFUSED 10.0.3.17:6379', url: '/api/checkout' }),
      makeError({ message: "Cannot read properties of undefined (reading 'items')", userId: 'a' }),
      makeError({ message: "Cannot read properties of undefined (reading 'items')", userId: 'b' }),
      makeError({ message: "Cannot read properties of undefined (reading 'items')", userId: 'c' }),
      makeError({ message: 'Invalid time value' }),
    ],
    { maxGroups: 10 },
  );

  it('returns a reply that passes the strict schema with one item per group', async () => {
    const reply = await new StubLLM().complete(buildMessages(groups, '24h'));
    const result = parseTriageResponse(reply);
    expect(result.items.map((i) => i.fingerprint).sort()).toEqual(
      groups.map((g) => g.fingerprint).sort(),
    );
    expect(result.summary).toContain('stub model');
  });

  it('applies fixed heuristics for owner and severity', async () => {
    const result = parseTriageResponse(await new StubLLM().complete(buildMessages(groups, '24h')));
    const byTitle = Object.fromEntries(result.items.map((i) => [i.title, i]));
    expect(byTitle['connect ECONNREFUSED 10.0.3.17:6379']).toMatchObject({
      severity: 'P1',
      suggestedOwner: 'infra',
    });
    expect(byTitle["Cannot read properties of undefined (reading 'items')"]).toMatchObject({
      severity: 'P2',
      suggestedOwner: 'frontend',
    });
    expect(byTitle['Invalid time value']).toMatchObject({
      severity: 'P3',
      suggestedOwner: 'unknown',
    });
  });

  it('is deterministic', async () => {
    const stub = new StubLLM();
    const prompt = buildMessages(groups, '24h');
    expect(await stub.complete(prompt)).toBe(await stub.complete(prompt));
  });

  it('fails loudly when the prompt carries no payload', async () => {
    await expect(new StubLLM().complete(messages)).rejects.toBeInstanceOf(LLMError);
  });
});
