import type { ErrorGroup } from './group.js';
import type { Severity, TriageItem, TriageResult } from './llm/prompt.js';
import type { SlackBlock, SlackPayload } from './slack.js';

export interface ReportOptions {
  generatedAt: Date;
  timezone: string;
  /** Human label for the query window, e.g. "24h". */
  windowLabel: string;
  sourceName: string;
  /** Fingerprints from the previous run. Undefined when no state file exists. */
  previousFingerprints?: Set<string> | undefined;
}

export interface ReportItem {
  group: ErrorGroup;
  triage: TriageItem;
  isNew: boolean;
}

export interface ReportModel {
  generatedAt: Date;
  timezone: string;
  windowLabel: string;
  sourceName: string;
  summary: string;
  items: ReportItem[];
  hasPreviousState: boolean;
  totals: {
    groups: number;
    occurrences: number;
    newGroups: number;
    bySeverity: Record<Severity, number>;
  };
}

const SEVERITY_RANK: Record<Severity, number> = { P1: 0, P2: 1, P3: 2 };
const NEW_MARKER = 'NEW';
const SLACK_SECTION_LIMIT = 2900;
const EXAMPLE_LIMIT = 160;

/**
 * Joins deterministic group stats with the model's assessment.
 * Groups the model skipped still appear, marked as not assessed,
 * so a flaky model reply never hides an error.
 */
export function buildReport(
  groups: ErrorGroup[],
  triage: TriageResult,
  options: ReportOptions,
): ReportModel {
  const byFingerprint = new Map(triage.items.map((item) => [item.fingerprint, item]));
  const previous = options.previousFingerprints;

  const items: ReportItem[] = groups.map((group) => ({
    group,
    triage: byFingerprint.get(group.fingerprint) ?? fallbackItem(group),
    isNew: previous ? !previous.has(group.fingerprint) : false,
  }));

  items.sort(
    (a, b) =>
      SEVERITY_RANK[a.triage.severity] - SEVERITY_RANK[b.triage.severity] ||
      b.group.count - a.group.count,
  );

  const bySeverity: Record<Severity, number> = { P1: 0, P2: 0, P3: 0 };
  for (const item of items) bySeverity[item.triage.severity] += 1;

  return {
    generatedAt: options.generatedAt,
    timezone: options.timezone,
    windowLabel: options.windowLabel,
    sourceName: options.sourceName,
    summary: triage.summary,
    items,
    hasPreviousState: previous !== undefined,
    totals: {
      groups: items.length,
      occurrences: items.reduce((sum, item) => sum + item.group.count, 0),
      newGroups: items.filter((item) => item.isNew).length,
      bySeverity,
    },
  };
}

function fallbackItem(group: ErrorGroup): TriageItem {
  return {
    fingerprint: group.fingerprint,
    title: group.sample.message.split('\n')[0]?.slice(0, 80) ?? 'Untitled error',
    severity: 'P3',
    likelyCause: 'Not assessed by the model.',
    suggestedOwner: 'unknown',
    nextStep: 'Review manually.',
  };
}

/** "2026-09-10 14:03" in the requested time zone, independent of the host locale. */
export function formatDateTime(iso: string | Date, timezone: string): string {
  const date = typeof iso === 'string' ? new Date(iso) : iso;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function statsLine(model: ReportModel): string {
  const { totals } = model;
  const bits = [
    `Source: ${model.sourceName}`,
    `${totals.occurrences} occurrences in ${totals.groups} groups`,
  ];
  if (model.hasPreviousState) bits.push(`${totals.newGroups} new since last run`);
  return bits.join(' · ');
}

function severityLine(model: ReportModel): string {
  const { bySeverity } = model.totals;
  return `P1 ${bySeverity.P1} · P2 ${bySeverity.P2} · P3 ${bySeverity.P3}`;
}

/** "6 (4 users)" when user ids are known, plain "3" for server-side errors without them. */
function countLabel(group: ErrorGroup): string {
  if (group.affectedUsers === 0) return String(group.count);
  const users = group.affectedUsers === 1 ? '1 user' : `${group.affectedUsers} users`;
  return `${group.count} (${users})`;
}

function exampleLine(group: ErrorGroup): string {
  const first = group.sample.message.split('\n')[0] ?? '';
  const text = first.length > EXAMPLE_LIMIT ? `${first.slice(0, EXAMPLE_LIMIT)}...` : first;
  return group.sample.url ? `${text} at ${group.sample.url}` : text;
}

export function renderMarkdown(model: ReportModel): string {
  const tz = model.timezone;
  const lines: string[] = [
    `# Error triage, ${formatDateTime(model.generatedAt, tz)} ${tz} (last ${model.windowLabel})`,
    '',
    statsLine(model),
    `Severity: ${severityLine(model)}`,
    '',
    `> ${model.summary}`,
    '',
  ];

  for (const { group, triage, isNew } of model.items) {
    const marker = isNew ? ` **${NEW_MARKER}**` : '';
    lines.push(
      `## ${triage.severity}: ${triage.title}${marker}`,
      '',
      `- **Count:** ${countLabel(group)} · **First seen:** ${formatDateTime(group.firstSeen, tz)} · **Last seen:** ${formatDateTime(group.lastSeen, tz)}`,
      `- **Owner:** ${triage.suggestedOwner}`,
      `- **Likely cause:** ${triage.likelyCause}`,
      `- **Next step:** ${triage.nextStep}`,
      `- **Example:** \`${exampleLine(group)}\``,
      '',
    );
  }

  if (model.items.length === 0) lines.push('No errors in this window.', '');
  return lines.join('\n');
}

export function renderSlack(model: ReportModel): SlackPayload {
  const tz = model.timezone;
  const header = `Error triage · ${formatDateTime(model.generatedAt, tz)} ${tz}`;
  const blocks: SlackBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: header.slice(0, 150) } },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `${statsLine(model)} · ${severityLine(model)}` }],
    },
    { type: 'section', text: { type: 'mrkdwn', text: clamp(model.summary) } },
    { type: 'divider' },
  ];

  for (const { group, triage, isNew } of model.items) {
    const marker = isNew ? ` :new: *${NEW_MARKER}*` : '';
    const text = [
      `*${triage.severity} · ${triage.title}*${marker}`,
      `*Count* ${countLabel(group)} · *First* ${formatDateTime(group.firstSeen, tz)} · *Last* ${formatDateTime(group.lastSeen, tz)}`,
      `*Owner* ${triage.suggestedOwner} · *Cause* ${triage.likelyCause}`,
      `*Next* ${triage.nextStep}`,
      `\`${exampleLine(group)}\``,
    ].join('\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clamp(text) } });
  }

  if (model.items.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: 'No errors in this window.' } });
  }

  const { bySeverity, groups } = model.totals;
  return {
    text: `${header}: ${groups} groups (P1 ${bySeverity.P1}, P2 ${bySeverity.P2}, P3 ${bySeverity.P3})`,
    blocks,
  };
}

function clamp(text: string): string {
  return text.length > SLACK_SECTION_LIMIT ? `${text.slice(0, SLACK_SECTION_LIMIT)}...` : text;
}
