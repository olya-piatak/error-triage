import { describe, expect, it } from 'vitest';
import { fingerprint, normalizeMessage, topFrames } from '../src/normalize.js';

describe('normalizeMessage', () => {
  it('replaces bare numbers and IP addresses', () => {
    expect(normalizeMessage('Order 8891 not found')).toBe('Order <n> not found');
    expect(normalizeMessage('took 12.5 seconds')).toBe('took <n> seconds');
    expect(normalizeMessage('connect ECONNREFUSED 10.0.3.17:6379')).toBe(
      'connect ECONNREFUSED <ip>:<n>',
    );
  });

  it('replaces UUIDs, hex hashes, long ids and timestamps', () => {
    expect(normalizeMessage('user 3f2a1b4c-1234-4abc-9def-0123456789ab missing')).toBe(
      'user <uuid> missing',
    );
    expect(normalizeMessage('Loading chunk 4821.a3f9c2e1.js failed')).toBe(
      'Loading chunk <n>.<hex>.js failed',
    );
    expect(normalizeMessage("No such payment_intent: 'pi_3Nx8Kq2eZvKYlo2C1abcdefg'")).toBe(
      "No such payment_intent: '<id>'",
    );
    expect(normalizeMessage('failed at 2026-09-10T07:12:44.120Z during sync')).toBe(
      'failed at <ts> during sync',
    );
  });

  it('strips query strings and fragments but keeps the URL path', () => {
    expect(normalizeMessage('GET https://a.example.com/api/orders?id=42&x=y#top failed')).toBe(
      'GET https://a.example.com/api/orders failed',
    );
  });

  it('collapses whitespace and newlines', () => {
    expect(normalizeMessage('Loading chunk 1 failed.\n   (error: x)')).toBe(
      'Loading chunk <n> failed. (error: x)',
    );
  });

  it('keeps property names so distinct errors stay distinct', () => {
    const a = normalizeMessage("Cannot read properties of undefined (reading 'items')");
    const b = normalizeMessage("Cannot read properties of undefined (reading 'total')");
    expect(a).not.toBe(b);
  });

  it('is idempotent', () => {
    const once = normalizeMessage('Request failed with status code 502 (GET /api/orders/88213)');
    expect(normalizeMessage(once)).toBe(once);
  });
});

describe('topFrames', () => {
  const stack = [
    'TypeError: boom',
    '    at CartSummary (https://shop.example.com/static/js/main.8f3a1c2d.js:2:41233)',
    '    at renderWithHooks (https://shop.example.com/static/js/vendor.3b9e0f11.js:1:120344)',
    '    at Ir.request (/app/node_modules/@prisma/client/runtime/library.js:121:6347)',
    '    at fourth (d.js:3:4)',
  ].join('\n');

  it('keeps at most three frames and drops the message line', () => {
    const frames = topFrames(stack);
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatch(/^CartSummary/);
  });

  it('strips line and column numbers and bundle hashes', () => {
    expect(topFrames(stack)[0]).toBe(
      'CartSummary (https://shop.example.com/static/js/main.<hex>.js)',
    );
  });

  it('shortens node_modules paths', () => {
    expect(topFrames(stack)[2]).toBe('Ir.request (node_modules/@prisma/client/runtime/library.js)');
  });

  it('returns an empty list without a stack', () => {
    expect(topFrames(undefined)).toEqual([]);
    expect(topFrames('just a message')).toEqual([]);
  });
});

describe('fingerprint', () => {
  it('is stable across ids, line numbers and bundle hashes', () => {
    const a = fingerprint({
      message: 'Request failed with status code 502 (GET /api/orders/88213)',
      stack:
        'Error: x\n    at createError (https://shop.example.com/static/js/vendor.3b9e0f11.js:1:88123)',
    });
    const b = fingerprint({
      message: 'Request failed with status code 502 (GET /api/orders/99001)',
      stack:
        'Error: x\n    at createError (https://shop.example.com/static/js/vendor.9c1d2e3f.js:1:90002)',
    });
    expect(a).toBe(b);
  });

  it('differs when the top frame differs', () => {
    const a = fingerprint({ message: 'boom', stack: 'Error: boom\n    at a (x.js:1:1)' });
    const b = fingerprint({ message: 'boom', stack: 'Error: boom\n    at b (y.js:1:1)' });
    expect(a).not.toBe(b);
  });
});
