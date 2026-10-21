/**
 * mcp-analytics — Read-only analytics MCP server (no auth required).
 *
 * Tools: get_campaign_metrics, get_benchmarks.
 * Metrics are deterministic per campaign_id (which embeds tenantId from ESP).
 * Benchmarks are fixed per channel.
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
    hash |= 0;
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

/**
 * Extract tenant from a campaign_id like "camp-acme-5".
 */
function tenantFromCampaignId(campaignId: string): string {
  const match = /^camp-([^-]+)-/.exec(campaignId);
  return match?.[1] ?? 'unknown';
}

/**
 * Generate deterministic metrics from a campaign_id.
 */
function generateMetrics(campaignId: string): {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  revenue_usd: number;
  open_rate: number;
  click_rate: number;
} {
  const tenantId = tenantFromCampaignId(campaignId);
  const seed = hashString(tenantId + ':' + campaignId);
  const rng = mulberry32(seed);

  const sent = 1000 + Math.floor(rng() * 4000); // 1000-5000
  const deliveredRate = 0.9 + rng() * 0.09; // 90-99%
  const delivered = Math.round(sent * deliveredRate);
  const openRate = Math.round((0.15 + rng() * 0.35) * 10000) / 10000; // 15-50%
  const opened = Math.round(delivered * openRate);
  const clickRate = Math.round((0.02 + rng() * 0.13) * 10000) / 10000; // 2-15%
  const clicked = Math.round(opened * clickRate);
  const revenue_usd = Math.round(clicked * (1 + rng() * 9) * 100) / 100; // $1-$10 per click

  return {
    sent,
    delivered,
    opened,
    clicked,
    revenue_usd,
    open_rate: Math.round(openRate * 10000) / 100, // percentage
    click_rate: Math.round(clickRate * 10000) / 100,
  };
}

// ---------------------------------------------------------------------------
// register — mounted by the harness or tests
// ---------------------------------------------------------------------------

export function register(server: McpServer): void {
  server.registerTool(
    'get_campaign_metrics',
    {
      description:
        'Return deterministic campaign metrics based on campaign_id (tenant is embedded in the ID).',
      inputSchema: z.object({
        campaign_id: z.string().min(1),
      }),
    },
    async (args) => {
      const metrics = generateMetrics(args.campaign_id);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(metrics) },
        ],
      };
    },
  );

  server.registerTool(
    'get_benchmarks',
    {
      description: 'Return industry benchmark metrics per channel.',
      inputSchema: z.object({
        channel: z.enum(['email', 'ads']),
      }),
    },
    async (args) => {
      const benchmarks: Record<string, { open_rate: number; click_rate: number; cpc_usd: number }> = {
        email: { open_rate: 22.5, click_rate: 3.2, cpc_usd: 0.05 },
        ads: { open_rate: 0, click_rate: 1.8, cpc_usd: 0.85 },
      };

      const b = benchmarks[args.channel]!;
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(b) },
        ],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// main — CLI entrypoint
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const port = parseInt(process.env.PORT || '3103', 10);
  const result = await startMcpServer({
    name: 'mcp-analytics',
    version: '0.1.0',
    port,
    register,
    requireAuth: false,
  });
  console.log(`mcp-analytics listening on ${result.url}`);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
