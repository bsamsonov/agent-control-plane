/**
 * Postgres connection pools.
 *
 * Two pools: the app pool (macp_app, RLS-enforced) and the admin pool
 * (macp, BYPASSRLS owner) used only by migrate/seed.
 */
import pg from 'pg';
const { Pool } = pg;

let _pool: pg.Pool | null = null;
let _adminPool: pg.Pool | null = null;

const APP_URL = process.env.DATABASE_URL ?? 'postgres://macp_app:macp_app@localhost:5433/macp';
const ADMIN_URL = process.env.DATABASE_URL_ADMIN ?? 'postgres://macp:macp@localhost:5433/macp';

export function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: APP_URL });
  }
  return _pool;
}

export function getAdminPool(): pg.Pool {
  if (!_adminPool) {
    _adminPool = new Pool({ connectionString: ADMIN_URL });
  }
  return _adminPool;
}

export async function closePools(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
  if (_adminPool) {
    await _adminPool.end();
    _adminPool = null;
  }
}
