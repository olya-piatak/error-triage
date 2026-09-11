import { describe, expect, it } from 'vitest';
import { groupErrors } from '../src/group.js';
import {
  buildMessages,
  extractJsonObject,
  parseTriageResponse,
  TriageParseError,
} from '../src/llm/prompt.js';
import { makeError } from './helpers.js';

const validReply = {
  items: [
    {
      fingerprint: 'fp-1',
      title: 'Cart crashes',
      severity: 'P1',
      likelyCause: 'Missing null check',
      suggestedOwner: 'frontend',
      nextStep: 'Add a guard',
    },
  ],
  summary: 'One P1.',
};

describe('buildMessages', () => {
  it('produces a system prompt and a user prompt carrying the groups as fenced JSON', () => {
    const groups = groupErrors(
      [makeError({ message: 'x', stack: 'Error: x\n    at a (b.js:1:1)', url: 'https://e.com/p' })],
      { maxGroups: 5 },
    );
    const messages = buildMessages(groups, '24h');
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toContain('P1');

    const fenced = /```json\s*([\s\S]*?)```/.exec(messages[1]?.content ?? '');
    const payload = JSON.parse(fenced?.[1] ?? '{}');
    expect(payload.window).toBe('24h');
    expect(payload.groups).toHaveLength(1);
    expect(payload.groups[0]).toMatchObject({
      fingerprint: groups[0]?.fingerprint,
      count: 1,
      url: 'https://e.com/p',
      frames: ['a (b.js)'],
    });
  });
});

describe('parseTriageResponse', () => {
  it('accepts a bare JSON object', () => {
    expect(parseTriageResponse(JSON.stringify(validReply))).toEqual(validReply);
  });

  it('tolerates ```json fences', () => {
    const text = '```json\n' + JSON.stringify(validReply, null, 2) + '\n```';
    expect(parseTriageResponse(text)).toEqual(validReply);
  });

  it('tolerates prose around the object', () => {
    const text = `Sure! Here is the triage:\n${JSON.stringify(validReply)}\nLet me know.`;
    expect(parseTriageResponse(text)).toEqual(validReply);
  });

  it('throws TriageParseError on invalid JSON', () => {
    expect(() => parseTriageResponse('{"items": [')).toThrow(TriageParseError);
  });

  it('throws TriageParseError when there is no object at all', () => {
    expect(() => parseTriageResponse('I cannot help with that.')).toThrow(TriageParseError);
  });

  it('throws TriageParseError when the schema does not match', () => {
    const bad = { ...validReply, items: [{ ...validReply.items[0], severity: 'P4' }] };
    expect(() => parseTriageResponse(JSON.stringify(bad))).toThrow(/severity/);
  });

  it('keeps the raw text on the error for logging', () => {
    try {
      parseTriageResponse('nope');
    } catch (error) {
      expect((error as TriageParseError).raw).toBe('nope');
    }
  });
});

describe('extractJsonObject', () => {
  it('prefers the fenced block when present', () => {
    expect(extractJsonObject('x {"a":1} ```json\n{"b":2}\n``` y')).toBe('{"b":2}');
  });
});
