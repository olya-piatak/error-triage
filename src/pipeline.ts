import type { ErrorGroup } from './group.js';
import { groupErrors } from './group.js';
import type { LLM } from './llm/client.js';
import type { TriageResult } from './llm/prompt.js';
import { buildMessages, parseTriageResponse } from './llm/prompt.js';
import type { ReportModel } from './report.js';
import { buildReport, renderMarkdown, renderSlack } from './report.js';
import type { SlackPayload } from './slack.js';
import type { ErrorSource, RawError } from './sources/types.js';

export interface PipelineOptions {
  source: ErrorSource;
  llm: LLM;
  since: Date;
  /** Human label for the window, e.g. "24h". */
  windowLabel: string;
  maxGroups: number;
  timezone: string;
  now?: Date;
  /** Fingerprints from the previous run; undefined disables the NEW marker. */
  previousFingerprints?: Set<string> | undefined;
  log?: (message: string) => void;
}

export interface PipelineResult {
  errors: RawError[];
  groups: ErrorGroup[];
  triage: TriageResult;
  model: ReportModel;
  markdown: string;
  slack: SlackPayload;
}

/**
 * fetch -> group -> triage -> render. Pure with respect to I/O apart from
 * the injected source and model, which is what makes it testable end to end.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const log = options.log ?? (() => undefined);
  const now = options.now ?? new Date();

  const errors = await options.source.fetch({ since: options.since });
  log(`fetched ${errors.length} errors from ${options.source.name}`);

  const groups = groupErrors(errors, { maxGroups: options.maxGroups });
  log(`grouped into ${groups.length} distinct issues`);

  let triage: TriageResult;
  if (groups.length === 0) {
    triage = { items: [], summary: 'No errors in this window.' };
  } else {
    log(`asking ${options.llm.name} to prioritise`);
    const reply = await options.llm.complete(buildMessages(groups, options.windowLabel));
    triage = parseTriageResponse(reply);
  }

  const model = buildReport(groups, triage, {
    generatedAt: now,
    timezone: options.timezone,
    windowLabel: options.windowLabel,
    sourceName: options.source.name,
    previousFingerprints: options.previousFingerprints,
  });

  return {
    errors,
    groups,
    triage,
    model,
    markdown: renderMarkdown(model),
    slack: renderSlack(model),
  };
}
