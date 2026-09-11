import { z } from 'zod';
import type { ErrorGroup } from '../group.js';
import { topFrames } from '../normalize.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const severitySchema = z.enum(['P1', 'P2', 'P3']);
export const ownerSchema = z.enum(['frontend', 'backend', 'infra', 'unknown']);

export const triageItemSchema = z.object({
  fingerprint: z.string().min(1),
  title: z.string().min(1).max(200),
  severity: severitySchema,
  likelyCause: z.string(),
  suggestedOwner: ownerSchema,
  nextStep: z.string(),
});

export const triageResultSchema = z.object({
  items: z.array(triageItemSchema),
  summary: z.string(),
});

export type Severity = z.infer<typeof severitySchema>;
export type Owner = z.infer<typeof ownerSchema>;
export type TriageItem = z.infer<typeof triageItemSchema>;
export type TriageResult = z.infer<typeof triageResultSchema>;

/** The compact, model-facing view of a group. Stack traces are trimmed to three frames. */
export interface PromptGroup {
  fingerprint: string;
  message: string;
  count: number;
  affectedUsers: number;
  firstSeen: string;
  lastSeen: string;
  url?: string;
  frames: string[];
  tags: Record<string, string>;
}

const MAX_MESSAGE_CHARS = 300;

export const SYSTEM_PROMPT = `You are an on-call engineer triaging production errors for a web application.
You receive error groups that were already deduplicated. For each group decide how urgent it is and who should look at it.

Severity rules:
- P1: users cannot complete a core flow (checkout, login, payment), data loss, or a backend dependency is down.
- P2: a feature is broken for some users or the volume is high, but there is a workaround.
- P3: cosmetic, rare, or clearly caused by a single client.

Owner rules: "frontend" for browser/React/bundle issues, "backend" for API/database/business logic, "infra" for network, DNS, hosting or capacity, "unknown" if you cannot tell.

Respond with ONLY a JSON object, no prose, no Markdown fences, in exactly this shape:
{
  "items": [
    {
      "fingerprint": "<copy the fingerprint verbatim>",
      "title": "<short human title, max 80 chars>",
      "severity": "P1" | "P2" | "P3",
      "likelyCause": "<one or two sentences>",
      "suggestedOwner": "frontend" | "backend" | "infra" | "unknown",
      "nextStep": "<one concrete action>"
    }
  ],
  "summary": "<two or three sentences for a Slack channel: what matters most today>"
}
Include every group exactly once. Do not invent groups.`;

export function toPromptGroup(group: ErrorGroup): PromptGroup {
  const { sample } = group;
  const message =
    sample.message.length > MAX_MESSAGE_CHARS
      ? `${sample.message.slice(0, MAX_MESSAGE_CHARS)}...`
      : sample.message;
  return {
    fingerprint: group.fingerprint,
    message,
    count: group.count,
    affectedUsers: group.affectedUsers,
    firstSeen: group.firstSeen,
    lastSeen: group.lastSeen,
    ...(sample.url ? { url: sample.url } : {}),
    frames: topFrames(sample.stack),
    tags: sample.tags,
  };
}

export function buildMessages(groups: ErrorGroup[], windowLabel: string): ChatMessage[] {
  const payload = { window: windowLabel, groups: groups.map(toPromptGroup) };
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `Triage these ${groups.length} error groups from the last ${windowLabel}.`,
        'Return only the JSON object described in the instructions.',
        '',
        '```json',
        JSON.stringify(payload, null, 2),
        '```',
      ].join('\n'),
    },
  ];
}

export class TriageParseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'TriageParseError';
  }
}

/**
 * Pulls a JSON object out of a model reply. Tolerates ```json fences and
 * prose before or after the object.
 */
export function extractJsonObject(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new TriageParseError('No JSON object found in model response', text);
  }
  return candidate.slice(start, end + 1);
}

export function parseTriageResponse(text: string): TriageResult {
  const json = extractJsonObject(text);
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new TriageParseError(`Model response is not valid JSON: ${String(error)}`, text);
  }
  const result = triageResultSchema.safeParse(data);
  if (!result.success) {
    throw new TriageParseError(
      `Model response does not match schema: ${z.prettifyError(result.error)}`,
      text,
    );
  }
  return result.data;
}
