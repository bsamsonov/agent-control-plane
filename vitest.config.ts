import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

// Aliases resolve @macp/* to the sources in THIS checkout. Without them a workspace
// symlink could point at another checkout (e.g. when running inside a git worktree).
export default defineConfig({
  resolve: {
    alias: {
      '@macp/policy': p('./packages/policy/src/index.ts'),
      '@macp/db': p('./packages/db/src/index.ts'),
      '@macp/mcp-common': p('./packages/mcp-common/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // All suites share one Postgres and each one seeds it. Running files in parallel makes
    // them truncate each other's fixtures mid-test. Serial is the honest configuration here.
    fileParallelism: false,
    // The suite must be runnable on a clean machine with no API keys: agents return canned
    // output and the whole run is deterministic and offline.
    env: { MACP_FAKE_LLM: '1' },
  },
});
