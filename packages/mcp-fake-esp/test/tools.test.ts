/**
 * Tests for mcp-fake-esp tools.
 *
 * Starts a real server on port 0, authenticates via PKCE, and calls every tool
 * with the MCP SDK client. Verifies budget tracking, fault injection with __FAIL__,
 * and refund/compensation flow.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  startMcpServer,
  generateCodeVerifier,
  computeS256Challenge,
} from '@macp/mcp-common';
import { register, resetState } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function doPkceFlow(serverUrl: string, tenant: string): Promise<string> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeS256Challenge(codeVerifier);
  const redirectUri = 'http://localhost:1/callback';

  const authUrl = new URL(`${serverUrl}/authorize`);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', 'test-client');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('tenant', tenant);
  authUrl.searchParams.set('scope', 'tools');

  const authResp = await fetch(authUrl.toString(), { redirect: 'manual' });
  expect(authResp.status).toBe(302);
  const location = authResp.headers.get('location')!;
  const code = new URL(location).searchParams.get('code')!;

  const tokenResp = await fetch(`${serverUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      client_id: 'test-client',
    }),
  });
  expect(tokenResp.status).toBe(200);
  const data = (await tokenResp.json()) as Record<string, unknown>;
  return data.access_token as string;
}

async function connectClient(
  serverUrl: string,
  token: string,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${serverUrl}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

function parseResult(result: unknown): unknown {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('mcp-fake-esp tools', () => {
  let serverUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const result = await startMcpServer({
      name: 'mcp-fake-esp-test',
      version: '0.0.0',
      port: 0,
      requireAuth: true,
      register,
    });
    serverUrl = result.url;
    close = result.close;
  });

  afterAll(async () => {
    await close();
  });

  // --- get_budget ---

  it('get_budget returns initial budget for acme', async () => {
    const token = await doPkceFlow(serverUrl, 'acme');
    const client = await connectClient(serverUrl, token);

    try {
      const result = await client.callTool({ name: 'get_budget', arguments: {} });
      const data = parseResult(result) as {
        limit_usd: number;
        spent_usd: number;
        remaining_usd: number;
      };
      expect(data.limit_usd).toBe(1000);
      expect(data.spent_usd).toBe(0);
      expect(data.remaining_usd).toBe(1000);
    } finally {
      await client.close();
    }
  });

  it('get_budget returns initial budget for globex', async () => {
    const token = await doPkceFlow(serverUrl, 'globex');
    const client = await connectClient(serverUrl, token);

    try {
      const result = await client.callTool({ name: 'get_budget', arguments: {} });
      const data = parseResult(result) as {
        limit_usd: number;
        spent_usd: number;
        remaining_usd: number;
      };
      expect(data.limit_usd).toBe(5000);
      expect(data.remaining_usd).toBe(5000);
    } finally {
      await client.close();
    }
  });

  // --- create_campaign ---

  it('create_campaign returns campaign_id and status', async () => {
    const token = await doPkceFlow(serverUrl, 'acme');
    const client = await connectClient(serverUrl, token);

    try {
      const result = await client.callTool({
        name: 'create_campaign',
        arguments: {
          name: 'Welcome series',
          channel: 'email',
          amount_usd: 200,
        },
      });
      const data = parseResult(result) as {
        campaign_id: string;
        status: string;
      };
      expect(data.status).toBe('created');
      expect(typeof data.campaign_id).toBe('string');
    } finally {
      await client.close();
    }
  });

  // --- send_email ---

  it('send_email debits budget and returns sent count', async () => {
    resetState();
    const token = await doPkceFlow(serverUrl, 'acme');
    const client = await connectClient(serverUrl, token);

    try {
      const result = await client.callTool({
        name: 'send_email',
        arguments: {
          campaign_id: 'camp-acme-test',
          recipients: ['a@a.test', 'b@a.test'],
          subject: 'Hello',
          body: 'Welcome!',
          amount_usd: 10,
        },
      });
      const data = parseResult(result) as {
        sent: number;
        message_id: string;
        charged_usd: number;
      };
      expect(data.sent).toBe(2);
      expect(typeof data.message_id).toBe('string');
      expect(data.charged_usd).toBe(10);

      // Verify budget was debited
      const budgetRes = await client.callTool({
        name: 'get_budget',
        arguments: {},
      });
      const budget = parseResult(budgetRes) as { spent_usd: number };
      expect(budget.spent_usd).toBe(10);
    } finally {
      await client.close();
    }
  });

  it('send_email fails when amount exceeds remaining', async () => {
    const token = await doPkceFlow(serverUrl, 'acme');
    const client = await connectClient(serverUrl, token);

    try {
      const result = await client.callTool({
        name: 'send_email',
        arguments: {
          campaign_id: 'camp-test-2',
          recipients: ['x@x.test'],
          subject: 'Big spend',
          body: 'Too expensive',
          amount_usd: 99999,
        },
      });
      // SDK wraps thrown errors in isError: true
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });

  // --- fault injection ---

  it('send_email with __FAIL__ debits budget then throws', async () => {
    resetState();
    const token = await doPkceFlow(serverUrl, 'acme');
    const client = await connectClient(serverUrl, token);

    try {
      // First, get the initial spent
      const budgetBefore = parseResult(
        await client.callTool({ name: 'get_budget', arguments: {} }),
      ) as { spent_usd: number };
      const spentBefore = budgetBefore.spent_usd;

      // Call with __FAIL__ marker — should debit then error
      const result = await client.callTool({
        name: 'send_email',
        arguments: {
          campaign_id: 'camp-fail-test',
          recipients: ['fail@test.com'],
          subject: 'Campaign __FAIL__ injection',
          body: 'This will fail after charge',
          amount_usd: 50,
        },
      });
      expect(result.isError).toBe(true);

      // Budget was STILL debited despite the error
      const budgetAfter = parseResult(
        await client.callTool({ name: 'get_budget', arguments: {} }),
      ) as { spent_usd: number };
      expect(budgetAfter.spent_usd).toBe(spentBefore + 50);
    } finally {
      await client.close();
    }
  });

  // --- refund_campaign ---

  it('refund_campaign restores budget', async () => {
    resetState();
    const token = await doPkceFlow(serverUrl, 'acme');
    const client = await connectClient(serverUrl, token);

    try {
      // Charge 100
      await client.callTool({
        name: 'send_email',
        arguments: {
          campaign_id: 'camp-refund-test',
          recipients: ['c@c.test'],
          subject: 'Charge for refund test',
          body: '...',
          amount_usd: 100,
        },
      });

      const budgetAfterCharge = parseResult(
        await client.callTool({ name: 'get_budget', arguments: {} }),
      ) as { spent_usd: number };
      expect(budgetAfterCharge.spent_usd).toBe(100);

      // Refund 100
      const refundResult = await client.callTool({
        name: 'refund_campaign',
        arguments: { campaign_id: 'camp-refund-test', amount_usd: 100 },
      });
      const refundData = parseResult(refundResult) as { refunded_usd: number };
      expect(refundData.refunded_usd).toBe(100);

      const budgetAfterRefund = parseResult(
        await client.callTool({ name: 'get_budget', arguments: {} }),
      ) as { spent_usd: number };
      expect(budgetAfterRefund.spent_usd).toBe(0);
    } finally {
      await client.close();
    }
  });

  // --- saga: __FAIL__ + refund ---

  it('saga: __FAIL__ charges then refund compensates', async () => {
    resetState();
    const token = await doPkceFlow(serverUrl, 'acme');
    const client = await connectClient(serverUrl, token);

    try {
      const budgetInitial = parseResult(
        await client.callTool({ name: 'get_budget', arguments: {} }),
      ) as { spent_usd: number };

      // Step 1: send_email with __FAIL__ — budget charged, call fails
      const failResult = await client.callTool({
        name: 'send_email',
        arguments: {
          campaign_id: 'camp-saga',
          recipients: ['u@test.com'],
          subject: 'Test __FAIL__ saga',
          body: 'Will fail',
          amount_usd: 75,
        },
      });
      expect(failResult.isError).toBe(true);

      const budgetAfterFail = parseResult(
        await client.callTool({ name: 'get_budget', arguments: {} }),
      ) as { spent_usd: number };
      expect(budgetAfterFail.spent_usd).toBe(
        budgetInitial.spent_usd + 75,
      );

      // Step 2: refund to compensate
      await client.callTool({
        name: 'refund_campaign',
        arguments: { campaign_id: 'camp-saga', amount_usd: 75 },
      });

      const budgetAfterRefund = parseResult(
        await client.callTool({ name: 'get_budget', arguments: {} }),
      ) as { spent_usd: number };
      expect(budgetAfterRefund.spent_usd).toBe(budgetInitial.spent_usd);
    } finally {
      await client.close();
    }
  });

  // --- health ---

  it('/healthz returns ok', async () => {
    const resp = await fetch(`${serverUrl}/healthz`);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
  });
});
