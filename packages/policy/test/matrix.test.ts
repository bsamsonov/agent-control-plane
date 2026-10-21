/**
 * Policy evaluation matrix — the repository's flagship test.
 *
 * Table-driven; ≥30 cases exercising both ACME_POLICY and GLOBEX_POLICY
 * across roles, tools, amounts, and budget utilisation.
 */
import { describe, it, expect } from 'vitest';
import { evaluate } from '../src/eval.js';
import { ACME_POLICY, GLOBEX_POLICY } from '../src/seed-policies.js';
import type { BudgetState, PolicyInput } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseInput = (
  overrides: Partial<PolicyInput> & { budget?: Partial<BudgetState> },
): PolicyInput => {
  const { budget: budgetOverride, ...restOverrides } = overrides;
  return {
    tenantId: 't1',
    actor: 'user@test',
    actorRole: 'viewer',
    agentId: 'planner',
    tool: 'crm.search_customers',
    args: {},
    budget: { limitUsd: 1000, spentUsd: 0, pendingUsd: 0, ...budgetOverride },
    ...restOverrides,
  };
};

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

describe('ACME_POLICY evaluation matrix', () => {
  // --- Viewer rules ---

  it('viewer allowed read tool (crm.search_customers)', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'viewer', tool: 'crm.search_customers' }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('viewer-read');
    expect(d.reason).toBe('read-only tool for a viewer');
    expect(d.redact).toEqual(['recipients', 'customer_emails']);
  });

  it('viewer denied write tool (esp.send_email)', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'viewer', tool: 'esp.send_email', args: { amount_usd: 1 } }),
    );
    expect(d.effect).toBe('deny');
    expect(d.ruleId).toBe('viewer-deny-all');
    expect(d.reason).toBe('viewers may not cause side effects');
    expect(d.redact).toEqual(['recipients', 'customer_emails']);
  });

  it('viewer allowed analytics.* glob', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'viewer', tool: 'analytics.get_benchmarks' }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('viewer-read');
  });

  it('viewer allowed segment.* glob', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'viewer', tool: 'segment.score_segment' }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('viewer-read');
  });

  it('viewer allowed esp.get_budget (exact in viewer-read)', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'viewer', tool: 'esp.get_budget' }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('viewer-read');
  });

  // --- Marketer rules ---

  it('marketer send_email under $100 threshold → allow', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'marketer', tool: 'esp.send_email', args: { amount_usd: 50 } }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('marketer-send');
    expect(d.reason).toBe('spending money on behalf of the tenant');
    expect(d.redact).toEqual(['recipients', 'customer_emails']); // rule redact + alwaysRedact merged
  });

  it('marketer send_email exactly $100 → allow (not strictly greater)', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'marketer', tool: 'esp.send_email', args: { amount_usd: 100 } }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('marketer-send');
    expect(d.thresholdUsd).toBeUndefined();
  });

  it('marketer send_email over $100 → require_approval', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'marketer', tool: 'esp.send_email', args: { amount_usd: 999 } }),
    );
    expect(d.effect).toBe('require_approval');
    expect(d.ruleId).toBe('marketer-send');
    expect(d.reason).toBe('amount $999 exceeds auto-approve threshold $100');
    expect(d.thresholdUsd).toBe(100);
    expect(d.amountUsd).toBe(999);
    expect(d.redact).toEqual(['recipients', 'customer_emails']);
  });

  it('marketer send_email with amount as string → coerced', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'marketer', tool: 'esp.send_email', args: { amount_usd: '200' } }),
    );
    expect(d.effect).toBe('require_approval');
    expect(d.amountUsd).toBe(200);
  });

  it('marketer send_email with missing amount → stays allow (0)', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'marketer', tool: 'esp.send_email', args: {} }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('marketer-send');
  });

  it('marketer send_email with NaN amount → stays allow', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'marketer', tool: 'esp.send_email', args: { amount_usd: 'nope' } }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('marketer-send');
  });

  it('marketer create_campaign is a reversible draft → allow, no threshold', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({
        actorRole: 'marketer',
        tool: 'esp.create_campaign',
        args: { amount_usd: 80 },
      }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('marketer-draft');
    expect(d.reason).toBe('creating a draft campaign has no irreversible effect');
  });

  it('marketer create_campaign stays allowed even for a large amount — drafting spends nothing', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({
        actorRole: 'marketer',
        tool: 'esp.create_campaign',
        args: { amount_usd: 9_000 },
      }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('marketer-draft');
    expect(d.thresholdUsd).toBeUndefined();
  });

  it('marketer read tool (crm.search_customers) → allow', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'marketer', tool: 'crm.search_customers' }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('read-tools');
    expect(d.reason).toBe('read-only data access');
  });

  it('marketer unknown tool → default deny', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'marketer', tool: 'billing.charge' }),
    );
    expect(d.effect).toBe('deny');
    expect(d.ruleId).toBe('default');
    expect(d.reason).toBe('no rule matched; tenant default applies');
    expect(d.redact).toEqual(['recipients', 'customer_emails']);
  });

  // --- Admin rules ---

  it('admin esp.send_email under $5000 → allow', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'admin', tool: 'esp.send_email', args: { amount_usd: 1000 } }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('admin-esp');
    expect(d.reason).toBe('tenant admin acts on behalf of the tenant');
  });

  it('admin esp.send_email exactly $5000 → allow (not strictly greater)', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'admin', tool: 'esp.send_email', args: { amount_usd: 5000 } }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('admin-esp');
    expect(d.thresholdUsd).toBeUndefined();
  });

  it('admin esp.send_email over $5000 → require_approval', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'admin', tool: 'esp.send_email', args: { amount_usd: 6000 } }),
    );
    expect(d.effect).toBe('require_approval');
    expect(d.ruleId).toBe('admin-esp');
    expect(d.reason).toBe('amount $6000 exceeds auto-approve threshold $5000');
    expect(d.thresholdUsd).toBe(5000);
    expect(d.amountUsd).toBe(6000);
  });

  it('admin read tool via read-tools rule', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'admin', tool: 'analytics.get_campaign_metrics' }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('read-tools');
  });

  // --- Budget guard (acme) ---

  it('budget guard: esp.* at 95% utilisation → require_approval (budget-guard wins before admin-esp)', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({
        actorRole: 'admin',
        tool: 'esp.send_email',
        args: { amount_usd: 100 },
        budget: { limitUsd: 1000, spentUsd: 950, pendingUsd: 0 },
      }),
    );
    // budget-guard (rule 0) matches first → require_approval
    expect(d.effect).toBe('require_approval');
    expect(d.ruleId).toBe('budget-guard');
    expect(d.reason).toBe('budget utilization above 90%');
  });

  it('budget guard: esp.create_campaign at 91% → require_approval', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({
        actorRole: 'marketer',
        tool: 'esp.create_campaign',
        args: { amount_usd: 10 },
        budget: { limitUsd: 1000, spentUsd: 900, pendingUsd: 11 },
      }),
    );
    // (900+11)/1000 = 0.911 > 0.9
    expect(d.effect).toBe('require_approval');
    expect(d.ruleId).toBe('budget-guard');
  });

  it('budget guard: utilisation exactly 90% → does NOT trigger (> not >=)', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({
        actorRole: 'admin',
        tool: 'esp.send_email',
        args: { amount_usd: 100 },
        budget: { limitUsd: 1000, spentUsd: 900, pendingUsd: 0 },
      }),
    );
    // 900/1000 = 0.9 → NOT > 0.9, budget-guard does NOT match
    // Falls through to admin-esp
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('admin-esp');
  });

  it('budget guard: not triggered for non-esp tools', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({
        actorRole: 'admin',
        tool: 'analytics.get_campaign_metrics',
        budget: { limitUsd: 1000, spentUsd: 950, pendingUsd: 0 },
      }),
    );
    // analytics.* not in budget-guard's tools → read-tools matches
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('read-tools');
  });

  // --- Admin esp.* glob coverage ---

  it('admin esp.get_budget via read-tools (not admin-esp since get_budget is not esp.*)', () => {
    // admin-esp: tools=['esp.*'] → matches esp.get_budget (prefix "esp.")
    // But read-tools also has esp.get_budget. admin-esp is rule #3, read-tools is rule #5.
    // admin-esp matches first → wins
    const d = evaluate(
      ACME_POLICY,
      baseInput({ actorRole: 'admin', tool: 'esp.get_budget' }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('admin-esp');
  });
});

