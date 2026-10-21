/**
 * GET  /api/approvals?status=pending — list approvals
 * POST /api/approvals/:id/decide — approve or reject
 */
import type { Context } from 'hono';
import type { TenantContext } from '@macp/db';
import { withTenant, listApprovals, getApproval } from '@macp/db';
import { handleApprovalDecision } from '../workflow.js';

export async function listApprovalsHandler(c: Context, ctx: TenantContext): Promise<Response> {
  const status = c.req.query('status') || undefined;

  let approvals: any[];
  await withTenant(ctx, async (db) => {
    approvals = await listApprovals(db, status);
  });

  return c.json({ approvals: approvals! });
}

export async function decideApprovalHandler(c: Context, ctx: TenantContext): Promise<Response> {
  const approvalId = c.req.param('id')!;
  const body = await c.req.json().catch(() => ({}));
  const decision = body.decision as string | undefined;
  const note = typeof body.note === 'string' ? body.note : null;

  if (decision !== 'approved' && decision !== 'rejected') {
    return c.json({ error: { code: 'INVALID_DECISION', message: 'decision must be "approved" or "rejected"' } }, 400);
  }

  // Verify approval belongs to tenant
  let approval: any;
  await withTenant(ctx, async (db) => {
    approval = await getApproval(db, approvalId);
  });

  if (!approval) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'approval not found' } }, 404);
  }

  await handleApprovalDecision(ctx, approvalId, decision, note, ctx.userId ?? null);

  return c.json({ status: 'ok', decision });
}
