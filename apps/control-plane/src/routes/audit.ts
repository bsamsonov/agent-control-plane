/**
 * GET /api/audit?runId=&limit= — audit log
 */
import type { Context } from 'hono';
import type { TenantContext } from '@macp/db';
import { withTenant, listAudit } from '@macp/db';

export async function listAuditHandler(c: Context, ctx: TenantContext): Promise<Response> {
  const runId = c.req.query('runId') || undefined;
  const limit = parseInt(c.req.query('limit') || '50', 10);

  let rows: any[];
  await withTenant(ctx, async (db) => {
    rows = await listAudit(db, { limit, runId });
  });

  return c.json({ audit: rows! });
}