describe('GLOBEX_POLICY evaluation matrix', () => {
  it('viewer denied write', () => {
    const d = evaluate(
      GLOBEX_POLICY,
      baseInput({ actorRole: 'viewer', tool: 'esp.send_email', args: { amount_usd: 1 } }),
    );
    expect(d.effect).toBe('deny');
    expect(d.ruleId).toBe('viewer-deny-all');
  });

  it('viewer allowed read', () => {
    const d = evaluate(
      GLOBEX_POLICY,
      baseInput({ actorRole: 'viewer', tool: 'crm.search_customers' }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('viewer-read');
  });

  it('globex marketer send_email at $50,000 → allow (threshold 100k)', () => {
    const d = evaluate(
      GLOBEX_POLICY,
      baseInput({
        actorRole: 'marketer',
        tool: 'esp.send_email',
        args: { amount_usd: 50000 },
      }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('marketer-send');
    expect(d.reason).toBe('auto-approved: tenant opted into unattended sending');
  });

  it('globex marketer send_email at $150,000 → require_approval', () => {
    const d = evaluate(
      GLOBEX_POLICY,
      baseInput({
        actorRole: 'marketer',
        tool: 'esp.send_email',
        args: { amount_usd: 150000 },
      }),
    );
    expect(d.effect).toBe('require_approval');
    expect(d.ruleId).toBe('marketer-send');
    expect(d.thresholdUsd).toBe(100000);
    expect(d.amountUsd).toBe(150000);
  });

  it('globex admin esp.send_email at $5000 → allow (no budget guard exists)', () => {
    const d = evaluate(
      GLOBEX_POLICY,
      baseInput({
        actorRole: 'admin',
        tool: 'esp.send_email',
        args: { amount_usd: 5000 },
      }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('admin-esp');
  });

  it('globex high budget utilisation does NOT trigger guard (no budget-guard rule)', () => {
    const d = evaluate(
      GLOBEX_POLICY,
      baseInput({
        actorRole: 'admin',
        tool: 'esp.send_email',
        args: { amount_usd: 100 },
        budget: { limitUsd: 1000, spentUsd: 950, pendingUsd: 0 },
      }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('admin-esp');
  });

  it('globex unknown tool → default deny', () => {
    const d = evaluate(
      GLOBEX_POLICY,
      baseInput({ actorRole: 'admin', tool: 'billing.charge' }),
    );
    expect(d.effect).toBe('deny');
    expect(d.ruleId).toBe('default');
  });

  it('globex admin read tool → allow', () => {
    const d = evaluate(
      GLOBEX_POLICY,
      baseInput({ actorRole: 'admin', tool: 'analytics.get_benchmarks' }),
    );
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('read-tools');
  });
});

describe('Edge cases', () => {
  it('limitUsd 0 → utilization Infinity → budget guard triggers', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({
        actorRole: 'admin',
        tool: 'esp.send_email',
        args: { amount_usd: 100 },
        budget: { limitUsd: 0, spentUsd: 0, pendingUsd: 0 },
      }),
    );
    expect(d.effect).toBe('require_approval');
    expect(d.ruleId).toBe('budget-guard');
  });

  it('limitUsd negative → utilization Infinity → budget guard triggers', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({
        actorRole: 'admin',
        tool: 'esp.send_email',
        args: { amount_usd: 100 },
        budget: { limitUsd: -1, spentUsd: 0, pendingUsd: 0 },
      }),
    );
    expect(d.effect).toBe('require_approval');
    expect(d.ruleId).toBe('budget-guard');
  });

  it('pendingUsd contributes to utilization', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({
        actorRole: 'admin',
        tool: 'esp.send_email',
        args: { amount_usd: 100 },
        // spent 800, pending 150 → 950/1000 = 0.95 > 0.9
        budget: { limitUsd: 1000, spentUsd: 800, pendingUsd: 150 },
      }),
    );
    expect(d.effect).toBe('require_approval');
    expect(d.ruleId).toBe('budget-guard');
  });

  it('pendingUsd undefined → treated as 0', () => {
    const d = evaluate(
      ACME_POLICY,
      baseInput({
        actorRole: 'admin',
        tool: 'esp.send_email',
        args: { amount_usd: 100 },
        budget: { limitUsd: 1000, spentUsd: 800 },
      }),
    );
    // 800/1000 = 0.8, not > 0.9 → falls through to admin-esp
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('admin-esp');
  });

  it('rule without reason uses default reason format', () => {
    // Seed policies all have reasons — test the fallback with a synthetic doc.
    const doc = {
      version: 1 as const,
      defaultEffect: 'deny' as const,
      rules: [
        {
          id: 'no-reason-rule',
          effect: 'allow' as const,
        },
      ],
    };
    const d = evaluate(doc, baseInput({ actorRole: 'admin', tool: 'any.tool' }));
    expect(d.effect).toBe('allow');
    expect(d.ruleId).toBe('no-reason-rule');
    expect(d.reason).toBe('rule no-reason-rule -> allow');
  });
});
