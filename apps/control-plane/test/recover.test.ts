/**
 * Boot recovery test — `recoverRuns()` resumes runs left in 'running' by a crash.
 *
 * A run that reached 'done' is rewound to 'running' with its cursor at
 * `send_email` and that step's ledger entry removed, simulating a process that
 * died the instant before the irreversible step. `recoverRuns()` is then asked
 * to bring it back. The proof it works: the run returns to 'done' and the steps
 * that already recorded an `ok` ledger row are not re-executed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startMcpServer } from '@macp/mcp-common';
import {
  withTenant,
  withAdmin,
  createCampaign,
  createRun,
  getRun,
  getStepResult,
  saveSnapshot,
  migrate,
  seed,
  closePools,
} from '@macp/db';
import type { TenantContext } from '@macp/db';
import { setMcpServers, closeAllClients } from '../src/mcp-client.js';
import { executeWorkflow, recoverRuns } from '../src/workflow.js';
import { registerCrm, registerEsp, registerAnalytics, resetEspState } from './helpers.js';

const globexCtx: TenantContext = {
  tenantId: '22222222-2222-2222-2222-222222222222',
  actor: 'marketer@globex.test',
  actorRole: 'marketer',
};

describe('Boot recovery (recoverRuns)', () => {
  let servers: Array<{ close(): Promise<void> }> = [];

  beforeAll(async () => {
    await migrate();
    await seed();

    const crm = await startMcpServer({ name: 'crm-rcv', version: '0.0.0', port: 0, register: registerCrm, requireAuth: true });
    servers.push(crm);
    const esp = await startMcpServer({ name: 'esp-rcv', version: '0.0.0', port: 0, register: registerEsp, requireAuth: true });
    servers.push(esp);
    const analytics = await startMcpServer({ name: 'analytics-rcv', version: '0.0.0', port: 0, register: registerAnalytics, requireAuth: false });
    servers.push(analytics);

    setMcpServers({ crm: crm.url, esp: esp.url, analytics: analytics.url, 'segment-py': 'http://127.0.0.1:31999' });
  });

  afterAll(async () => {
    await closeAllClients();
    for (const s of servers) await s.close();
    await closePools();
  });

  it('resumes a run interrupted mid-execution, skipping completed steps', async () => {
    resetEspState();

    let campaignId: string;
    let runId: string;
    await withTenant(globexCtx, async (c) => {
      campaignId = await createCampaign(c, 'Recover test brief', null);
      runId = await createRun(c, campaignId!);
    });

    // 1. Let the run complete normally — globex policy never requires approval,
    //    so a single executeWorkflow call reaches 'done' and leaves a full
    //    snapshot + a complete step_results ledger.
    await executeWorkflow(globexCtx, runId!, campaignId!, 'Re-engage inactive users, budget $500');

    let run: any;
    await withTenant(globexCtx, async (c) => { run = await getRun(c, runId!); });
    expect(run!.status).toBe('done');

    const snapshot = run!.snapshot;

    // 2. Rewind: pretend the process crashed right before send_email. Drop the
    //    ledger entries for the steps that hadn't persisted yet and set the run
    //    back to 'running' at the cursor. The snapshot already holds the
    //    outputs of the completed steps, so resume can use them.
    await withTenant(globexCtx, async (c) => {
      await c.query(
        `DELETE FROM step_results WHERE run_id = $1 AND step_id IN ('send_email','analytics','summarize')`,
        [runId],
      );
      await saveSnapshot(c, runId, snapshot, 'running', 'send_email');
    });

    // 3. Boot recovery — same call server.ts makes on startup.
    await recoverRuns();

    // 4. Poll for completion. recoverRuns fires executeWorkflow async.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      await withTenant(globexCtx, async (c) => { run = await getRun(c, runId!); });
      if (['done', 'failed', 'compensated'].includes(run!.status)) break;
    }
    expect(['done', 'compensated']).toContain(run!.status);

    // 5. Completed steps were skipped (attempt still 1); the rewound steps ran.
    await withTenant(globexCtx, async (c) => {
      const plan = await getStepResult(c, runId!, 'plan');
      const content = await getStepResult(c, runId!, 'content');
      const create = await getStepResult(c, runId!, 'create_campaign');
      const send = await getStepResult(c, runId!, 'send_email');
      const analyticsStep = await getStepResult(c, runId!, 'analytics');
      const summarize = await getStepResult(c, runId!, 'summarize');

      expect(plan!.attempt).toBe(1);
      expect(content!.attempt).toBe(1);
      expect(create!.attempt).toBe(1);
      expect(send!.status).toBe('ok');
      expect(analyticsStep!.status).toBe('ok');
      expect(summarize!.status).toBe('ok');
    });
  });

  it('is a no-op when no runs are interrupted', async () => {
    // Clean slate from the previous test's run — none left 'running'.
    await recoverRuns();
    // Nothing to assert beyond "it did not throw and did not resurrect a run";
    // the call resolves and the suite stays green.
    const { rows } = await withAdmin(async (c) =>
      c.query(`SELECT id FROM workflow_runs WHERE status = 'running'`),
    );
    expect(rows.length).toBe(0);
  });
});