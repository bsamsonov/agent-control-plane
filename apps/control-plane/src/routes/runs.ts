/**
 * GET /api/runs/:id — run detail + steps + audit entries.
 * GET /api/runs/:id/stream — SSE of step events.
 */
import type { Context } from 'hono';
import type { TenantContext } from '@macp/db';
import { withTenant, getRun, listAudit } from '@macp/db';

export async function getRunDetail(c: Context, ctx: TenantContext): Promise<Response> {
  const runId = c.req.param('id')!;

  let run: any;
  let steps: any[] = [];
  let audit: any[] = [];

  await withTenant(ctx, async (db) => {
    run = await getRun(db, runId);
    if (!run) throw Object.assign(new Error('run not found'), { status: 404 });

    const { rows } = await db.query(
      `SELECT step_id AS "stepId", status, output, attempt, created_at AS "createdAt"
       FROM step_results WHERE run_id = $1 ORDER BY created_at`,
      [runId],
    );
    steps = rows;

    audit = await listAudit(db, { runId, limit: 100 });
  });

  return c.json({ run, steps, audit });
}

export async function streamRun(c: Context, ctx: TenantContext): Promise<Response> {
  const runId = c.req.param('id')!;

  // Verify run exists
  let exists = false;
  await withTenant(ctx, async (db) => {
    const run = await getRun(db, runId);
    exists = !!run;
  });
  if (!exists) return c.json({ error: { code: 'NOT_FOUND', message: 'run not found' } }, 404);

  // SSE stream — polls the run every 500 ms. Events (one JSON object per `data:` line):
  //   {event:'step',     data:{stepId, status, attempt, createdAt, policy?, durationMs?}}
  //   {event:'approval', data:{stepId, status:'awaiting_approval', policy?}}  run suspended
  //   {event:'end',      status, error?}                                     run finished
  // `policy` is the latest audit decision for that step; durationMs sums MCP latencies.
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      let lastCount = 0;
      let announcedApproval: string | null = null;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(interval);
        clearTimeout(timeout);
        controller.close();
      };

      const policyFor = async (db: import('pg').PoolClient, stepId: string) => {
        const { rows } = await db.query(
          `SELECT decision AS effect, rule_id AS "ruleId", reason,
                  SUM(latency_ms) OVER () AS "durationMs"
           FROM audit_log WHERE run_id = $1 AND step_id = $2
           ORDER BY ts DESC, id DESC LIMIT 1`,
          [runId, stepId],
        );
        const r = rows[0] as { effect: string; ruleId: string | null; reason: string | null; durationMs: string | null } | undefined;
        if (!r) return {};
        return {
          policy: { effect: r.effect, ruleId: r.ruleId ?? '', reason: r.reason ?? '' },
          ...(r.durationMs != null ? { durationMs: Number(r.durationMs) } : {}),
        };
      };

      const interval = setInterval(async () => {
        if (closed) return;
        try {
          await withTenant(ctx, async (db) => {
            const { rows } = await db.query(
              `SELECT step_id AS "stepId", status, attempt, created_at AS "createdAt"
               FROM step_results WHERE run_id = $1 ORDER BY created_at`,
              [runId],
            );

            for (let i = lastCount; i < rows.length; i++) {
              const row = rows[i] as { stepId: string };
              send({ event: 'step', data: { ...row, ...(await policyFor(db, row.stepId)) } });
            }
            lastCount = rows.length;

            const run = await getRun(db, runId);
            if (run?.status === 'suspended' && run.cursorStep && announcedApproval !== run.cursorStep) {
              announcedApproval = run.cursorStep;
              send({
                event: 'approval',
                data: { stepId: run.cursorStep, status: 'awaiting_approval', ...(await policyFor(db, run.cursorStep)) },
              });
            }
            if (run && ['done', 'failed', 'compensated'].includes(run.status)) {
              send({ event: 'end', status: run.status, ...(run.error ? { error: run.error } : {}) });
              close();
            }
          });
        } catch {
          close();
        }
      }, 500);

      // A run can wait for a human for a while; keep the stream open up to 5 minutes.
      const timeout = setTimeout(close, 5 * 60_000);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
