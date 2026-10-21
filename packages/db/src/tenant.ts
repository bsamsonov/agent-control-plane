/**
 * Tenant-scoped transaction wrapper.
 *
 * Every business query MUST go through `withTenant`, which opens a transaction,
 * sets `SET LOCAL app.tenant_id` (the RLS guard), executes the caller's function,
 * commits, and releases the client back to the pool. On error the transaction is
 * rolled back.
 *
 * `withAdmin` is an escape hatch for migrations and seed only — it uses the
 * admin pool with no RLS setting.
 */
import type { PoolClient } from 'pg';
import type { Role } from '@macp/policy';
import { getPool, getAdminPool } from './pool.js';

export interface TenantContext {
  tenantId: string;
  actor: string;
  actorRole: Role;
  /** users.id of the actor, when the actor is a user (not set for system contexts). */
  userId?: string;
}

export async function withTenant<T>(ctx: TenantContext, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SET LOCAL does not accept bind parameters; set_config(..., is_local=true) is the
    // parameterized equivalent and keeps the value transaction-scoped.
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', ctx.tenantId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function withAdmin<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const pool = getAdminPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
