/**
 * GET /api/me — current tenant + user + policy summary
 */
import type { Context } from 'hono';
import type { TenantContext } from '@macp/db';
import { withTenant, getPolicy, getBudget } from '@macp/db';

export async function getMe(c: Context, ctx: TenantContext): Promise<Response> {
  let policy: any;
  let budget: any;

  await withTenant(ctx, async (db) => {
    policy = await getPolicy(db);
    budget = await getBudget(db);
  });

  return c.json({
    tenantId: ctx.tenantId,
    actor: ctx.actor,
    actorRole: ctx.actorRole,
    policy: {
      defaultEffect: policy!.defaultEffect,
      ruleCount: policy!.rules?.length ?? 0,
    },
    budget,
  });
}
