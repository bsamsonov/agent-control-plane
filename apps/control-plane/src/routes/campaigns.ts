/**
 * POST /api/campaigns — create a campaign and start the workflow.
 */
import type { Context } from 'hono';
import type { TenantContext } from '@macp/db';
import { withTenant, createCampaign } from '@macp/db';
import { runCampaign } from '../workflow.js';

export async function postCampaigns(c: Context, ctx: TenantContext): Promise<Response> {
  const body = await c.req.json().catch(() => ({}));
  const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
  if (!brief) return c.json({ error: { code: 'INVALID_BRIEF', message: 'brief is required' } }, 400);

  let campaignId: string;
  await withTenant(ctx, async (db) => {
    campaignId = await createCampaign(db, brief, ctx.userId ?? null);
  });

  const runId = await runCampaign(ctx, campaignId!, brief);
  return c.json({ campaignId: campaignId!, runId }, 201);
}
