/**
 * mcp-fake-esp — Fake Email Service Provider MCP server with budget management
 * and fault injection for saga demo.
 *
 * Tools: get_budget, create_campaign, send_email, refund_campaign.
 * State is in-memory per tenant and seeded from acme/globex defaults.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { startMcpServer } from '@macp/mcp-common';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Module-level state (survives across stateless request handling)
// ---------------------------------------------------------------------------

interface BudgetState {
  limitUsd: number;
  spentUsd: number;
}

interface Campaign {
  id: string;
  name: string;
  channel: 'email' | 'ads';
  amount_usd: number;
}

const budgets = new Map<string, BudgetState>();
const campaigns = new Map<string, Campaign>();
let nextCampaignId = 1;
let nextMessageId = 1;

function ensureBudget(tenantId: string): BudgetState {
  if (!budgets.has(tenantId)) {
    if (tenantId === 'globex') {
      budgets.set(tenantId, { limitUsd: 5000, spentUsd: 0 });
    } else {
      budgets.set(tenantId, { limitUsd: 1000, spentUsd: 0 });
    }
  }
  return budgets.get(tenantId)!;
}

function resetState(): void {
  budgets.clear();
  campaigns.clear();
  nextCampaignId = 1;
  nextMessageId = 1;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTenantId(extra?: { authInfo?: { extra?: { tenantId?: unknown } } }): string {
  const tenantId = extra?.authInfo?.extra?.tenantId;
  return typeof tenantId === 'string' ? tenantId : 'unknown';
}

// ---------------------------------------------------------------------------
// register — mounted by the harness or tests
// ---------------------------------------------------------------------------

export function register(server: McpServer): void {
  server.registerTool(
    'get_budget',
    {
      description: 'Return current budget state for the tenant.',
    },
    async (extra) => {
      const tenantId = getTenantId(extra);
      const budget = ensureBudget(tenantId);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              limit_usd: budget.limitUsd,
              spent_usd: budget.spentUsd,
              remaining_usd: Math.max(0, budget.limitUsd - budget.spentUsd),
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'create_campaign',
    {
      description: 'Create a new campaign (does NOT debit budget yet).',
      inputSchema: z.object({
        name: z.string().min(1),
        channel: z.enum(['email', 'ads']),
        amount_usd: z.number().positive(),
      }),
    },
    async (args, extra) => {
      const tenantId = getTenantId(extra);
      const id = `camp-${tenantId}-${nextCampaignId++}`;
      campaigns.set(id, {
        id,
        name: args.name,
        channel: args.channel,
        amount_usd: args.amount_usd,
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ campaign_id: id, status: 'created' }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'send_email',
    {
      description:
        'Send email to recipients and debit budget. Fault injection: subject containing __FAIL__ will debit then throw.',
      inputSchema: z.object({
        campaign_id: z.string(),
        recipients: z.array(z.string()).min(1),
        subject: z.string(),
        body: z.string(),
        amount_usd: z.number().positive(),
      }),
    },
    async (args, extra) => {
      const tenantId = getTenantId(extra);
      const budget = ensureBudget(tenantId);

      if (args.amount_usd > budget.limitUsd - budget.spentUsd) {
        throw new Error(
          `Insufficient budget: amount ${args.amount_usd} exceeds remaining ${budget.limitUsd - budget.spentUsd}`,
        );
      }

      // Debit budget BEFORE checking fault injection
      budget.spentUsd += args.amount_usd;

      const messageId = `msg-${nextMessageId++}`;
      const sent = args.recipients.length;

      // Fault injection: budget is already debited, now throw
      if (args.subject.includes('__FAIL__')) {
        throw new Error(
          `Fault injected: __FAIL__ marker in subject. Budget already charged ${args.amount_usd} USD.`,
        );
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              sent,
              message_id: messageId,
              charged_usd: args.amount_usd,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'refund_campaign',
    {
      description: 'Refund (compensate) a previously charged campaign amount.',
      inputSchema: z.object({
        campaign_id: z.string(),
        amount_usd: z.number().positive(),
      }),
    },
    async (args, extra) => {
      const tenantId = getTenantId(extra);
      const budget = ensureBudget(tenantId);

      budget.spentUsd = Math.max(0, budget.spentUsd - args.amount_usd);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ refunded_usd: args.amount_usd }),
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
  const port = parseInt(process.env.PORT || '3102', 10);
  const result = await startMcpServer({
    name: 'mcp-fake-esp',
    version: '0.1.0',
    port,
    register,
    requireAuth: true,
  });
  console.log(`mcp-fake-esp listening on ${result.url}`);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] === thisFile) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Exported for tests
export { resetState };
