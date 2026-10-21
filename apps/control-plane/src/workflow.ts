/**
 * Durable workflow engine — plain TypeScript step engine over Postgres.
 *
 * Steps: plan → segment → content → create_campaign → send_email → analytics → summarize.
 *
 * Every step's output is persisted via putStepResult BEFORE advancing the cursor.
 * On resume, steps with an existing step_results row are SKIPPED (idempotency).
 * require_approval suspends the run; resume(runId) continues from cursor_step.
 * Transient failures retry 3× with backoff (100/200/400ms); policy denials never retry.
 * send_email failure after budget debit → compensating refund_campaign + status 'compensated'.
 *
 * Mastra is NOT used here — only in agents.ts for LLM agents.
 */
import {
  withTenant,
  getRun,
  saveSnapshot,
  putStepResult,
  getStepResult,
  setCampaignStatus,
  decideApproval,
  createRun as dbCreateRun,
} from '@macp/db';
import type { TenantContext } from '@macp/db';
import type { Role } from '@macp/policy';
import { guardedCall, approvedCall } from './pdp.js';
import type { GuardResult } from './pdp.js';
import { planCampaign, generateContent, summarizeResults } from './agents.js';
import type { PlanOutput, ContentOutput } from './agents.js';
import { callTool, McpToolError } from './mcp-client.js';
import { insertAudit } from '@macp/db';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STEPS = [
  'plan',
  'segment',
  'content',
  'create_campaign',
  'send_email',
  'analytics',
  'summarize',
] as const;
type StepId = (typeof STEPS)[number];

const RETRY_BACKOFF_MS = [100, 200, 400];

// ---------------------------------------------------------------------------
// Snapshot shape — stores workflow-level state for resume
// ---------------------------------------------------------------------------

interface WorkflowSnapshot {
  brief: string;
  /**
   * The principal that started the run. A run suspends for a human approval and is
   * resumed by whoever approves it — but the approval is taken *on behalf of* the
   * initiator, so the resumed step must execute under the initiator's identity, not
   * the approver's. Without this, an admin approving a marketer's request would
   * silently re-evaluate policy as an admin and hide the fact that the only authority
   * for the call was the human approval.
   */
  initiator?: { actor: string; actorRole: Role };
  /**
   * When set, the step `subStepId` was resumed because `approvalId` was granted.
   * The next guarded call for that step bypasses the PDP — the approval IS the
   * decision — and the bypass is consumed immediately after.
   */
  approvedStep?: { subStepId: string; approvalId: string } | null;
  planResult?: PlanOutput;
  segmentResult?: unknown;
  contentResult?: ContentOutput;
  campaignResult?: unknown;
  sendResult?: unknown;
  analyticsResult?: unknown;
  summaryResult?: string;
}

// Tenant UUID to slug mapping (for MCP OAuth)
const TENANT_UUID_TO_SLUG: Record<string, string> = {
  '11111111-1111-1111-1111-111111111111': 'acme',
  '22222222-2222-2222-2222-222222222222': 'globex',
};

function tenantSlug(ctx: TenantContext): string {
  return TENANT_UUID_TO_SLUG[ctx.tenantId] ?? ctx.tenantId;
}

// ---------------------------------------------------------------------------
// Step handlers
// ---------------------------------------------------------------------------

function isSagaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('__FAIL__') || msg.includes('Budget already charged');
}

function stepIndex(stepId: string): number {
  return STEPS.indexOf(stepId as StepId);
}

/**
 * Route a tool call through the PDP, unless this specific sub-step was resumed
 * because a human approved it — in which case the approval is the decision and
 * the PDP is bypassed (see `approvedCall` in pdp.ts). The bypass is consumed
 * once the approved call succeeds, so a later call in the same step re-enters the PDP.
 */
