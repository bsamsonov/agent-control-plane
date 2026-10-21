/**
 * API client for the MACP Control Plane.
 *
 * Every request includes the X-MACP-User header (read from localStorage key "macp_user").
 * Base URL is NEXT_PUBLIC_CONTROL_PLANE_URL ?? 'http://localhost:3001'.
 * All functions are meant for client-side use only ('use client').
 */

const BASE = process.env.NEXT_PUBLIC_CONTROL_PLANE_URL ?? 'http://localhost:3001';
export const DEFAULT_USER = 'marketer@acme.test';

function userHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  // Same default as the Header switcher: a first visit has nothing in localStorage yet,
  // and the page's first fetch can run before the Header effect stores a value.
  const user = localStorage.getItem('macp_user') ?? DEFAULT_USER;
  return { 'X-MACP-User': user };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...userHeader(), ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

// ------------------------------------------------------------------ campaigns

export interface CreateCampaignResponse {
  campaignId: string;
  runId: string;
}

export async function createCampaign(brief: string): Promise<CreateCampaignResponse> {
  return request('/api/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ brief }),
  });
}

// ------------------------------------------------------------------ runs & SSE

export interface StepEvent {
  stepId: string;
  status: 'running' | 'ok' | 'failed' | 'compensated' | 'awaiting_approval';
  /** Policy decision output. */
  policy?: { effect: string; ruleId: string; reason: string };
  /** Milliseconds since step started, if known. */
  durationMs?: number;
}

/**
 * Open an SSE stream for a run. The server sends {event, data} envelopes:
 * 'step' and 'approval' carry a StepEvent, 'end' carries the final run status.
 * Returns an AbortController; abort it to close the connection.
 */
export function streamRunSteps(
  runId: string,
  onEvent: (ev: StepEvent) => void,
  onEnd?: (status: string, error?: string) => void,
): AbortController {
  const ctrl = new AbortController();
  const url = `${BASE}/api/runs/${encodeURIComponent(runId)}/stream`;

  fetch(url, {
    signal: ctrl.signal,
    headers: userHeader(),
  })
    .then(async (res) => {
      if (!res.ok) throw new Error(`SSE ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            let msg: { event?: string; data?: StepEvent; status?: string; error?: string };
            try {
              msg = JSON.parse(line.slice(6));
            } catch {
              continue; // ignore malformed
            }
            if ((msg.event === 'step' || msg.event === 'approval') && msg.data) onEvent(msg.data);
            else if (msg.event === 'end') onEnd?.(msg.status ?? 'done', msg.error);
          }
        }
      }
    })
    .catch((err) => {
      if ((err as Error).name !== 'AbortError') {
        console.error('SSE error:', err);
      }
    });

  return ctrl;
}

// ------------------------------------------------------------------ approvals

export interface ApprovalItem {
  id: string;
  tenantId: string;
  runId: string;
  stepId: string;
  agentId: string;
  tool: string;
  argsRedacted: unknown;
  reason: string;
  status: string;
  requestedAt: string;
  decidedBy: string | null;
  decisionNote: string | null;
  decidedAt: string | null;
}

export async function listApprovals(status?: string): Promise<ApprovalItem[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await request<{ approvals: ApprovalItem[] }>(`/api/approvals${qs}`);
  return res.approvals;
}

export async function decideApproval(
  id: string,
  decision: 'approved' | 'rejected',
  note: string | null,
): Promise<{ status: 'ok'; decision: 'approved' | 'rejected' }> {
  return request(`/api/approvals/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, note }),
  });
}

// ------------------------------------------------------------------ audit

export interface AuditItem {
  id: number;
  tenantId: string;
  runId: string | null;
  stepId: string | null;
  actor: string;
  actorRole: string | null;
  agentId: string | null;
  tool: string | null;
  argsRedacted: unknown;
  decision: string;
  reason: string | null;
  ruleId: string | null;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  ts: string;
}

export interface ListAuditOpts {
  runId?: string;
  limit?: number;
}

export async function listAudit(opts?: ListAuditOpts): Promise<AuditItem[]> {
  const params = new URLSearchParams();
  if (opts?.runId) params.set('runId', opts.runId);
  if (opts?.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const res = await request<{ audit: AuditItem[] }>(`/api/audit${qs ? `?${qs}` : ''}`);
  return res.audit;
}
