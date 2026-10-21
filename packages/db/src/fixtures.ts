/**
 * Deterministic seed fixtures.
 *
 * Fixed UUIDs — the demo, tests, and any cloned checkout produce identical
 * data for the same tenant slugs. No DB access; just pure data definitions.
 */
import type { Role } from '@macp/policy';

export const TENANTS: Array<{ id: string; slug: 'acme' | 'globex'; name: string; plan: string }> = [
  { id: '11111111-1111-1111-1111-111111111111', slug: 'acme', name: 'ACME Corp', plan: 'standard' },
  { id: '22222222-2222-2222-2222-222222222222', slug: 'globex', name: 'Globex Inc', plan: 'standard' },
];

export const USERS: Array<{ id: string; tenantSlug: string; email: string; role: Role }> = [
  { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', tenantSlug: 'acme', email: 'admin@acme.test', role: 'admin' },
  { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', tenantSlug: 'acme', email: 'marketer@acme.test', role: 'marketer' },
  { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', tenantSlug: 'acme', email: 'viewer@acme.test', role: 'viewer' },
  { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', tenantSlug: 'globex', email: 'marketer@globex.test', role: 'marketer' },
  { id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', tenantSlug: 'globex', email: 'admin@globex.test', role: 'admin' },
];
