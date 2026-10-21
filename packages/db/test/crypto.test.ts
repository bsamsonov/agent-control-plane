/**
 * Crypto envelope unit tests — no database needed.
 *
 * Verifies round-trip correctness and tamper detection.
 */
import { describe, it, expect } from 'vitest';
import { sealCredential, openCredential } from '../src/crypto.js';

describe('seal / open credential', () => {
  it('round-trips a plain object', () => {
    const plain = { apiKey: 'sk-12345', region: 'us-east-1' };
    const blob = sealCredential(plain);
    expect(typeof blob).toBe('string');
    expect(blob.length).toBeGreaterThan(0);

    const recovered = openCredential(blob);
    expect(recovered).toEqual(plain);
  });

  it('round-trips an empty object', () => {
    const blob = sealCredential({});
    expect(openCredential(blob)).toEqual({});
  });

  it('round-trips a nested object', () => {
    const plain = { nested: { key: 'val', arr: [1, 2, 3] }, bool: true, num: 42 };
    const blob = sealCredential(plain);
    expect(openCredential(blob)).toEqual(plain);
  });

  it('produces different blobs for the same input (random IV)', () => {
    const plain = { x: 1 };
    const b1 = sealCredential(plain);
    const b2 = sealCredential(plain);
    expect(b1).not.toBe(b2);
    expect(openCredential(b1)).toEqual(plain);
    expect(openCredential(b2)).toEqual(plain);
  });

  it('throws on a tampered blob', () => {
    const blob = sealCredential({ secret: 'sssh' });
    // Flip the last byte of the base64 string
    const raw = Buffer.from(blob, 'base64');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    const tampered = raw.toString('base64');
    expect(() => openCredential(tampered)).toThrow();
  });

  it('throws on truncated blob', () => {
    expect(() => openCredential('abc')).toThrow();
  });

  it('throws on empty blob', () => {
    expect(() => openCredential('')).toThrow();
  });

  it('throws on completely garbage base64', () => {
    // Valid base64 but not a valid encrypted blob
    expect(() => openCredential('dGhpcyBpcyBub3QgYSB2YWxpZCBibG9i')).toThrow();
  });
});
