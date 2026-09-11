import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JsonFileSource } from '../src/sources/json.js';
import { buildHogQL, mapPostHogRow, PostHogSource } from '../src/sources/posthog.js';
import { mapSentryIssue, SentrySource, toStatsPeriod } from '../src/sources/sentry.js';
import { SourceError } from '../src/sources/types.js';
import { fakeFetch, FIXTURE_PATH, jsonResponse, textResponse } from './helpers.js';

describe('JsonFileSource', () => {
  it('reads and validates the bundled fixture', async () => {
    const errors = await new JsonFileSource(FIXTURE_PATH).fetch({ since: new Date(0) });
    expect(errors).toHaveLength(25);
    expect(errors[0]).toMatchObject({ id: expect.any(String), tags: expect.any(Object) });
  });

  it('filters by since', async () => {
    const errors = await new JsonFileSource(FIXTURE_PATH).fetch({
      since: new Date('2026-09-11T00:00:00Z'),
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.timestamp >= '2026-09-11')).toBe(true);
  });

  it('throws SourceError for a missing file', async () => {
    await expect(
      new JsonFileSource('/nope/missing.json').fetch({ since: new Date(0) }),
    ).rejects.toBeInstanceOf(SourceError);
  });

  it('throws SourceError for invalid records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'error-triage-'));
    const file = join(dir, 'bad.json');
    await writeFile(file, JSON.stringify([{ id: 'x', message: 'no timestamp' }]));
    await expect(new JsonFileSource(file).fetch({ since: new Date(0) })).rejects.toThrow(
      /invalid records/,
    );
  });
});

describe('PostHog', () => {
  it('builds a HogQL query against $exception events with a since placeholder', () => {
    const query = buildHogQL(500);
    expect(query).toContain("event = '$exception'");
    expect(query).toContain('toDateTime({since})');
    expect(query).toContain('LIMIT 500');
  });

  it('maps legacy $exception_* properties', () => {
    const error = mapPostHogRow({
      uuid: 'u-1',
      timestamp: '2026-09-10 07:12:44.120000',
      distinct_id: 'user-1',
      exception_type: 'TypeError',
      exception_message: 'boom',
      exception_stack: 'TypeError: boom\n    at a (b.js:1:1)',
      exception_list: null,
      current_url: 'https://e.com/x',
      lib: 'web',
      browser: 'Chrome',
    });
    expect(error).toEqual({
      id: 'u-1',
      timestamp: '2026-09-10T07:12:44.120Z',
      message: 'boom',
      stack: 'TypeError: boom\n    at a (b.js:1:1)',
      url: 'https://e.com/x',
      userId: 'user-1',
      tags: { type: 'TypeError', lib: 'web', browser: 'Chrome' },
    });
  });

  it('falls back to $exception_list and rebuilds a stack from frames', () => {
    const list = [
      {
        type: 'RangeError',
        value: 'Invalid time value',
        stacktrace: {
          frames: [{ filename: 'main.js', function: 'formatDate', lineno: 2, colno: 18 }],
        },
      },
    ];
    const error = mapPostHogRow({
      uuid: 'u-2',
      timestamp: '2026-09-10T07:12:44.120Z',
      distinct_id: null,
      exception_type: null,
      exception_message: null,
      exception_stack: null,
      exception_list: JSON.stringify(list),
      current_url: null,
      lib: null,
      browser: null,
    });
    expect(error?.message).toBe('Invalid time value');
    expect(error?.stack).toBe('RangeError: Invalid time value\n    at formatDate (main.js:2:18)');
    expect(error?.tags).toEqual({ type: 'RangeError' });
  });

  it('skips rows without a message', () => {
    expect(
      mapPostHogRow({
        uuid: 'u',
        timestamp: 't',
        distinct_id: null,
        exception_type: null,
        exception_message: null,
        exception_stack: null,
        exception_list: null,
        current_url: null,
        lib: null,
        browser: null,
      }),
    ).toBeUndefined();
  });

  it('posts a HogQLQuery and maps the columnar result', async () => {
    const fetch = fakeFetch([
      jsonResponse({
        columns: [
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
        ],
        results: [
          ['u-1', '2026-09-10 07:12:44', 'd', 'Error', 'boom', null, null, null, null, null],
        ],
      }),
    ]);
    const source = new PostHogSource({
      host: 'https://ph.example.com/',
      projectId: '42',
      apiKey: 'phx',
      fetchFn: fetch.fn,
    });
    const errors = await source.fetch({ since: new Date('2026-09-10T00:00:00Z') });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('boom');
    const call = fetch.calls[0]!;
    expect(call.url).toBe('https://ph.example.com/api/projects/42/query');
    expect((call.init?.headers as Record<string, string>).authorization).toBe('Bearer phx');
    const body = JSON.parse(String(call.init?.body));
    expect(body.query.kind).toBe('HogQLQuery');
    expect(body.query.values.since).toBe('2026-09-10 00:00:00');
  });

  it('throws SourceError on a non-2xx response', async () => {
    const fetch = fakeFetch([textResponse('forbidden', 403)]);
    const source = new PostHogSource({
      host: 'https://ph.example.com',
      projectId: '1',
      apiKey: 'k',
      fetchFn: fetch.fn,
    });
    await expect(source.fetch({ since: new Date() })).rejects.toMatchObject({
      name: 'SourceError',
      status: 403,
    });
  });
});

