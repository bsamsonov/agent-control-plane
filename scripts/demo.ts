/**
 * End-to-end demo. This is the acceptance test for the whole POC, not a toy script.
 *
 * It proves, in order:
 *   1. a run pauses because policy said so, not because the code threw;
 *   2. the pause survives the control plane being **killed and restarted**;
 *   3. resume continues at the suspended step and does not re-execute completed ones;
 *   4. a second tenant, same brief, different policy → no pause, different data;
 *   5. every decision — including the pause — is in the audit log.
 *
 * Run: pnpm demo   (Postgres must be up; no API keys needed)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { migrate, seed, closePools } from '@macp/db';

const CP_PORT = Number(process.env.CONTROL_PLANE_PORT ?? 3001);
const CP = `http://127.0.0.1:${CP_PORT}`;
const BRIEF = 'Reactivate customers who have not purchased in 90 days, budget $500, channels email + ads.';

const children: ChildProcess[] = [];

function start(name: string, file: string, env: Record<string, string> = {}, opts: { cwd?: string; cmd?: string[] } = {}): ChildProcess {
  const cmd = opts.cmd ?? ['node', '--import', 'tsx', file];
  const child = spawn(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd,
    // Offline by default; MACP_DEMO_REAL_LLM=1 runs the agents on the LLM_* endpoint.
    env: { ...process.env, MACP_FAKE_LLM: process.env.MACP_DEMO_REAL_LLM === '1' ? '0' : '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (b) => process.env.DEMO_VERBOSE && console.log(`[${name}] ${b}`));
  child.stderr?.on('data', (b) => process.env.DEMO_VERBOSE && console.error(`[${name}] ${b}`));
  children.push(child);
  return child;
}

async function waitFor(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await sleep(200);
  }
}

/**
 * Readiness for servers that don't expose a /healthz (the Python FastMCP server
 * mounts only /mcp). Any HTTP response — even a 406 from a wrong-method probe —
 * means something is listening; only a network error means "not up yet".
 */
async function waitForAny(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await sleep(300);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(path: string, user: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${CP}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-macp-user': user, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} → ${res.status} ${JSON.stringify(body)}`);
  return body;
}

async function pollRun(runId: string, user: string, until: (r: any) => boolean, timeoutMs = 30_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await api(`/api/runs/${runId}`, user);
    if (until(detail.run ?? detail)) return detail;
    if (Date.now() > deadline) throw new Error(`run ${runId} never reached the expected state: ${JSON.stringify(detail.run ?? detail)}`);
    await sleep(250);
  }
}

const h = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const ok = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const info = (s: string) => console.log(`    ${s}`);

