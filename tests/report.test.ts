import { describe, expect, it } from 'vitest';
import type { ErrorGroup } from '../src/group.js';
import type { TriageItem, TriageResult } from '../src/llm/prompt.js';
import { buildReport, formatDateTime, renderMarkdown, renderSlack } from '../src/report.js';
import { makeError } from './helpers.js';

function group(fp: string, count: number, users = 0): ErrorGroup {
  const sample = makeError({ message: `msg ${fp}`, url: `https://e.com/${fp}` });
  return {
    fingerprint: fp,
    sample,
    count,
    firstSeen: '2026-09-10T07:00:00.000Z',
    lastSeen: '2026-09-10T20:30:00.000Z',
    affectedUsers: users,
    examples: [sample],
  };
}

function item(fp: string, severity: TriageItem['severity']): TriageItem {
  return {
    fingerprint: fp,
    title: `Title ${fp}`,
    severity,
    likelyCause: `Cause ${fp}`,
    suggestedOwner: 'backend',
    nextStep: `Step ${fp}`,
  };
}

const groups = [group('a', 10, 4), group('b', 5), group('c', 1, 1)];
const triage: TriageResult = {
  items: [item('a', 'P2'), item('b', 'P1'), item('c', 'P3')],
  summary: 'Summary text.',
};
const baseOptions = {
  generatedAt: new Date('2026-09-11T07:00:00Z'),
  timezone: 'UTC',
  windowLabel: '24h',
  sourceName: 'json',
};

describe('buildReport', () => {
  it('orders by severity first, then by count', () => {
    const model = buildReport(groups, triage, baseOptions);
    expect(model.items.map((i) => i.group.fingerprint)).toEqual(['b', 'a', 'c']);
  });

  it('computes totals', () => {
    const model = buildReport(groups, triage, baseOptions);
    expect(model.totals).toEqual({
      groups: 3,
      occurrences: 16,
      newGroups: 0,
      bySeverity: { P1: 1, P2: 1, P3: 1 },
    });
    expect(model.hasPreviousState).toBe(false);
  });

  it('marks groups absent from the previous run as new', () => {
    const model = buildReport(groups, triage, {
      ...baseOptions,
      previousFingerprints: new Set(['a']),
    });
    const isNew = Object.fromEntries(model.items.map((i) => [i.group.fingerprint, i.isNew]));
    expect(isNew).toEqual({ a: false, b: true, c: true });
    expect(model.totals.newGroups).toBe(2);
    expect(model.hasPreviousState).toBe(true);
  });

  it('falls back when the model skipped a group', () => {
    const model = buildReport(groups, { items: [item('a', 'P1')], summary: 's' }, baseOptions);
    const skipped = model.items.find((i) => i.group.fingerprint === 'b');
    expect(skipped?.triage.likelyCause).toBe('Not assessed by the model.');
    expect(skipped?.triage.severity).toBe('P3');
  });
});

describe('formatDateTime', () => {
  it('renders in the requested zone with a 24h clock', () => {
    expect(formatDateTime('2026-09-10T07:12:44.120Z', 'UTC')).toBe('2026-09-10 07:12');
    expect(formatDateTime('2026-09-10T07:12:44.120Z', 'Europe/Kyiv')).toBe('2026-09-10 10:12');
    expect(formatDateTime('2026-09-10T23:30:00Z', 'America/Los_Angeles')).toBe('2026-09-10 16:30');
  });
});

describe('renderMarkdown', () => {
  it('includes header, stats, summary and one section per group', () => {
    const md = renderMarkdown(buildReport(groups, triage, baseOptions));
    expect(md).toContain('# Error triage, 2026-09-11 07:00 UTC (last 24h)');
    expect(md).toContain('Source: json · 16 occurrences in 3 groups');
    expect(md).toContain('Severity: P1 1 · P2 1 · P3 1');
    expect(md).toContain('> Summary text.');
    expect(md).toContain('## P1: Title b');
    expect(md).toContain('- **Count:** 10 (4 users) · **First seen:** 2026-09-10 07:00');
    expect(md).toContain('- **Count:** 5 · **First seen:**');
    expect(md).toContain('- **Example:** `msg b at https://e.com/b`');
    expect(md).not.toContain('NEW');
  });

  it('shows the NEW marker and the new-since count when state exists', () => {
    const md = renderMarkdown(
      buildReport(groups, triage, { ...baseOptions, previousFingerprints: new Set(['a']) }),
    );
    expect(md).toContain('2 new since last run');
    expect(md).toContain('## P1: Title b **NEW**');
    expect(md).toContain('## P2: Title a\n');
  });

  it('handles an empty window', () => {
    const md = renderMarkdown(buildReport([], { items: [], summary: 'Nothing.' }, baseOptions));
    expect(md).toContain('0 occurrences in 0 groups');
    expect(md).toContain('No errors in this window.');
  });
});

describe('renderSlack', () => {
  it('builds a header, context, summary, divider and one section per group', () => {
    const payload = renderSlack(buildReport(groups, triage, baseOptions));
    expect(payload.blocks.map((b) => b.type)).toEqual([
      'header',
      'context',
      'section',
      'divider',
      'section',
      'section',
      'section',
    ]);
    expect(payload.text).toBe('Error triage · 2026-09-11 07:00 UTC: 3 groups (P1 1, P2 1, P3 1)');
  });

  it('keeps every section under the Slack text limit', () => {
    const long = {
      ...triage,
      items: triage.items.map((i) => ({ ...i, likelyCause: 'x'.repeat(5000) })),
    };
    const payload = renderSlack(buildReport(groups, long, baseOptions));
    for (const block of payload.blocks) {
      const text = (block as { text?: { text: string } }).text?.text ?? '';
      expect(text.length).toBeLessThanOrEqual(3000);
    }
  });

  it('marks new groups', () => {
    const payload = renderSlack(
      buildReport(groups, triage, { ...baseOptions, previousFingerprints: new Set(['a', 'c']) }),
    );
    const texts = payload.blocks.map((b) => JSON.stringify(b));
    expect(texts.filter((t) => t.includes(':new:'))).toHaveLength(1);
  });
});
