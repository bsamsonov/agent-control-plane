/**
 * Dev auth — deliberate POC shortcut.
 *
 * Resolves a principal from X-MACP-User or Authorization: Bearer dev:<email>
 * and returns a TenantContext by looking up the user in the users table.
 * No passwords.
 */
import type { TenantContext } from '@macp/db';

/** TenantContext plus the user's primary key, needed for created_by / decided_by columns. */
export interface Principal extends TenantContext {
  userId: string;
}
import type { Role } from '@macp/policy';
import { getAdminPool } from '@macp/db';

export async function resolveAuth(req: { headers: Headers }): Promise<Principal> {
  const h = req.headers;
  let email: string | undefined;

  // X-MACP-User
  const userHeader = h.get('x-macp-user');
  if (userHeader) {
    email = userHeader.trim();
  }

  // Authorization: Bearer dev:<email>
  if (!email) {
    const auth = h.get('authorization');
    if (auth) {
      const m = /^Bearer\s+dev:(.+)/i.exec(auth);
      if (m) email = m[1]!.trim();
    }
  }

  if (!email) {
    throw Object.assign(new Error('no dev auth header (X-MACP-User or Bearer dev:<email>)'), { status: 401 });
  }

  // Look up user via admin pool (no tenant context yet)
  const pool = getAdminPool();
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.role, t.id AS tenant_id
     FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE u.email = $1`,
    [email],
  );
  if (!rows[0]) {
    throw Object.assign(new Error(`unknown user: ${email}`), { status: 401 });
  }
  return {
    tenantId: (rows[0] as any).tenant_id,
    actor: email,
    actorRole: (rows[0] as any).role as Role,
    userId: (rows[0] as any).id,
  };
}
