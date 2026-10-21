/**
 * mcp-fake-crm — Fake CRM MCP server with deterministic, tenant-seeded data.
 *
 * Tools: search_customers, get_segment_stats.
 * Data is derived from a PRNG seeded with the tenantId, so same inputs always
 * produce the same results, and acme/globex differ visibly.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { startMcpServer } from '@macp/mcp-common';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Seeded PRNG (deterministic, reproducible)
// ---------------------------------------------------------------------------

function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // 32-bit
  }
  return Math.abs(hash);
}

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTenantId(extra?: { authInfo?: { extra?: { tenantId?: unknown } } }): string {
  const tenantId = extra?.authInfo?.extra?.tenantId;
  return typeof tenantId === 'string' ? tenantId : 'unknown';
}

/** Generate a deterministic set of customers for a tenant. */
function generateCustomers(tenantId: string): Array<{
  id: string;
  email: string;
  last_purchase_at: string;
  ltv_usd: number;
}> {
  const seed = hashString(tenantId);
  const rng = mulberry32(seed);

  // Different tenant → different total count
  const count = tenantId === 'globex' ? 25 : 40;

  const customers: Array<{
    id: string;
    email: string;
    last_purchase_at: string;
    ltv_usd: number;
  }> = [];

  const now = new Date('2026-07-01'); // stable reference date

  for (let i = 0; i < count; i++) {
    const custId = `cust-${tenantId}-${String(i + 1).padStart(3, '0')}`;
    const ltv = Math.round(rng() * 4900 + 100); // 100–5000
    const daysAgo = Math.round(rng() * 730); // up to 2 years ago
    const date = new Date(now.getTime() - daysAgo * 86400000);

    customers.push({
      id: custId,
      email: `user${i + 1}@${tenantId}.test`,
      last_purchase_at: date.toISOString().split('T')[0]!,
      ltv_usd: ltv,
    });
  }

  return customers;
}

// ---------------------------------------------------------------------------
// register — mounted by the harness or tests
// ---------------------------------------------------------------------------

export function register(server: McpServer): void {
  server.registerTool(
    'search_customers',
    {
      description:
        'Search customers whose last purchase was at least inactive_days ago. Returns a deterministic list per tenant.',
      inputSchema: z.object({
        inactive_days: z.number().int().min(0),
        limit: z.number().int().min(1).max(100).default(20).optional(),
      }),
    },
    async (args, extra) => {
      const tenantId = getTenantId(extra);
      const all = generateCustomers(tenantId);
      const ref = new Date('2026-07-01');

      const inactive = all.filter((c) => {
        const purchased = new Date(c.last_purchase_at);
        const diffDays = Math.floor(
          (ref.getTime() - purchased.getTime()) / 86400000,
        );
        return diffDays >= args.inactive_days;
      });

      const limit = args.limit ?? 20;
      const page = inactive.slice(0, limit);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ customers: page, total: inactive.length }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'get_segment_stats',
    {
      description:
        'Return aggregate stats for customers inactive at least inactive_days.',
      inputSchema: z.object({
        inactive_days: z.number().int().min(0),
      }),
    },
    async (args, extra) => {
      const tenantId = getTenantId(extra);
      const all = generateCustomers(tenantId);
      const ref = new Date('2026-07-01');

      const inactive = all.filter((c) => {
        const purchased = new Date(c.last_purchase_at);
        const diffDays = Math.floor(
          (ref.getTime() - purchased.getTime()) / 86400000,
        );
        return diffDays >= args.inactive_days;
      });

      const size = inactive.length;
      const avgLtv =
        size > 0
          ? Math.round(
              (inactive.reduce((s, c) => s + c.ltv_usd, 0) / size) * 100,
            ) / 100
          : 0;

      // Channel distribution: deterministic split using tenant seed
      const chSeed = hashString(tenantId + ':channels:' + String(args.inactive_days));
      const chRng = mulberry32(chSeed);
      const emailFrac = 0.5 + chRng() * 0.3; // 0.5–0.8
      const adsFrac = 1.0 - emailFrac;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              size,
              avg_ltv_usd: avgLtv,
              channels: {
                email: Math.round(size * emailFrac),
                ads: Math.round(size * adsFrac),
              },
            }),
          },
        ],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// main — CLI entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const port = parseInt(process.env.PORT || '3101', 10);
  const result = await startMcpServer({
    name: 'mcp-fake-crm',
    version: '0.1.0',
    port,
    register,
    requireAuth: true,
  });
  console.log(`mcp-fake-crm listening on ${result.url}`);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