describe('Sentry', () => {
  const issue = {
    id: '901',
    title: 'TypeError: Cannot read properties of undefined',
    culprit: 'CartSummary(app/components/Cart)',
    level: 'error',
    count: '37',
    userCount: 12,
    firstSeen: '2026-09-09T10:00:00Z',
    lastSeen: '2026-09-10T20:00:00Z',
    permalink: 'https://sentry.io/organizations/o/issues/901/',
    metadata: {
      type: 'TypeError',
      value: "Cannot read properties of undefined (reading 'items')",
      filename: 'app/components/Cart.tsx',
      function: 'CartSummary',
    },
  };

  it('maps an issue to a pre-aggregated RawError', () => {
    const error = mapSentryIssue(issue);
    expect(error).toMatchObject({
      id: '901',
      timestamp: '2026-09-10T20:00:00Z',
      message: "TypeError: Cannot read properties of undefined (reading 'items')",
      url: issue.permalink,
      count: 37,
    });
    expect(error.stack).toContain('at CartSummary (app/components/Cart.tsx)');
    expect(error.tags).toMatchObject({
      level: 'error',
      userCount: '12',
      firstSeen: issue.firstSeen,
    });
  });

  it('converts the since window into a statsPeriod', () => {
    const now = new Date('2026-09-11T07:00:00Z');
    expect(toStatsPeriod(new Date('2026-09-10T07:00:00Z'), now)).toBe('1d');
    expect(toStatsPeriod(new Date('2026-09-09T19:00:00Z'), now)).toBe('36h');
    expect(toStatsPeriod(new Date('2026-09-11T06:59:00Z'), now)).toBe('1h');
  });

  it('calls the project issues endpoint with a bearer token', async () => {
    const fetch = fakeFetch([jsonResponse([issue])]);
    const now = new Date('2026-09-11T07:00:00Z');
    const source = new SentrySource({
      baseUrl: 'https://sentry.io',
      org: 'acme',
      project: 'shop',
      authToken: 'tok',
      fetchFn: fetch.fn,
      now: () => now,
    });
    const errors = await source.fetch({ since: new Date('2026-09-10T07:00:00Z') });

    expect(errors).toHaveLength(1);
    const url = new URL(fetch.calls[0]!.url);
    expect(url.pathname).toBe('/api/0/projects/acme/shop/issues/');
    expect(url.searchParams.get('statsPeriod')).toBe('1d');
    expect((fetch.calls[0]?.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer tok',
    );
  });

  it('drops issues last seen before the window', async () => {
    const fetch = fakeFetch([jsonResponse([{ ...issue, lastSeen: '2026-09-01T00:00:00Z' }])]);
    const source = new SentrySource({
      baseUrl: 'https://sentry.io',
      org: 'a',
      project: 'b',
      authToken: 't',
      fetchFn: fetch.fn,
    });
    expect(await source.fetch({ since: new Date('2026-09-10T00:00:00Z') })).toEqual([]);
  });

  it('throws SourceError on an unexpected response', async () => {
    const fetch = fakeFetch([jsonResponse({ detail: 'nope' })]);
    const source = new SentrySource({
      baseUrl: 'https://sentry.io',
      org: 'a',
      project: 'b',
      authToken: 't',
      fetchFn: fetch.fn,
    });
    await expect(source.fetch({ since: new Date() })).rejects.toBeInstanceOf(SourceError);
  });
});