async function enforcedCall(
  ctx: TenantContext,
  snap: WorkflowSnapshot,
  runId: string,
  stepId: string,
  agentId: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<GuardResult> {
  if (snap.approvedStep?.subStepId === stepId) {
    const { approvalId } = snap.approvedStep;
    const result = await approvedCall(ctx, runId, stepId, agentId, tool, args, approvalId);
    // Consumed only once the approved call went through: a retry after a transient
    // failure must reuse the approval, not ask the PDP (and a human) again.
    snap.approvedStep = null;
    return result;
  }
  return guardedCall(ctx, runId, stepId, agentId, tool, args);
}

async function runStep(
  ctx: TenantContext,
  runId: string,
  stepId: StepId,
  snapshot: WorkflowSnapshot,
): Promise<{ action: 'continue' | 'suspend' | 'compensate' | 'fail'; snapshot: WorkflowSnapshot }> {
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await executeStep(ctx, runId, stepId, snapshot);
      if (result === 'suspend') return { action: 'suspend', snapshot };
      if (result === 'compensate') return { action: 'compensate', snapshot };
      // Success — persist step result and advance
      await withTenant(ctx, async (c) => {
        await putStepResult(c, runId, stepId, 'ok', extractOutput(stepId, snapshot));
      });
      return { action: 'continue', snapshot };
    } catch (err) {
      // Policy deny is fatal — don't retry
      if (err instanceof Error && err.message.startsWith('Policy denied')) {
        throw err;
      }

      // Saga: send_email failed after budget charge
      if (stepId === 'send_email' && isSagaError(err)) {
        await compensateSendEmail(ctx, runId, snapshot);
        return { action: 'compensate', snapshot };
      }

      // A failure the tool reported itself (e.g. insufficient budget) is a business
      // outcome; retrying would only repeat it.
      if (err instanceof McpToolError) {
        throw err;
      }

      // Last attempt — fail
      if (attempt === maxRetries - 1) {
        throw err;
      }

      // Retry with backoff
      const delay = RETRY_BACKOFF_MS[attempt] ?? 400;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw new Error(`Step ${stepId} exhausted retries`);
}

function extractOutput(stepId: StepId, snap: WorkflowSnapshot): unknown {
  switch (stepId) {
    case 'plan': return snap.planResult;
    case 'segment': return snap.segmentResult;
    case 'content': return snap.contentResult;
    case 'create_campaign': return snap.campaignResult;
    case 'send_email': return snap.sendResult;
    case 'analytics': return snap.analyticsResult;
    case 'summarize': return snap.summaryResult;
  }
}

/**
 * Execute a single step. Returns:
 *  - undefined on success
 *  - 'suspend' when require_approval
 *  - 'compensate' when saga applies
 *  - throws on fatal error
 */
async function executeStep(
  ctx: TenantContext,
  runId: string,
  stepId: StepId,
  snap: WorkflowSnapshot,
): Promise<void | 'suspend' | 'compensate'> {
  const slug = tenantSlug(ctx);

  switch (stepId) {
    // ---- plan (LLM agent) ----
    case 'plan': {
      const plan = await planCampaign(snap.brief);
      snap.planResult = plan;
      return;
    }

    // ---- segment (MCP calls) ----
    case 'segment': {
      // 1. search_customers
      const searchResult = await enforcedCall(
        ctx, snap, runId, stepId, 'segment', 'crm.search_customers',
        { inactive_days: 90, limit: 20 },
      );
      if (searchResult.effect === 'deny') throw new Error('Policy denied: crm.search_customers');
      if (searchResult.effect === 'require_approval') return 'suspend';

      // 2. get_segment_stats
      const statsResult = await enforcedCall(
        ctx, snap, runId, 'segment-stats', 'segment', 'crm.get_segment_stats',
        { inactive_days: 90 },
      );
      if (statsResult.effect === 'deny') throw new Error('Policy denied: crm.get_segment_stats');
      if (statsResult.effect === 'require_approval') return 'suspend';

      // 3. segment-py (Python MCP, may be unavailable — graceful degradation)
      let scored: unknown = null;
      try {
        scored = await callTool(slug, 'segment-py', 'score_segment', {
          customers: (searchResult.result as any)?.customers ?? [],
          inactive_days: 90,
        });
        if (scored) {
          // Log in audit that segment-py was used
          await withTenant(ctx, async (c) => {
            await insertAudit(c, {
              tenantId: ctx.tenantId,
              runId,
              stepId: 'segment-py',
              actor: ctx.actor,
              actorRole: ctx.actorRole,
              agentId: 'segment-py',
              tool: 'segment-py.score_segment',
              decision: 'allow',
              reason: 'segment-py scoring applied',
            });
          });
        }
      } catch (err) {
        // Log degradation in audit
        await withTenant(ctx, async (c) => {
          await insertAudit(c, {
            tenantId: ctx.tenantId,
            runId,
            stepId: 'segment-py',
            actor: ctx.actor,
            actorRole: ctx.actorRole,
            agentId: 'segment-py',
            tool: 'segment-py.score_segment',
            decision: 'degraded',
            reason: 'segment-py unavailable; using local calculation',
          });
        });

        // Fallback: local deterministic calculation
        const customers = (searchResult.result as any)?.customers ?? [];
        const stats = statsResult.result as any;
        scored = {
          segment_size: customers.length,
          avg_score: customers.length > 0 ? 0.5 : 0,
          tiers: { hot: Math.floor(customers.length * 0.2), warm: Math.floor(customers.length * 0.5), cold: Math.floor(customers.length * 0.3) },
          recommended_budget_usd: Math.round((stats?.size ?? 0) * 0.1 * 100) / 100,
        };
      }

      snap.segmentResult = {
        search: searchResult.result,
        stats: statsResult.result,
        scored,
      };
      return;
    }

    // ---- content (LLM agent) ----
    case 'content': {
      const content = await generateContent(snap.segmentResult);
      snap.contentResult = content;
      return;
    }

    // ---- create_campaign (MCP call) ----
    case 'create_campaign': {
      const content = snap.contentResult!;
      const amount = campaignAmountUsd(snap);
      const result = await enforcedCall(
        ctx, snap, runId, stepId, 'channel', 'esp.create_campaign',
        { name: snap.brief.slice(0, 80), channel: content.channel, amount_usd: amount },
      );
      if (result.effect === 'deny') throw new Error('Policy denied: esp.create_campaign');
      if (result.effect === 'require_approval') return 'suspend';
      snap.campaignResult = result.result;
      return;
    }

    // ---- send_email (MCP call with saga) ----
    case 'send_email': {
      const campaign = snap.campaignResult as any;
      const content = snap.contentResult!;
      const segment = snap.segmentResult as any;
      const recipients = (segment?.search?.customers ?? []).map((c: any) => c.email);
      const amount = campaignAmountUsd(snap);

      const result = await enforcedCall(
        ctx, snap, runId, stepId, 'channel', 'esp.send_email',
        {
          campaign_id: campaign.campaign_id,
          recipients,
          subject: content.subject,
          body: content.body,
          amount_usd: amount,
        },
      );
      if (result.effect === 'deny') throw new Error('Policy denied: esp.send_email');
      if (result.effect === 'require_approval') return 'suspend';
      snap.sendResult = result.result;
      return;
    }

    // ---- analytics (MCP call) ----
    case 'analytics': {
      const campaign = snap.campaignResult as any;
      const result = await enforcedCall(
        ctx, snap, runId, stepId, 'analytics', 'analytics.get_campaign_metrics',
        { campaign_id: campaign.campaign_id },
      );
      if (result.effect === 'deny') throw new Error('Policy denied: analytics.get_campaign_metrics');
      if (result.effect === 'require_approval') return 'suspend';
      snap.analyticsResult = result.result;
      return;
    }

    // ---- summarize (LLM agent) ----
    case 'summarize': {
      const summary = await summarizeResults(snap.analyticsResult);
      snap.summaryResult = summary;
      return;
    }
  }
}

/**
 * The amount a campaign step is charged for. The brief's stated budget wins; the segment
 * scorer's recommendation is only a fallback. This is the number the PDP compares against
 * the tenant's threshold, so it is computed in one place and nowhere else.
 */
function campaignAmountUsd(snap: WorkflowSnapshot): number {
  const stated = (snap.planResult as any)?.budgetUsd;
  if (typeof stated === 'number' && stated > 0) return stated;
  const recommended = (snap.segmentResult as any)?.scored?.recommended_budget_usd;
  return typeof recommended === 'number' && recommended > 0 ? recommended : 250;
}

/**
 * Compensating action: refund the campaign budget after send_email fault.
 * Called directly (not through guardedCall) as a system recovery action.
 */
async function compensateSendEmail(
  ctx: TenantContext,
  runId: string,
  snap: WorkflowSnapshot,
): Promise<void> {
  const campaign = snap.campaignResult as any;
  const amount = campaignAmountUsd(snap);
  const slug = tenantSlug(ctx);

  // Deliberately not routed through the PDP: a compensation is a system recovery action,
  // not an agent request. Blocking a refund on a policy check is how money gets stranded.
  // It is still audited — a compensation that leaves no trace is worse than none.
  let refundOk = true;
  let refundError: string | null = null;
  try {
    await callTool(slug, 'esp', 'refund_campaign', {
      campaign_id: campaign.campaign_id,
      amount_usd: amount,
    });
  } catch (refundErr) {
    refundOk = false;
    refundError = refundErr instanceof Error ? refundErr.message : String(refundErr);
  }

  await withTenant(ctx, async (c) => {
    await insertAudit(c, {
      tenantId: ctx.tenantId,
      runId,
      stepId: 'send_email',
      actor: 'system',
      actorRole: ctx.actorRole,
      agentId: 'compensator',
      tool: 'esp.refund_campaign',
      argsRedacted: { campaign_id: campaign.campaign_id, amount_usd: amount },
      decision: refundOk ? 'compensated' : 'compensation_failed',
      reason: refundOk
        ? `send_email failed after the budget was charged; refunded $${amount}`
        : `refund failed and $${amount} is stranded: ${refundError}`,
    });
  });

  // Persist compensated step
  await withTenant(ctx, async (c) => {
    await putStepResult(c, runId, 'send_email', 'compensated', {
      error: 'Budget charged but send failed; refund issued',
      campaign_id: campaign.campaign_id,
      refunded_amount_usd: amount,
    });
  });
}

// ---------------------------------------------------------------------------
// Public API — runCampaign
// ---------------------------------------------------------------------------

/**
 * Start a new campaign workflow or resume an existing one.
 * Called by the HTTP API and by recoverRuns() on boot.
 */
export async function runCampaign(
  ctx: TenantContext,
  campaignId: string,
  brief: string,
  runId?: string,
): Promise<string> {
  // Create run if not provided
  if (!runId) {
    await withTenant(ctx, async (c) => {
      runId = await dbCreateRun(c, campaignId);
    });
  }

  const rId = runId!;
  // Execute in background — the API call returns immediately, the caller
  // monitors via GET /api/runs/:id
  executeWorkflow(ctx, rId, campaignId, brief).catch((err) => {
    console.error(`Workflow ${rId} failed:`, err);
  });

  return rId;
}

/**
 * Execute the workflow steps sequentially.
 * Exported for tests that need synchronous execution.
 */
export async function executeWorkflow(
  ctx: TenantContext,
  runId: string,
  campaignId: string,
  brief: string,
): Promise<void> {
  const snapshot: WorkflowSnapshot = { brief };

  // Load run state once at start
  let initialRun: any;
  await withTenant(ctx, async (c) => {
    initialRun = await getRun(c, runId);
  });
  if (!initialRun) throw new Error(`Run not found: ${runId}`);

  // If already terminal, stop
  if (['done', 'failed', 'compensated'].includes(initialRun.status)) {
    return;
  }

  // Restore snapshot from DB (for resume)
  if (initialRun.snapshot && typeof initialRun.snapshot === 'object' && Object.keys(initialRun.snapshot).length > 0) {
    Object.assign(snapshot, initialRun.snapshot);
    // Use the original brief from snapshot if this is a resume
    if (snapshot.brief) brief = snapshot.brief;
    if (!snapshot.brief) snapshot.brief = brief;
  }

  // Record the initiator. On a resume the restored snapshot already carries it;
  // on a first run it comes from the caller's context and is persisted with the
  // next snapshot save, so it survives the run for use when an approval comes in.
  if (!snapshot.initiator) {
    snapshot.initiator = { actor: ctx.actor, actorRole: ctx.actorRole };
  }

  for (const stepId of STEPS) {
    // Load current run state (needed each iteration because status changes)
    let currentRun: any;
    await withTenant(ctx, async (c) => {
      currentRun = await getRun(c, runId);
    });

    if (!currentRun) throw new Error(`Run not found: ${runId}`);

    // If run is already done/failed/compensated, stop
    if (['done', 'failed', 'compensated'].includes(currentRun.status)) {
      return;
    }

    // If suspended, stop — wait for resume
    if (currentRun.status === 'suspended') {
      return;
    }

    // Determine starting step from cursor
    if (currentRun.cursorStep) {
      const cursorIdx = stepIndex(currentRun.cursorStep);
      const currentIdx = stepIndex(stepId);
      if (currentIdx < cursorIdx) {
        // This step is before cursor — skip
        continue;
      }
    }

    // Check if step already completed (idempotency)
    let existing: any;
    await withTenant(ctx, async (c) => {
      existing = await getStepResult(c, runId, stepId);
    });

    if (existing) {
      // Restore output to snapshot
      if (existing.status === 'ok') {
        // Already done — skip
        continue;
      }
      if (existing.status === 'compensated') {
        // Already compensated — stop
        await withTenant(ctx, async (c) => {
          await saveSnapshot(c, runId, snapshot, 'compensated', stepId);
          await setCampaignStatus(c, campaignId, 'done');
        });
        return;
      }
    }

    // Execute the step
    try {
      // Save snapshot before step (for resume capability)
      await withTenant(ctx, async (c) => {
        await saveSnapshot(c, runId, snapshot, 'running', stepId);
      });

      const stepResult = await runStep(ctx, runId, stepId, snapshot);

      if (stepResult.action === 'suspend') {
        await withTenant(ctx, async (c) => {
          await saveSnapshot(c, runId, snapshot, 'suspended', stepId);
          await setCampaignStatus(c, campaignId, 'awaiting_approval');
        });
        return;
      }

      if (stepResult.action === 'compensate') {
        await withTenant(ctx, async (c) => {
          await saveSnapshot(c, runId, snapshot, 'compensated', stepId);
          await setCampaignStatus(c, campaignId, 'done');
        });
        return;
      }

      // Update cursor
      await withTenant(ctx, async (c) => {
        await saveSnapshot(c, runId, snapshot, 'running', stepId);
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`run ${runId} failed at ${stepId}: ${errMsg}`);
      await withTenant(ctx, async (c) => {
        await saveSnapshot(c, runId, snapshot, 'failed', stepId);
        // Update run error
        await c.query(`UPDATE workflow_runs SET error = $1 WHERE id = $2`, [errMsg, runId]);
        await setCampaignStatus(c, campaignId, 'failed');
      });
      return;
    }
  }

  // All steps done
  await withTenant(ctx, async (c) => {
    await saveSnapshot(c, runId, snapshot, 'done', 'summarize');
    await setCampaignStatus(c, campaignId, 'done');
  });
}

// ---------------------------------------------------------------------------
// Public API — resumeRun
// ---------------------------------------------------------------------------

/**
 * Resume a suspended run (after approval decision).
 *
 * @param approvedStep  When resuming because a human approved a step, this is
 *   `{ subStepId, approvalId }`. The resumed step then bypasses the PDP and is
 *   audited as `approved_by_human` — the approval is the decision, so re-running
 *   policy would either loop (under the initiator) or silently elevate the run
 *   (under the approver). Either outcome defeats the point of the approval.
 */
export async function resumeRun(
  ctx: TenantContext,
  runId: string,
  approvedStep?: { subStepId: string; approvalId: string },
): Promise<void> {
  let run: any;
  await withTenant(ctx, async (c) => {
    run = await getRun(c, runId);
  });

  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status !== 'suspended') throw new Error(`Run ${runId} is not suspended`);

  // The resumed step executes under the run's ORIGINAL initiator, not whoever
  // happened to click approve. `ctx` here is the approver; using it would, for
  // an admin approving a marketer's request, run the call as an admin.
  const snap: WorkflowSnapshot = (run.snapshot && typeof run.snapshot === 'object')
    ? run.snapshot
    : { brief: '' };
  const initiatorCtx: TenantContext = {
    tenantId: run.tenantId,
    actor: snap.initiator?.actor ?? ctx.actor,
    actorRole: snap.initiator?.actorRole ?? ctx.actorRole,
  };

  if (approvedStep) snap.approvedStep = approvedStep;

  // Transition from suspended back to running before continuing
  await withTenant(ctx, async (c) => {
    await saveSnapshot(c, runId, snap, 'running', run.cursorStep);
  });

  // Continue execution from the cursor under the initiator's identity
  executeWorkflow(initiatorCtx, runId, run.campaignId, '').catch((err) => {
    console.error(`Resume workflow ${runId} failed:`, err);
  });
}

// ---------------------------------------------------------------------------
// Public API — decideApproval and continue
// ---------------------------------------------------------------------------

/**
 * Decide on an approval and, if approved, resume the run.
 */
export async function handleApprovalDecision(
  ctx: TenantContext,
  approvalId: string,
  decision: 'approved' | 'rejected',
  note: string | null,
  /** users.id of the approver. Null for a system decision; never an email address. */
  decidedBy: string | null = null,
): Promise<void> {
  let approval: any;
  await withTenant(ctx, async (c) => {
    approval = await decideApproval(c, approvalId, decision, decidedBy, note);
  });

  if (!approval) throw new Error(`Approval not found: ${approvalId}`);

  if (decision === 'approved') {
    // Resume the run. The approval's step id tells the workflow which call to
    // bypass (for the segment step there can be more than one guarded call, so
    // matching by the approval's own step id is the precise marker).
    await resumeRun(ctx, approval.runId, { subStepId: approval.stepId, approvalId: approval.id });
  }
  // If rejected, the run stays suspended — caller can decide what to do
}

// ---------------------------------------------------------------------------
// Public API — recoverRuns (boot-time recovery)
// ---------------------------------------------------------------------------

/**
 * On boot, recover any runs that were left in 'running' status — the process
 * died mid-execution (crash, OOM-kill, deploy). State is durable in Postgres:
 * the idempotency ledger already-done steps and the cursor marks where to pick
 * up, so resuming re-enters `executeWorkflow` which skips completed steps.
 *
 * Runs are tenant-scoped, but this query must cross tenants, so it uses the
 * admin pool to enumerate them and reconstructs each initiator context from
 * the snapshot. A run whose snapshot lacks an initiator (older rows from before
 * that field existed) is resumed as a system principal rather than dropped.
 */
export async function recoverRuns(): Promise<void> {
  const { getAdminPool } = await import('@macp/db');
  const adminPool = getAdminPool();
  const { rows } = await adminPool.query(
    `SELECT id, tenant_id, campaign_id, snapshot, cursor_step AS "cursorStep"
     FROM workflow_runs WHERE status = 'running'`,
  );

  if (rows.length === 0) return;

  console.log(`control-plane: recovering ${rows.length} interrupted run(s)`);

  for (const row of rows) {
    const snap: WorkflowSnapshot | Record<string, never> =
      (row.snapshot && typeof row.snapshot === 'object') ? row.snapshot : {};
    const initiator = (snap as WorkflowSnapshot).initiator;
    const ctx: TenantContext = {
      tenantId: row.tenant_id,
      actor: initiator?.actor ?? 'system',
      actorRole: initiator?.actorRole ?? 'admin',
    };
    const brief = (snap as WorkflowSnapshot).brief ?? '';
    // executeWorkflow re-reads the run under the tenant scope, skips completed
    // steps via the ledger, and resumes from cursorStep. Fire-and-forget: boot
    // must not block on a run that may take seconds to finish.
    executeWorkflow(ctx, row.id, row.campaign_id, brief).catch((err) => {
      console.error(`Recovery of run ${row.id} failed:`, err);
    });
  }
}
