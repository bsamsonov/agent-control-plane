/**
 * Workflow resume durability test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startMcpServer } from '@macp/mcp-common';
import {
  withTenant,
  createCampaign,
  createRun,
  getRun,
  getStepResult,
  listApprovals,
  decideApproval,
  migrate,
  seed,
  closePools,
} from '@macp/db';
import type { TenantContext } from '@macp/db';
import { setMcpServers, closeAllClients } from '../src/mcp-client.js';
import { executeWorkflow, handleApprovalDecision } from '../src/workflow.js';
import { registerCrm, registerEsp, registerAnalytics, resetEspState } from './helpers.js';

const acmeCtx: TenantContext = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  actor: 'marketer@acme.test',
  actorRole: 'marketer',
};

describe('Workflow resume durability', () => {
  let servers: Array<{ close(): Promise<void> }> = [];

  beforeAll(async () => {
    await migrate();
    await seed();

    const crm = await startMcpServer({ name: 'crm-wf', version: '0.0.0', port: 0, register: registerCrm, requireAuth: true });
    servers.push(crm);

    const esp = await startMcpServer({ name: 'esp-wf', version: '0.0.0', port: 0, register: registerEsp, requireAuth: true });
    servers.push(esp);

    const analytics = await startMcpServer({ name: 'analytics-wf', version: '0.0.0', port: 0, register: registerAnalytics, requireAuth: false });
    servers.push(analytics);

    setMcpServers({ crm: crm.url, esp: esp.url, analytics: analytics.url, 'segment-py': 'http://127.0.0.1:31999' });
  });

  afterAll(async () => {
    await closeAllClients();
    for (const s of servers) await s.close();
    await closePools();
  });

  it('suspends on require_approval and resumes without re-executing completed steps', async () => {
    resetEspState();

    let campaignId: string;
    let runId: string;
    await withTenant(acmeCtx, async (c) => {
      campaignId = await createCampaign(c, 'Resume test brief', null);
      runId = await createRun(c, campaignId!);
    });

    // Execute workflow — it will suspend on send_email (amount > $100 for acme marketer)
    await executeWorkflow(acmeCtx, runId!, campaignId!, 'Re-engage inactive users with a special offer, budget $500');

    // Verify run suspended
    let run: any;
    await withTenant(acmeCtx, async (c) => { run = await getRun(c, runId!); });
    expect(run!.status).toBe('suspended');
    expect(run!.cursorStep).toBe('send_email');

    // Verify pre-suspension steps completed
    let planStep: any, segmentStep: any, contentStep: any, createStep: any, sendStep: any;
    await withTenant(acmeCtx, async (c) => {
      planStep = await getStepResult(c, runId!, 'plan');
      segmentStep = await getStepResult(c, runId!, 'segment');
      contentStep = await getStepResult(c, runId!, 'content');
      createStep = await getStepResult(c, runId!, 'create_campaign');
      sendStep = await getStepResult(c, runId!, 'send_email');
    });

    expect(planStep?.status).toBe('ok');
    expect(segmentStep?.status).toBe('ok');
    expect(contentStep?.status).toBe('ok');
    expect(createStep?.status).toBe('ok');
    // send_email should not exist yet (was suspended)
    expect(sendStep).toBeNull();

    // Get the approval
    let approval: any;
    await withTenant(acmeCtx, async (c) => {
      const approvals = await listApprovals(c, 'pending');
      approval = approvals.find((a) => a.runId === runId);
    });
    expect(approval).toBeDefined();

    // Simulate process restart: clear MCP client cache
    await closeAllClients();

    // Approve and resume (simulates a new process instance: the MCP client cache is empty)
    await handleApprovalDecision(acmeCtx, approval!.id, 'approved', 'Approved for test');

    // Poll for completion
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      await withTenant(acmeCtx, async (c) => { run = await getRun(c, runId!); });
      if (['done', 'failed', 'compensated'].includes(run!.status)) break;
    }
    expect(run!.status).toBe('done');

    // Verify completed steps were NOT re-executed (attempt=1)
    await withTenant(acmeCtx, async (c) => {
      planStep = await getStepResult(c, runId!, 'plan');
      segmentStep = await getStepResult(c, runId!, 'segment');
      contentStep = await getStepResult(c, runId!, 'content');
      createStep = await getStepResult(c, runId!, 'create_campaign');
      sendStep = await getStepResult(c, runId!, 'send_email');
    });

    expect(planStep!.attempt).toBe(1);
    expect(segmentStep!.attempt).toBe(1);
    expect(contentStep!.attempt).toBe(1);
    expect(createStep!.attempt).toBe(1);
    expect(sendStep!.status).toBe('ok');
  });

  it('fails without retrying when the tool reports a business error after approval', async () => {
    resetEspState();
    const runOnce = async () => {
      let campaignId: string;
      let runId: string;
      await withTenant(acmeCtx, async (c) => {
        campaignId = await createCampaign(c, 'Budget test brief', null);
        runId = await createRun(c, campaignId!);
      });
      await executeWorkflow(acmeCtx, runId!, campaignId!, 'Win back lapsed buyers, budget $600');
      let approval: any;
      await withTenant(acmeCtx, async (c) => {
        approval = (await listApprovals(c, 'pending')).find((a) => a.runId === runId);
      });
      await handleApprovalDecision(acmeCtx, approval!.id, 'approved', null);
      let run: any;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 300));
        await withTenant(acmeCtx, async (c) => { run = await getRun(c, runId!); });
        if (['done', 'failed', 'compensated'].includes(run!.status)) break;
      }
      return { runId: runId!, run };
    };

    // acme's fake ESP budget is $1000: the first $600 send fits, the second does not.
    expect((await runOnce()).run.status).toBe('done');
    const { runId, run } = await runOnce();
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/Insufficient budget/);

    // The approved call ran once: no retries, and no second trip through the PDP.
    let decisions: string[] = [];
    await withTenant(acmeCtx, async (c) => {
      const { rows } = await c.query(
        `SELECT decision FROM audit_log WHERE run_id = $1 AND step_id = 'send_email' ORDER BY id`,
        [runId],
      );
      decisions = rows.map((r: { decision: string }) => r.decision);
    });
    expect(decisions).toEqual(['require_approval', 'approved_by_human']);
  });
});
