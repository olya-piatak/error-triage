import { fileURLToPath } from 'node:url';
import type { RawError } from '../src/sources/types.js';

export const FIXTURE_PATH = fileURLToPath(
  new URL('../fixtures/errors.sample.json', import.meta.url),
);

let counter = 0;

/** Builds a RawError with sensible defaults; every call gets a unique id. */
export function makeError(overrides: Partial<RawError> = {}): RawError {
  counter += 1;
  return {
    id: `evt_${counter}`,
    timestamp: '2026-09-10T10:00:00.000Z',
    message: 'Something broke',
    tags: {},
    ...overrides,
  };
}

/** A fetch stand-in that returns queued responses in order and records calls. */
export function fakeFetch(responses: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`fakeFetch: no response queued for call ${calls.length}`);
    return next();
  };
  return { fn, calls };
}

export function jsonResponse(body: unknown, status = 200): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

export function textResponse(body: string, status: number): () => Response {
  return () => new Response(body, { status });
}
