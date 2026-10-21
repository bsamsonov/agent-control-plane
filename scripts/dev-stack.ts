/**
 * Starts everything the UI needs except the UI itself: the four MCP servers and the
 * control plane. Ctrl+C stops all of them.
 *
 *   pnpm dev:stack                         # offline agents (MACP_FAKE_LLM=1)
 *   LLM_API_KEY=... pnpm dev:stack         # real agents on the LLM_* endpoint
 */
import { spawn, type ChildProcess } from 'node:child_process';

const fake = process.env.LLM_API_KEY ? '0' : '1';
const children: ChildProcess[] = [];

function start(name: string, cmd: string[], env: Record<string, string> = {}, cwd?: string): void {
  const child = spawn(cmd[0]!, cmd.slice(1), {
    cwd,
    env: { ...process.env, MACP_FAKE_LLM: process.env.MACP_FAKE_LLM ?? fake, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = (b: Buffer) =>
    b.toString().split('\n').filter(Boolean).map((l) => `[${name}] ${l}`).join('\n');
  child.stdout?.on('data', (b: Buffer) => console.log(prefix(b)));
  child.stderr?.on('data', (b: Buffer) => console.error(prefix(b)));
  children.push(child);
}

const tsx = 'node_modules/.bin/tsx';
start('crm', [tsx, 'packages/mcp-fake-crm/src/server.ts'], { PORT: '3101' });
start('esp', [tsx, 'packages/mcp-fake-esp/src/server.ts'], { PORT: '3102' });
start('analytics', [tsx, 'packages/mcp-analytics/src/server.ts'], { PORT: '3103' });
start('segment-py', ['uv', 'run', '--no-sync', 'python', '-m', 'segment_py.server'], {}, 'services/segment-py');
setTimeout(() => start('control-plane', [tsx, 'apps/control-plane/src/server.ts']), 3000);

console.log(`MCP servers on :3101-3104, control plane on :3001 (agents: ${fake === '1' && !process.env.MACP_FAKE_LLM ? 'offline' : 'per MACP_FAKE_LLM / LLM_*'})`);

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
