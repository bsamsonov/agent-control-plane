/**
 * Thin data-access functions. Every function takes a PoolClient (already
 * inside a withTenant/withAdmin transaction) and never opens its own tx.
 *
 * Row types are camelCase mirrors of the SQL columns.
 */
import type { PoolClient } from 'pg';
import type { PolicyDocument, BudgetState } from '@macp/policy';

// ------------------------------------------------------------------ row types

export interface AuditRow {
  id?: number;
  tenantId: string;
  runId?: string | null;
  stepId?: string | null;
  actor: string;
  actorRole?: string | null;
  agentId?: string | null;
  tool?: string | null;
  argsRedacted?: unknown;
  decision: string;
  reason?: string | null;
  ruleId?: string | null;
  latencyMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  ts?: Date;
}

export interface RunRow {
  id: string;
  tenantId: string;
  campaignId: string;
  workflowName: string;
  status: string;
  snapshot: unknown;
  cursorStep: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StepRow {
  runId: string;
  stepId: string;
  tenantId: string;
  attempt: number;
  status: 'ok' | 'failed' | 'compensated';
  output: unknown;
  createdAt: Date;
}

export interface ApprovalRow {
  id: string;
  tenantId: string;
  runId: string;
  stepId: string;
  agentId: string;
  tool: string;
  argsRedacted: unknown;
  reason: string;
  status: string;
  requestedAt: Date;
  decidedBy: string | null;
  decisionNote: string | null;
  decidedAt: Date | null;
}

export interface NewApproval {
  tenantId: string;
  runId: string;
  stepId: string;
  agentId: string;
  tool: string;
  argsRedacted: unknown;
  reason: string;
}

// -------------------------------------------------------- helpers

function toNum(v: unknown): number {
  return typeof v === 'string' ? Number(v) : (v as number);
}

// -------------------------------------------------------- audit_log

export async function insertAudit(c: PoolClient, row: AuditRow): Promise<void> {
  await c.query(
    `INSERT INTO audit_log
       (tenant_id, run_id, step_id, actor, actor_role, agent_id, tool,
        args_redacted, decision, reason, rule_id,
        latency_ms, tokens_in, tokens_out, cost_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      row.tenantId, row.runId ?? null, row.stepId ?? null,
      row.actor, row.actorRole ?? null, row.agentId ?? null, row.tool ?? null,
      row.argsRedacted ? JSON.stringify(row.argsRedacted) : null,
      row.decision, row.reason ?? null, row.ruleId ?? null,
      row.latencyMs ?? null, row.tokensIn ?? null, row.tokensOut ?? null,
      row.costUsd ?? null,
    ],
  );
}

export async function listAudit(
  c: PoolClient,
  opts: { limit?: number; runId?: string } = {},
): Promise<AuditRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (opts.runId) {
    clauses.push(`run_id = $${i++}`);
    params.push(opts.runId);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = opts.limit ? `LIMIT $${i++}` : '';
  if (opts.limit) params.push(opts.limit);

  const { rows } = await c.query(
    `SELECT id,
            tenant_id   AS "tenantId",
            run_id      AS "runId",
            step_id     AS "stepId",
            actor,
            actor_role  AS "actorRole",
            agent_id    AS "agentId",
            tool,
            args_redacted AS "argsRedacted",
            decision,
            reason,
            rule_id     AS "ruleId",
            latency_ms  AS "latencyMs",
            tokens_in   AS "tokensIn",
            tokens_out  AS "tokensOut",
            cost_usd    AS "costUsd",
            ts
     FROM audit_log ${where} ORDER BY ts DESC ${limit}`,
    params,
  );
  return rows as AuditRow[];
}

// -------------------------------------------------------- campaigns

export async function createCampaign(
  c: PoolClient,
  brief: string,
  createdBy: string | null,
): Promise<string> {
  const { rows } = await c.query(
    `INSERT INTO campaigns (tenant_id, brief, created_by)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2)
     RETURNING id`,
    [brief, createdBy ?? null],
  );
  return (rows[0] as { id: string }).id;
}

export async function setCampaignStatus(
  c: PoolClient,
  campaignId: string,
  status: string,
): Promise<void> {
  await c.query(`UPDATE campaigns SET status = $1 WHERE id = $2`, [status, campaignId]);
}

// -------------------------------------------------------- workflow_runs

export async function createRun(
  c: PoolClient,
  campaignId: string,
): Promise<string> {
  const { rows } = await c.query(
    `INSERT INTO workflow_runs (tenant_id, campaign_id)
     VALUES (current_setting('app.tenant_id')::uuid, $1)
     RETURNING id`,
    [campaignId],
  );
  return (rows[0] as { id: string }).id;
}

export async function getRun(c: PoolClient, runId: string): Promise<RunRow | null> {
  const { rows } = await c.query(
    `SELECT id,
            tenant_id      AS "tenantId",
            campaign_id    AS "campaignId",
            workflow_name  AS "workflowName",
            status,
            snapshot,
            cursor_step    AS "cursorStep",
            error,
            created_at     AS "createdAt",
            updated_at     AS "updatedAt"
     FROM workflow_runs WHERE id = $1`,
    [runId],
  );
  return (rows[0] as RunRow) ?? null;
}

export async function saveSnapshot(
  c: PoolClient,
  runId: string,
  snapshot: unknown,
  status: string,
  cursorStep: string | null,
): Promise<void> {
  await c.query(
    `UPDATE workflow_runs
     SET snapshot = $1, status = $2, cursor_step = $3, updated_at = now()
     WHERE id = $4`,
    [JSON.stringify(snapshot), status, cursorStep, runId],
  );
}

export async function listRuns(
  c: PoolClient,
  opts?: { status?: string },
): Promise<RunRow[]> {
  const params: unknown[] = [];
  let where = '';
  if (opts?.status) {
    where = 'WHERE status = $1';
    params.push(opts.status);
  }
  const { rows } = await c.query(
    `SELECT id,
            tenant_id      AS "tenantId",
            campaign_id    AS "campaignId",
            workflow_name  AS "workflowName",
            status,
            snapshot,
            cursor_step    AS "cursorStep",
            error,
            created_at     AS "createdAt",
            updated_at     AS "updatedAt"
     FROM workflow_runs ${where} ORDER BY created_at DESC`,
    params,
  );
  return rows as RunRow[];
}

// -------------------------------------------------------- step_results

export async function getStepResult(
  c: PoolClient,
  runId: string,
  stepId: string,
): Promise<StepRow | null> {
  const { rows } = await c.query(
    `SELECT run_id       AS "runId",
            step_id      AS "stepId",
            tenant_id    AS "tenantId",
            attempt,
            status,
            output,
            created_at   AS "createdAt"
     FROM step_results WHERE run_id = $1 AND step_id = $2`,
    [runId, stepId],
  );
  return (rows[0] as StepRow) ?? null;
}

export async function putStepResult(
  c: PoolClient,
  runId: string,
  stepId: string,
  status: 'ok' | 'failed' | 'compensated',
  output: unknown,
): Promise<void> {
  await c.query(
    `INSERT INTO step_results (tenant_id, run_id, step_id, status, output)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4)
     ON CONFLICT (run_id, step_id)
     DO UPDATE SET status = $3, output = $4, attempt = step_results.attempt + 1`,
    [runId, stepId, status, JSON.stringify(output)],
  );
}

// -------------------------------------------------------- approvals

export async function createApproval(
  c: PoolClient,
  a: NewApproval,
): Promise<string> {
  const { rows } = await c.query(
    `INSERT INTO approvals
       (tenant_id, run_id, step_id, agent_id, tool, args_redacted, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id`,
    [a.tenantId, a.runId, a.stepId, a.agentId, a.tool,
     JSON.stringify(a.argsRedacted), a.reason],
  );
  return (rows[0] as { id: string }).id;
}

export async function listApprovals(
  c: PoolClient,
  status?: string,
): Promise<ApprovalRow[]> {
  const params: unknown[] = [];
  let where = '';
  if (status) {
    where = 'WHERE status = $1';
    params.push(status);
  }
  const { rows } = await c.query(
    `SELECT id,
            tenant_id       AS "tenantId",
            run_id          AS "runId",
            step_id         AS "stepId",
            agent_id        AS "agentId",
            tool,
            args_redacted   AS "argsRedacted",
            reason,
            status,
            requested_at    AS "requestedAt",
            decided_by      AS "decidedBy",
            decision_note   AS "decisionNote",
            decided_at      AS "decidedAt"
     FROM approvals ${where} ORDER BY requested_at DESC`,
    params,
  );
  return rows as ApprovalRow[];
}

export async function getApproval(
  c: PoolClient,
  id: string,
): Promise<ApprovalRow | null> {
  const { rows } = await c.query(
    `SELECT id,
            tenant_id       AS "tenantId",
            run_id          AS "runId",
            step_id         AS "stepId",
            agent_id        AS "agentId",
            tool,
            args_redacted   AS "argsRedacted",
            reason,
            status,
            requested_at    AS "requestedAt",
            decided_by      AS "decidedBy",
            decision_note   AS "decisionNote",
            decided_at      AS "decidedAt"
     FROM approvals WHERE id = $1`,
    [id],
  );
  return (rows[0] as ApprovalRow) ?? null;
}

export async function decideApproval(
  c: PoolClient,
  id: string,
  decision: 'approved' | 'rejected',
  decidedBy: string | null,
  note: string | null,
): Promise<ApprovalRow | null> {
  const { rows } = await c.query(
    `UPDATE approvals
     SET status = $1, decided_by = $2, decision_note = $3, decided_at = now()
     WHERE id = $4
     RETURNING id,
               tenant_id       AS "tenantId",
               run_id          AS "runId",
               step_id         AS "stepId",
               agent_id        AS "agentId",
               tool,
               args_redacted   AS "argsRedacted",
               reason,
               status,
               requested_at    AS "requestedAt",
               decided_by      AS "decidedBy",
               decision_note   AS "decisionNote",
               decided_at      AS "decidedAt"`,
    [decision, decidedBy, note, id],
  );
  return (rows[0] as ApprovalRow) ?? null;
}

// -------------------------------------------------------- policy & budget

export async function getPolicy(c: PoolClient): Promise<PolicyDocument> {
  const { rows } = await c.query(`SELECT rule_json FROM policies`);
  if (!rows[0]) throw new Error('no policy found for tenant');
  return (rows[0] as { rule_json: PolicyDocument }).rule_json;
}

export async function getBudget(c: PoolClient): Promise<BudgetState> {
  const { rows } = await c.query(
    `SELECT limit_usd AS "limitUsd", spent_usd AS "spentUsd"
     FROM budget_state`,
  );
  if (!rows[0]) throw new Error('no budget found for tenant');
  const r = rows[0] as { limitUsd: unknown; spentUsd: unknown };
  return {
    limitUsd: toNum(r.limitUsd),
    spentUsd: toNum(r.spentUsd),
  };
}

export async function addSpend(c: PoolClient, amountUsd: number): Promise<void> {
  await c.query(
    `UPDATE budget_state SET spent_usd = spent_usd + $1, updated_at = now()`,
    [amountUsd],
  );
}
