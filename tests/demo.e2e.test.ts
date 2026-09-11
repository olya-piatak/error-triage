import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';
import { StubLLM } from '../src/llm/client.js';
import { fingerprint } from '../src/normalize.js';
import { runPipeline } from '../src/pipeline.js';
import { JsonFileSource } from '../src/sources/json.js';
import { buildState, writeState } from '../src/state.js';
import { FIXTURE_PATH } from './helpers.js';

/** Captures stdout while silencing the progress log on stderr. */
function captureConsole() {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  return () => out.join('\n');
}

beforeEach(() => {
  // Any network access is a bug in demo/tests: make it fail loudly.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('network access attempted');
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pipeline on fixture data with the stub model', () => {
  it('groups 25 raw errors into 9 issues and renders both outputs', async () => {
    const result = await runPipeline({
      source: new JsonFileSource(FIXTURE_PATH),
      llm: new StubLLM(),
      since: new Date(0),
      windowLabel: '24h',
      maxGroups: 15,
      timezone: 'UTC',
      now: new Date('2026-09-11T07:00:00Z'),
    });

    expect(result.errors).toHaveLength(25);
    expect(result.groups).toHaveLength(9);
    expect(result.groups.map((g) => g.count)).toEqual([6, 5, 4, 3, 2, 2, 1, 1, 1]);
    expect(result.triage.items).toHaveLength(9);
    expect(result.model.totals.bySeverity).toEqual({ P1: 4, P2: 2, P3: 3 });

    expect(result.markdown).toContain('# Error triage — 2026-09-11 07:00 UTC (last 24h)');
    expect(result.markdown).toContain('25 occurrences in 9 groups');
    expect(result.markdown.match(/^## P1 — /gm)).toHaveLength(4);
    expect(result.slack.blocks).toHaveLength(4 + 9);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('respects MAX_GROUPS', async () => {
    const result = await runPipeline({
      source: new JsonFileSource(FIXTURE_PATH),
      llm: new StubLLM(),
      since: new Date(0),
      windowLabel: '24h',
      maxGroups: 3,
      timezone: 'UTC',
    });
    expect(result.groups).toHaveLength(3);
    expect(result.model.totals.groups).toBe(3);
  });
});

describe('CLI', () => {
  it('`demo` prints a Markdown report with zero configuration', async () => {
    const output = captureConsole();
    const code = await main(['demo']);

    expect(code).toBe(0);
    const text = output();
    expect(text).toMatch(/^# Error triage — \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(last 24h\)/);
    expect(text).toContain('Source: json · 25 occurrences in 9 groups');
    expect(text).toContain("## P2 — Cannot read properties of undefined (reading 'items')");
    expect(text).toContain('## P1 — connect ECONNREFUSED 10.0.3.17:6379');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('`demo --out` also writes the report to a file', async () => {
    captureConsole();
    const dir = await mkdtemp(join(tmpdir(), 'error-triage-demo-'));
    const out = join(dir, 'report.md');
    expect(await main(['demo', '--out', out])).toBe(0);
    expect(await readFile(out, 'utf8')).toContain('# Error triage');
  });

  it('`run --dry-run` uses env config, marks NEW groups from the state file and posts nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'error-triage-run-'));
    const statePath = join(dir, 'state.json');
    const fixture = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as Array<{
      message: string;
      stack?: string;
    }>;
    const known = fingerprint(fixture[0]!);
    await writeState(statePath, buildState([known], new Date('2026-09-10T07:00:00Z')));

    vi.stubEnv('SOURCE', 'json');
    vi.stubEnv('JSON_PATH', FIXTURE_PATH);
    vi.stubEnv('LLM_PROVIDER', 'stub');
    vi.stubEnv('STATE_PATH', statePath);
    vi.stubEnv('SLACK_WEBHOOK_URL', '');

    const output = captureConsole();
    const code = await main(['run', '--dry-run', '--since', '3650d']);

    expect(code).toBe(0);
    const text = output();
    expect(text).toContain('8 new since last run');
    expect(text).toContain("## P2 — Cannot read properties of undefined (reading 'items')\n");
    expect(text).toContain('## P1 — connect ECONNREFUSED 10.0.3.17:6379 **NEW**');
    expect(text).toContain('"blocks"');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('`run` without --dry-run refuses to start when the webhook is missing', async () => {
    vi.stubEnv('LLM_PROVIDER', 'stub');
    vi.stubEnv('SLACK_WEBHOOK_URL', '');
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(await main(['run'])).toBe(1);
    expect(errors.join('\n')).toContain('SLACK_WEBHOOK_URL is required unless --dry-run');
  });

  it('rejects a malformed --since', async () => {
    vi.stubEnv('LLM_PROVIDER', 'stub');
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    expect(await main(['run', '--dry-run', '--since', 'yesterday'])).toBe(1);
    expect(errors.join('\n')).toContain('--since must look like');
  });

  it('prints usage for unknown commands', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    expect(await main(['frobnicate'])).toBe(1);
    expect(errors.join('\n')).toContain('Usage:');
  });
});
