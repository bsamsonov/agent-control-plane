/**
 * Saga test: send_email with __FAIL__ marker → budget refund, run compensated.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startMcpServer } from '@macp/mcp-common';
import {
  withTenant,
  createCampaign,
  createRun,
  getRun,
  getStepResult,
  getBudget,
  migrate,
  seed,
  closePools,
} from '@macp/db';
import type { TenantContext } from '@macp/db';
import { setMcpServers, closeAllClients } from '../src/mcp-client.js';
import { executeWorkflow } from '../src/workflow.js';
import { registerCrm, registerEsp, registerAnalytics, resetEspState } from './helpers.js';

const globexCtx: TenantContext = {
  tenantId: '22222222-2222-2222-2222-222222222222',
  actor: 'marketer@globex.test',
  actorRole: 'marketer',
};

describe('Saga — send_email fault', () => {
  let servers: Array<{ close(): Promise<void> }> = [];

  beforeAll(async () => {
    await migrate();
    await seed();

    const crm = await startMcpServer({ name: 'crm-saga', version: '0.0.0', port: 0, register: registerCrm, requireAuth: true });
    servers.push(crm);

    const esp = await startMcpServer({ name: 'esp-saga', version: '0.0.0', port: 0, register: registerEsp, requireAuth: true });
    servers.push(esp);

    const analytics = await startMcpServer({ name: 'analytics-saga', version: '0.0.0', port: 0, register: registerAnalytics, requireAuth: false });
    servers.push(analytics);

    setMcpServers({ crm: crm.url, esp: esp.url, analytics: analytics.url, 'segment-py': 'http://127.0.0.1:31999' });

    // Enable saga test mode (injects __FAIL__ into email subject via fake LLM)
    process.env.MACP_SAGA_TEST = '1';
  });

  afterAll(async () => {
    delete process.env.MACP_SAGA_TEST;
    await closeAllClients();
    for (const s of servers) await s.close();
    await closePools();
  });

  it('refunds budget and marks run compensated when send_email fails after charge', async () => {
    resetEspState();

    let campaignId: string;
    let runId: string;
    await withTenant(globexCtx, async (c) => {
      campaignId = await createCampaign(c, 'Saga test brief', null);
      runId = await createRun(c, campaignId!);
    });

    let budgetBefore: any;
    await withTenant(globexCtx, async (c) => { budgetBefore = await getBudget(c); });

    await executeWorkflow(globexCtx, runId!, campaignId!, 'Saga compensation test');

    let run: any;
    await withTenant(globexCtx, async (c) => { run = await getRun(c, runId!); });
    expect(run!.status).toBe('compensated');

    let step: any;
    await withTenant(globexCtx, async (c) => { step = await getStepResult(c, runId!, 'send_email'); });
    expect(step).toBeDefined();
    expect(step!.status).toBe('compensated');

    // Budget should be restored (refunded)
    let budgetAfter: any;
    await withTenant(globexCtx, async (c) => { budgetAfter = await getBudget(c); });
    expect(budgetAfter.spentUsd).toBeCloseTo(budgetBefore.spentUsd, 0);
  });
});
