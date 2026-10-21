/**
 * Policy Decision Point enforcement — guardedCall.
 *
 * Every MCP tool invocation passes through this function. It evaluates the
 * tenant's policy, writes an audit log row for every outcome (with redacted
 * args), and only on `allow` performs the actual MCP call. On
 * `require_approval` it creates a pending approval row.
 */
import { evaluate, redactArgs } from '@macp/policy';
import type { PolicyDecision, PolicyInput } from '@macp/policy';
import {
  withTenant,
  getPolicy,
  getBudget,
  insertAudit,
  createApproval,
} from '@macp/db';
import type { TenantContext, AuditRow, NewApproval } from '@macp/db';
import { callTool } from './mcp-client.js';

export type GuardResult =
  | { effect: 'allow'; result: unknown; decision: PolicyDecision }
  | { effect: 'deny'; decision: PolicyDecision }
  | { effect: 'require_approval'; decision: PolicyDecision; approvalId: string };

/**
 * Parse a fully-qualified tool name "esp.send_email" into { server, tool }.
 * The server part is used by mcp-client to locate the MCP endpoint.
 */
function parseTool(fullTool: string): { server: string; tool: string } {
  const dot = fullTool.indexOf('.');
  if (dot === -1) return { server: fullTool, tool: fullTool };
  return { server: fullTool.slice(0, dot), tool: fullTool.slice(dot + 1) };
}

function tenantSlugFor(tenantId: string): string {
  const TENANT_UUID_TO_SLUG: Record<string, string> = {
    '11111111-1111-1111-1111-111111111111': 'acme',
    '22222222-2222-2222-2222-222222222222': 'globex',
  };
  return TENANT_UUID_TO_SLUG[tenantId] ?? tenantId;
}

/**
 * Enforce policy and (on allow) perform the MCP call.
 *
 * @param ctx      Tenant context (who is acting)
 * @param runId    Optional workflow run for correlation
 * @param stepId   Workflow step id (for approval idempotency)
 * @param agentId  Agent id (e.g. "planner", "channel")
 * @param tool     Fully qualified tool name (e.g. "esp.send_email")
 * @param args     Raw tool arguments (before redaction)
 */
