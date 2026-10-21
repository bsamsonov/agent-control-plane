/**
 * Redaction tests — ≥8 cases covering dot-paths, array indices, wildcards,
 * missing paths, and immutability.
 */
import { describe, it, expect } from 'vitest';
import { redactArgs } from '../src/redact.js';

describe('redactArgs', () => {
  it('redacts a simple top-level key', () => {
    const input = { name: 'Alice', email: 'a@b.com' };
    const result = redactArgs(input, ['email']);
    expect(result).toEqual({ name: 'Alice', email: '[REDACTED]' });
  });

  it('redacts a nested dot-path', () => {
    const input = { user: { name: 'Alice', ssn: '123-45-6789' } };
    const result = redactArgs(input, ['user.ssn']);
    expect(result).toEqual({ user: { name: 'Alice', ssn: '[REDACTED]' } });
  });

  it('redacts an array index path a[0].b', () => {
    const input = { items: [{ id: 1, secret: 'x' }, { id: 2, secret: 'y' }] };
    const result = redactArgs(input, ['items[0].secret']);
    expect(result).toEqual({
      items: [{ id: 1, secret: '[REDACTED]' }, { id: 2, secret: 'y' }],
    });
  });

  it('redacts all own keys via wildcard a.*', () => {
    const input = { secrets: { api_key: 'abc', token: 'xyz' } };
    const result = redactArgs(input, ['secrets.*']);
    expect(result).toEqual({ secrets: { api_key: '[REDACTED]', token: '[REDACTED]' } });
  });

  it('redacts top-level wildcard .* (prefix is empty)', () => {
    const input = { a: '1', b: '2', c: '3' };
    const result = redactArgs(input, ['.*']);
    expect(result).toEqual({ a: '[REDACTED]', b: '[REDACTED]', c: '[REDACTED]' });
  });

  it('silently ignores missing paths', () => {
    const input = { name: 'Alice' };
    const result = redactArgs(input, ['email', 'deep.nested.key']);
    expect(result).toEqual({ name: 'Alice' });
  });

  it('silently ignores wildcard on non-object leaf', () => {
    const input = { name: 'Alice' };
    const result = redactArgs(input, ['name.*']);
    // name is a string, not an object → nothing to enumerate
    expect(result).toEqual({ name: 'Alice' });
  });

  it('silently ignores wildcard on array (wildcard only enumerates object keys)', () => {
    const input = { items: [{ a: 1 }, { b: 2 }] };
    const result = redactArgs(input, ['items.*']);
    // items is an array — wildcard only acts on plain objects, not arrays
    expect(result).toEqual({ items: [{ a: 1 }, { b: 2 }] });
  });

  it('never mutates the input', () => {
    const input = { user: { name: 'Alice', ssn: '123' } };
    const original = JSON.stringify(input);
    redactArgs(input, ['user.ssn']);
    expect(JSON.stringify(input)).toBe(original);
  });

  it('multiple redact paths deduplicated (logically via Set)', () => {
    const input = { a: 'secret1', b: 'secret2', c: 'ok' };
    const result = redactArgs(input, ['a', 'a', 'b']);
    expect(result).toEqual({ a: '[REDACTED]', b: '[REDACTED]', c: 'ok' });
  });
});