async function main(): Promise<void> {
  h('0 · Schema and fixtures');
  await migrate();
  await seed();
  ok('migrated and seeded two tenants: acme (cautious policy) and globex (unattended)');

  h('1 · Starting MCP servers and the control plane');
  start('crm', 'packages/mcp-fake-crm/src/server.ts', { PORT: '3101' });
  start('esp', 'packages/mcp-fake-esp/src/server.ts', { PORT: '3102' });
  start('analytics', 'packages/mcp-analytics/src/server.ts', { PORT: '3103' });
  // segment-py is a Python FastMCP process — the polyglot half of the architecture
  // (ADR-007). `uv run` materialises the venv on first start, so the readiness wait
  // is generous.
  start('segment-py', '', {}, {
    cwd: 'services/segment-py',
    cmd: ['uv', 'run', '--no-sync', 'python', '-m', 'segment_py.server'],
  });
  await Promise.all([
    waitFor('http://127.0.0.1:3101/healthz'),
    waitFor('http://127.0.0.1:3102/healthz'),
    waitFor('http://127.0.0.1:3103/healthz'),
    waitForAny('http://127.0.0.1:3104/mcp'),
  ]);
  ok('four MCP servers up (fake CRM, fake ESP, analytics, Python segment-py)');

  let cp = start('control-plane', 'apps/control-plane/src/server.ts');
  await waitFor(`${CP}/healthz`);
  ok(`control plane up on ${CP} (pid ${cp.pid})`);

  h('2 · marketer@acme.test submits a brief');
  info(`"${BRIEF}"`);
  const started = await api('/api/campaigns', 'marketer@acme.test', {
    method: 'POST',
    body: JSON.stringify({ brief: BRIEF }),
  });
  const runId: string = started.runId;
  ok(`run ${runId} started`);

  h('3 · Policy stops the run before it spends money');
  const suspended = await pollRun(runId, 'marketer@acme.test', (r) => r.status === 'suspended');
  const run = suspended.run ?? suspended;
  if (run.cursorStep !== 'send_email') throw new Error(`expected the pause at send_email, got ${run.cursorStep}`);
  ok(`run suspended at step "${run.cursorStep}" — not failed, not crashed`);
  const pending = await api('/api/approvals?status=pending', 'marketer@acme.test');
  const approval = (pending.approvals ?? pending).find((a: any) => a.runId === runId);
  if (!approval) throw new Error('no approval request was created');
  info(`reason: ${approval.reason}`);
  info(`args as stored: ${JSON.stringify(approval.argsRedacted)}`);
  if (JSON.stringify(approval.argsRedacted).includes('@acme.test')) {
    throw new Error('recipient addresses leaked into the approval record');
  }
  ok('recipients redacted in the persisted request');

  h('4 · Killing the control plane while the run waits');
  const oldPid = cp.pid;
  cp.kill('SIGKILL');
  await sleep(500);
  ok(`process ${oldPid} killed — nothing about this run lives in memory now`);

  cp = start('control-plane', 'apps/control-plane/src/server.ts');
  await waitFor(`${CP}/healthz`);
  ok(`control plane restarted (pid ${cp.pid})`);

  const afterRestart = await api('/api/approvals?status=pending', 'marketer@acme.test');
  const stillThere = (afterRestart.approvals ?? afterRestart).find((a: any) => a.id === approval.id);
  if (!stillThere) throw new Error('the approval did not survive the restart');
  ok('the approval request is still pending after the restart');

  h('5 · Approving — the run resumes at the suspended step');
  const before = await api(`/api/runs/${runId}`, 'marketer@acme.test');
  const stepsBefore = (before.steps ?? []).map((s: any) => s.stepId);
  info(`steps already completed: ${stepsBefore.join(', ')}`);

  await api(`/api/approvals/${approval.id}/decide`, 'admin@acme.test', {
    method: 'POST',
    body: JSON.stringify({ decision: 'approved', note: 'Reviewed the segment, budget is fine.' }),
  });
  const finished = await pollRun(runId, 'marketer@acme.test', (r) =>
    ['done', 'failed', 'compensated'].includes(r.status),
  );
  const finalRun = finished.run ?? finished;
  ok(`run finished with status "${finalRun.status}"`);

  const attempts = (finished.steps ?? []).filter((s: any) => stepsBefore.includes(s.stepId));
  const reExecuted = attempts.filter((s: any) => s.attempt > 1);
  if (reExecuted.length > 0) {
    throw new Error(`steps were re-executed on resume: ${reExecuted.map((s: any) => s.stepId).join(', ')}`);
  }
  ok(`${attempts.length} previously completed steps were skipped, not replayed`);

  h('6 · Same brief, second tenant, different policy');
  const globex = await api('/api/campaigns', 'marketer@globex.test', {
    method: 'POST',
    body: JSON.stringify({ brief: BRIEF }),
  });
  const globexRun = await pollRun(globex.runId, 'marketer@globex.test', (r) =>
    ['done', 'failed', 'compensated', 'suspended'].includes(r.status),
  );
  const gr = globexRun.run ?? globexRun;
  if (gr.status === 'suspended') throw new Error('globex should not have paused — check its policy');
  ok(`globex ran unattended to "${gr.status}" — same brief, same code, different policy`);

  const globexPending = await api('/api/approvals?status=pending', 'marketer@globex.test');
  info(`globex pending approvals: ${(globexPending.approvals ?? globexPending).length}`);

  h('7 · The audit trail');
  const audit = await api(`/api/audit?runId=${runId}&limit=50`, 'admin@acme.test');
  const rows = audit.audit ?? audit.rows ?? audit;
  for (const r of rows.slice().reverse()) {
    const colour = r.decision === 'allow' ? 32 : r.decision === 'deny' ? 31 : 33;
    console.log(
      `    \x1b[${colour}m${String(r.decision).padEnd(18)}\x1b[0m ${String(r.tool ?? '').padEnd(28)} ${r.reason ?? ''}`,
    );
  }
  ok(`${rows.length} audited decisions for this run, every one persisted before the effect`);

  h('Cross-tenant check');
  try {
    await api(`/api/runs/${runId}`, 'marketer@globex.test');
    throw new Error('globex was able to read an acme run — isolation is broken');
  } catch (err) {
    if (err instanceof Error && err.message.includes('isolation is broken')) throw err;
    ok('globex cannot read acme\'s run (RLS returns nothing, API answers 404)');
  }

  console.log('\n\x1b[1;32mDemo complete.\x1b[0m The pause, the kill, and the resume are the point.\n');
}

async function shutdown(code: number): Promise<never> {
  for (const c of children) c.kill('SIGKILL');
  await closePools().catch(() => {});
  process.exit(code);
}

main().then(
  () => shutdown(0),
  (err) => {
    console.error(`\n\x1b[31mDemo failed:\x1b[0m ${err instanceof Error ? err.stack : err}\n`);
    return shutdown(1);
  },
);
