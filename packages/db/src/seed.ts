/**
 * Database seeder. Truncates business tables and inserts the deterministic
 * fixtures (tenants, users, policies, budgets, credentials).
 *
 * Must be called AFTER migrate() so that the `macp_app` role and all tables exist.
 * Uses the ADMIN pool (BYPASSRLS) — seed is infrastructure, not a tenant operation.
 *
 * Also works as a CLI entrypoint:  tsx packages/db/src/seed.ts
 */
import { fileURLToPath } from 'node:url';
import { withAdmin } from './tenant.js';
import { closePools } from './pool.js';
import { sealCredential } from './crypto.js';
import { TENANTS, USERS } from './fixtures.js';
import { ACME_POLICY, GLOBEX_POLICY } from '@macp/policy';

const POLICY_MAP: Record<string, unknown> = {
  acme: ACME_POLICY,
  globex: GLOBEX_POLICY,
};

const BUDGETS: Record<string, { limit: number; spent: number }> = {
  acme: { limit: 1000, spent: 0 },
  globex: { limit: 5000, spent: 0 },
};

export async function seed(): Promise<void> {
  await withAdmin(async (c) => {
    // Truncate business tables in FK-safe order
    await c.query(`TRUNCATE
      audit_log, approvals, step_results, workflow_runs, campaigns,
      policies, budget_state, tenant_credentials, users, tenants
      CASCADE`);

    // Insert tenants
    for (const t of TENANTS) {
      await c.query(
        `INSERT INTO tenants (id, slug, name, plan) VALUES ($1,$2,$3,$4)`,
        [t.id, t.slug, t.name, t.plan],
      );
    }

    // Insert users
    for (const u of USERS) {
      const tenant = TENANTS.find((t) => t.slug === u.tenantSlug);
      if (!tenant) throw new Error(`unknown tenant slug: ${u.tenantSlug}`);
      await c.query(
        `INSERT INTO users (id, tenant_id, email, role) VALUES ($1,$2,$3,$4)`,
        [u.id, tenant.id, u.email, u.role],
      );
    }

    // Insert policies
    for (const t of TENANTS) {
      const policy = POLICY_MAP[t.slug];
      if (!policy) throw new Error(`no policy for slug: ${t.slug}`);
      await c.query(
        `INSERT INTO policies (tenant_id, rule_json) VALUES ($1, $2)`,
        [t.id, JSON.stringify(policy)],
      );
    }

    // Insert budgets
    for (const t of TENANTS) {
      const b = BUDGETS[t.slug];
      if (!b) throw new Error(`no budget for slug: ${t.slug}`);
      await c.query(
        `INSERT INTO budget_state (tenant_id, limit_usd, spent_usd) VALUES ($1,$2,$3)`,
        [t.id, b.limit, b.spent],
      );
    }

    // Insert tenant credentials (one per system per tenant)
    const systems = ['crm', 'esp', 'analytics'] as const;
    for (const t of TENANTS) {
      for (const sys of systems) {
        const cred = sealCredential({
          tenant: t.slug,
          system: sys,
          demo: true,
          apiKey: `demo-key-${t.slug}-${sys}`,
        });
        await c.query(
          `INSERT INTO tenant_credentials (tenant_id, system, enc_blob) VALUES ($1,$2,$3)`,
          [t.id, sys, cred],
        );
      }
    }
  });
}

// CLI entrypoint
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  // Import migrate dynamically so the CLI can be standalone
  import('./migrate.js')
    .then(({ migrate }) =>
      migrate().then(() => {
        console.log('Migrations complete, now seeding...');
        return seed();
      }),
    )
    .then(() => {
      console.log('Seed complete.');
      return closePools();
    })
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
