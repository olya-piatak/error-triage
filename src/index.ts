#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from './config.js';
import { createLLM, createSource } from './factory.js';
import { LLMError, StubLLM } from './llm/client.js';
import { TriageParseError } from './llm/prompt.js';
import { runPipeline } from './pipeline.js';
import { postToSlack, SlackError } from './slack.js';
import { JsonFileSource } from './sources/json.js';
import { SourceError } from './sources/types.js';
import { buildState, readState, writeState } from './state.js';

const USAGE = `error-triage: group production errors, prioritise them with an LLM, post to Slack

Usage:
  error-triage run  [--since 24h] [--dry-run] [--out report.md]
  error-triage demo [--out report.md]

Commands:
  run    Fetch from the configured SOURCE, triage with the configured LLM, post to Slack.
  demo   Run on bundled fixture data with the stub model. Needs no credentials or network.

Options:
  --since <window>  How far back to look: <n>m, <n>h or <n>d. Default 24h.
  --dry-run         Print the report and the Slack payload instead of posting.
  --out <file>      Also write the Markdown report to this file.
  --help            Show this help.
`;

const FIXTURE_URL = new URL('../fixtures/errors.sample.json', import.meta.url);

export function parseSince(text: string, now: Date): { since: Date; label: string } {
  const match = /^(\d+)([mhd])$/.exec(text.trim());
  if (!match) throw new ConfigError(`--since must look like 30m, 24h or 7d (got "${text}")`);
  const amount = Number(match[1]);
  const unit = match[2] as 'm' | 'h' | 'd';
  const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] * amount;
  if (amount === 0) throw new ConfigError('--since must be greater than zero');
  return { since: new Date(now.getTime() - ms), label: `${amount}${unit}` };
}

function parseCli(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      since: { type: 'string', default: '24h' },
      'dry-run': { type: 'boolean', default: false },
      out: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  return values;
}

const log = (message: string): void => console.error(`[error-triage] ${message}`);

function loadDotEnv(): void {
  if (!existsSync('.env')) return;
  try {
    process.loadEnvFile('.env');
  } catch (error) {
    log(`could not load .env: ${String(error)}`);
  }
}

async function runCommand(argv: string[]): Promise<void> {
  const flags = parseCli(argv);
  if (flags.help) return void console.log(USAGE);

  loadDotEnv();
  const config = loadConfig();
  const now = new Date();
  const { since, label } = parseSince(flags.since, now);

  if (!flags['dry-run'] && !config.slackWebhookUrl) {
    throw new ConfigError('SLACK_WEBHOOK_URL is required unless --dry-run is set');
  }

  const previous = await readState(config.statePath);
  const result = await runPipeline({
    source: createSource(config.source),
    llm: createLLM(config.llm),
    since,
    windowLabel: label,
    maxGroups: config.maxGroups,
    timezone: config.timezone,
    now,
    previousFingerprints: previous ? new Set(previous.fingerprints) : undefined,
    log,
  });

  console.log(result.markdown);
  if (flags.out) {
    await writeFile(flags.out, result.markdown, 'utf8');
    log(`wrote ${flags.out}`);
  }

  if (flags['dry-run']) {
    log(`dry run: would post ${result.slack.blocks.length} Slack blocks`);
    console.log(JSON.stringify(result.slack, null, 2));
    return;
  }

  await postToSlack(config.slackWebhookUrl as string, result.slack);
  log('posted to Slack');
  await writeState(
    config.statePath,
    buildState(
      result.groups.map((g) => g.fingerprint),
      now,
    ),
  );
  log(`saved ${result.groups.length} fingerprints to ${config.statePath}`);
}

async function demoCommand(argv: string[]): Promise<void> {
  const flags = parseCli(argv);
  if (flags.help) return void console.log(USAGE);

  const result = await runPipeline({
    source: new JsonFileSource(fileURLToPath(FIXTURE_URL)),
    llm: new StubLLM(),
    // The fixture has fixed timestamps, so the demo does not apply a cutoff.
    since: new Date(0),
    windowLabel: '24h',
    maxGroups: 15,
    timezone: 'UTC',
    log,
  });

  console.log(result.markdown);
  if (flags.out) {
    await writeFile(flags.out, result.markdown, 'utf8');
    log(`wrote ${flags.out}`);
  }
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'run':
        await runCommand(rest);
        return 0;
      case 'demo':
        await demoCommand(rest);
        return 0;
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        console.log(USAGE);
        return command === undefined ? 1 : 0;
      default:
        console.error(`Unknown command "${command}".\n\n${USAGE}`);
        return 1;
    }
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof SourceError ||
      error instanceof LLMError ||
      error instanceof TriageParseError ||
      error instanceof SlackError
    ) {
      console.error(`error-triage: ${error.message}`);
    } else {
      console.error('error-triage: unexpected failure');
      console.error(error);
    }
    return 1;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
