/**
 * Schema validation tests — valid policy document + ≥4 invalid cases.
 */
import { describe, it, expect } from 'vitest';
import { parsePolicyDocument, policyDocumentSchema } from '../src/schema.js';
import { ACME_POLICY, GLOBEX_POLICY } from '../src/seed-policies.js';

describe('parsePolicyDocument', () => {
  it('parses ACME_POLICY successfully', () => {
    const doc = parsePolicyDocument(ACME_POLICY);
    expect(doc.version).toBe(1);
    expect(doc.rules.length).toBeGreaterThan(0);
  });

  it('parses GLOBEX_POLICY successfully', () => {
    const doc = parsePolicyDocument(GLOBEX_POLICY);
    expect(doc.version).toBe(1);
    expect(doc.defaultEffect).toBe('deny');
  });

  it('rejects version != 1', () => {
    expect(() =>
      parsePolicyDocument({
        ...ACME_POLICY,
        version: 2,
      }),
    ).toThrow();
  });

  it('rejects invalid defaultEffect', () => {
    expect(() =>
      parsePolicyDocument({
        ...ACME_POLICY,
        defaultEffect: 'maybe',
      }),
    ).toThrow();
  });

  it('rejects rule with invalid effect', () => {
    expect(() =>
      parsePolicyDocument({
        version: 1,
        defaultEffect: 'deny',
        rules: [{ id: 'r1', effect: 'blocked' }],
      }),
    ).toThrow();
  });

  it('rejects rule with invalid role', () => {
    expect(() =>
      parsePolicyDocument({
        version: 1,
        defaultEffect: 'deny',
        rules: [
          {
            id: 'r1',
            when: { roles: ['superadmin' as any] },
            effect: 'allow',
          },
        ],
      }),
    ).toThrow();
  });

  it('rejects missing required fields', () => {
    expect(() => parsePolicyDocument({})).toThrow();
    expect(() => parsePolicyDocument(null)).toThrow();
    expect(() => parsePolicyDocument(undefined)).toThrow();
    expect(() => parsePolicyDocument('nope')).toThrow();
  });
});