export async function guardedCall(
  ctx: TenantContext,
  runId: string | null,
  stepId: string,
  agentId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<GuardResult> {
  const t0 = Date.now();

  // ---- load policy + budget (inside tenant scope) ----
  let policyDoc: any;
  let budget: any;
  await withTenant(ctx, async (c) => {
    policyDoc = await getPolicy(c);
    budget = await getBudget(c);
  });

  // ---- evaluate ----
  const policyInput: PolicyInput = {
    tenantId: ctx.tenantId,
    actor: ctx.actor,
    actorRole: ctx.actorRole,
    agentId,
    tool,
    args,
    budget,
    now: new Date().toISOString(),
  };
  const decision = evaluate(policyDoc!, policyInput);

  // Redact args for audit/approval persistence
  const redacted = decision.redact.length > 0
    ? redactArgs(args, decision.redact)
    : args;

  // ---- write audit row (every outcome) ----
  const latencyMs = Date.now() - t0;
  const auditRow: AuditRow = {
    tenantId: ctx.tenantId,
    runId,
    stepId,
    actor: ctx.actor,
    actorRole: ctx.actorRole,
    agentId,
    tool,
    argsRedacted: redacted,
    decision: decision.effect,
    reason: decision.reason,
    ruleId: decision.ruleId,
    latencyMs,
  };

  await withTenant(ctx, async (c) => {
    await insertAudit(c, auditRow);
  });

  // ---- route by effect ----
  if (decision.effect === 'deny') {
    return { effect: 'deny', decision };
  }

  if (decision.effect === 'require_approval') {
    // Check if an approval already exists (resume case)
    let existingStatus: string | null = null;
    let approvalId: string = '';
    if (runId) {
      // Query approval via the app pool (inside withTenant for RLS)
      await withTenant(ctx, async (c) => {
        const { rows } = await c.query(
          `SELECT id, status FROM approvals WHERE run_id = $1 AND step_id = $2`,
          [runId, stepId],
        );
        if (rows[0]) {
          approvalId = (rows[0] as any).id;
          existingStatus = (rows[0] as any).status;
        }
      });
    }

    if (existingStatus === 'approved') {
      // Already approved — proceed as allow
      const { server, tool: toolName } = parseTool(tool);
      const TENANT_UUID_TO_SLUG: Record<string, string> = {
        '11111111-1111-1111-1111-111111111111': 'acme',
        '22222222-2222-2222-2222-222222222222': 'globex',
      };
      const tenantSlug = TENANT_UUID_TO_SLUG[ctx.tenantId] ?? ctx.tenantId;
      const result = await callTool(tenantSlug, server, toolName, args);
      return { effect: 'allow', result, decision };
    }

    if (existingStatus === 'pending') {
      // Existing approval still pending — return its id
      return { effect: 'require_approval', decision, approvalId };
    }

    // Create new approval row
    await withTenant(ctx, async (c) => {
      const newApproval: NewApproval = {
        tenantId: ctx.tenantId,
        runId: runId ?? '',
        stepId,
        agentId,
        tool,
        argsRedacted: redacted,
        reason: decision.reason,
      };
      approvalId = await createApproval(c, newApproval);
    });
    return { effect: 'require_approval', decision, approvalId: approvalId || '' };
  }

  // effect === 'allow' — make the actual MCP call
  const { server, tool: toolName } = parseTool(tool);

  // Map tenant UUID to slug (OAuth flow uses slugs)
  const tenantSlug = tenantSlugFor(ctx.tenantId);
  const result = await callTool(tenantSlug, server, toolName, args);
  return { effect: 'allow', result, decision };
}

/**
 * Execute a tool call that a human has already approved.
 *
 * The approval IS the policy decision — the PDP is NOT re-evaluated for this
 * call. Re-evaluating under the approver's context would silently elevate the
 * run's privileges (an admin approving a marketer's request would be allowed
 * by an admin rule, hiding the fact that the only authority for the call was
 * the human approval). Re-evaluating under the initiator's context would just
 * reproduce the original `require_approval` decision and loop.
 *
 * The policy is still loaded, but only to obtain the `redact` paths so the
 * audit row masks the same fields the original request masked. The effect is
 * ignored. The audit row records `approved_by_human` with a reference to the
 * approval id, so the trail shows *why* a call that the PDP would have gated
 * actually ran.
 *
 * @param approvalId  The approvals.id that authorised this call.
 */
export async function approvedCall(
  ctx: TenantContext,
  runId: string | null,
  stepId: string,
  agentId: string,
  tool: string,
  args: Record<string, unknown>,
  approvalId: string,
): Promise<{ effect: 'allow'; result: unknown; decision: PolicyDecision }> {
  const t0 = Date.now();

  // Load policy + budget only to derive redact paths. The effect is deliberately
  // discarded — the human decision overrides it.
  let policyDoc: any;
  let budget: any;
  await withTenant(ctx, async (c) => {
    policyDoc = await getPolicy(c);
    budget = await getBudget(c);
  });

  const policyInput: PolicyInput = {
    tenantId: ctx.tenantId,
    actor: ctx.actor,
    actorRole: ctx.actorRole,
    agentId,
    tool,
    args,
    budget,
    now: new Date().toISOString(),
  };
  const original = evaluate(policyDoc!, policyInput);

  const redacted = original.redact.length > 0
    ? redactArgs(args, original.redact)
    : args;

  const decision: PolicyDecision = {
    effect: 'allow',
    ruleId: 'human_approval',
    reason: `human approval ${approvalId} overrides PDP (original decision: ${original.effect}${original.ruleId && original.ruleId !== 'default' ? ` by rule ${original.ruleId}` : ''})`,
    redact: original.redact,
  };

  await withTenant(ctx, async (c) => {
    await insertAudit(c, {
      tenantId: ctx.tenantId,
      runId,
      stepId,
      actor: ctx.actor,
      actorRole: ctx.actorRole,
      agentId,
      tool,
      argsRedacted: redacted,
      decision: 'approved_by_human',
      reason: decision.reason,
      ruleId: 'human_approval',
      latencyMs: Date.now() - t0,
    });
  });

  // Same order as guardedCall: the decision is persisted before the effect, so a call
  // that fails (or a process that dies mid-call) still leaves the human override on record.
  const { server, tool: toolName } = parseTool(tool);
  const tenantSlug = tenantSlugFor(ctx.tenantId);
  const result = await callTool(tenantSlug, server, toolName, args);

  return { effect: 'allow', result, decision };
}
