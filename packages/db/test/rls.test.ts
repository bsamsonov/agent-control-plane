/**
 * RLS tenant-isolation integration tests.
 *
 * Requires a running Postgres at localhost:5433 with the `macp` database.
 * Migrates and seeds in beforeAll; closes pools in afterAll.
 *
 * Key invariants proved:
 *  1. Tenant A sees only Tenant A's data (and vice versa).
 *  2. Writing a row with a foreign tenant_id is REJECTED by RLS (WITH CHECK).
 *  3. Without app.tenant_id set → 0 rows (never a full-table leak).
 *  4. SET LOCAL does not leak across pool checkouts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, type TenantContext } from '../src/tenant.js';
import { getPool, closePools } from '../src/pool.js';
import { migrate } from '../src/migrate.js';
import { seed } from '../src/seed.js';
import {
  createCampaign,
  createRun,
  listRuns,
} from '../src/repos.js';

const ACME_ID = '11111111-1111-1111-1111-111111111111';
const GLOBEX_ID = '22222222-2222-2222-2222-222222222222';

const acmeCtx: TenantContext = {
  tenantId: ACME_ID,
  actor: 'admin@acme.test',
  actorRole: 'admin',
};

const globexCtx: TenantContext = {
  tenantId: GLOBEX_ID,
  actor: 'admin@globex.test',
  actorRole: 'admin',
};

beforeAll(async () => {
  await migrate();
  await seed();
}, 30_000);

afterAll(async () => {
  await closePools();
});

describe('RLS tenant isolation', () => {
  it('each tenant sees only its own runs', async () => {
    // Create campaign + run as acme
    const acmeCampaignId = await withTenant(acmeCtx, (c) =>
      createCampaign(c, 'ACME campaign', null),
    );
    const acmeRunId = await withTenant(acmeCtx, (c) =>
      createRun(c, acmeCampaignId),
    );

    // Create campaign + run as globex
    const globexCampaignId = await withTenant(globexCtx, (c) =>
      createCampaign(c, 'Globex campaign', null),
    );
    const globexRunId = await withTenant(globexCtx, (c) =>
      createRun(c, globexCampaignId),
    );

    // Acme sees only its own run
    const acmeRuns = await withTenant(acmeCtx, (c) => listRuns(c));
    expect(acmeRuns.length).toBe(1);
    expect(acmeRuns[0]!.id).toBe(acmeRunId);
    expect(acmeRuns[0]!.tenantId).toBe(ACME_ID);

    // Globex sees only its own run
    const globexRuns = await withTenant(globexCtx, (c) => listRuns(c));
    expect(globexRuns.length).toBe(1);
    expect(globexRuns[0]!.id).toBe(globexRunId);
    expect(globexRuns[0]!.tenantId).toBe(GLOBEX_ID);
  });

  it('RLS WITH CHECK rejects insert with foreign tenant_id', async () => {
    // In acme context, try inserting an audit_log row with globex tenant_id.
    // RLS WITH CHECK policy should reject because
    // globex !== current_setting('app.tenant_id') (which is acme).
    await expect(
      withTenant(acmeCtx, async (c) => {
        await c.query(
          `INSERT INTO audit_log (tenant_id, actor, decision)
           VALUES ($1, 'test', 'deny')`,
          [GLOBEX_ID],
        );
      }),
    ).rejects.toThrow();
  });
});

describe('RLS negative tests', () => {
  it('query without app.tenant_id returns 0 rows (never all rows)', async () => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM campaigns');
      await client.query('COMMIT');
      expect(rows.length).toBe(0);
    } finally {
      client.release();
    }
  });

  it('SET LOCAL does not leak across pool checkouts', async () => {
    // Create a campaign inside withTenant (which sets LOCAL)
    await withTenant(acmeCtx, (c) =>
      createCampaign(c, 'Leak test', null),
    );

    // New client from the same pool — no tenant_id should be set
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT * FROM campaigns');
      await client.query('COMMIT');
      expect(rows.length).toBe(0);
    } finally {
      client.release();
    }
  });
});
