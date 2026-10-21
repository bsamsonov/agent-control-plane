/**
 * PDP evaluator — the policy decision point.
 *
 * Pure function: no I/O, no Date.now, deterministic given the PolicyDocument
 * and PolicyInput. Explainer comments reference the spec paragraphs.
 */
import type {
  BudgetState,
  DecisionEffect,
  PolicyDecision,
  PolicyDocument,
  PolicyInput,
  PolicyRule,
} from './types.js';

// ---------------------------------------------------------------------------
// Path helpers (dot-notation with optional [N] array indices)
// ---------------------------------------------------------------------------

function parsePath(path: string): string[] {
  return path.split('.').flatMap(seg => {
    // Split "a[0]" → ["a", "0"]
    const m = /^(.+?)\[(\d+)\]$/.exec(seg);
    if (m) return [m[1]!, m[2]!];
    return [seg];
  });
}

function getByPath(obj: unknown, path: string): unknown {
  const parts = parsePath(path);
  let cur: any = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(p);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      if (!(p in cur)) return undefined;
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Clause matchers (spec §1.1)
// ---------------------------------------------------------------------------

/** roles: input.actorRole ∈ list */
function matchRoles(ruleRoles: string[] | undefined, actorRole: string): boolean {
  if (!ruleRoles || ruleRoles.length === 0) return true; // absent = wildcard
  return ruleRoles.includes(actorRole);
}

/** agents: input.agentId ∈ list, or list contains "*" */
function matchAgents(ruleAgents: string[] | undefined, agentId: string): boolean {
  if (!ruleAgents || ruleAgents.length === 0) return true;
  return ruleAgents.includes(agentId) || ruleAgents.includes('*');
}

/** tools: exact match, prefix glob "esp.*", or "*" matches all */
function matchTool(tool: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some(p => {
    if (p === '*') return true;
    if (p.endsWith('.*')) {
      const prefix = p.slice(0, -1); // include the dot → "esp."
      return tool.startsWith(prefix);
    }
    return tool === p;
  });
}

/**
 * args: for each path → allowedValues, the dot-path value of input.args must
 * be === one of the allowed values (after String() comparison fallback for
 * numbers).
 */
function matchArgs(
  args: Record<string, unknown>,
  constraints: Record<string, Array<string | number | boolean>> | undefined,
): boolean {
  if (!constraints) return true;
  for (const [path, allowedValues] of Object.entries(constraints)) {
    const actual = getByPath(args, path);
    const matches = allowedValues.some(v => actual === v || String(actual) === String(v));
    if (!matches) return false;
  }
  return true;
}

/**
 * budgetUtilizationOver: matches when
 * (budget.spentUsd + (budget.pendingUsd ?? 0)) / budget.limitUsd > u.
 * limitUsd <= 0 is treated as Infinity.
 */
function matchBudgetUtilization(
  budget: BudgetState,
  threshold: number | undefined,
): boolean {
  if (threshold === undefined) return true;
  const util = budgetUtilization(budget);
  return util > threshold;
}

function budgetUtilization(b: BudgetState): number {
  if (b.limitUsd <= 0) return Infinity;
  return (b.spentUsd + (b.pendingUsd ?? 0)) / b.limitUsd;
}

/** True when every present clause in `when` matches. */
function ruleMatches(rule: PolicyRule, input: PolicyInput): boolean {
  const w = rule.when;
  if (!w) return true; // no when = wildcard match
  return (
    matchRoles(w.roles, input.actorRole) &&
    matchAgents(w.agents, input.agentId) &&
    matchTool(input.tool, w.tools) &&
    matchArgs(input.args, w.args) &&
    matchBudgetUtilization(input.budget, w.budgetUtilizationOver)
  );
}

// ---------------------------------------------------------------------------
// Amount coercion (spec §1.4)
// ---------------------------------------------------------------------------

/** Coerce a value to a number; numeric strings are parsed, everything else → NaN. */
function coerceNumeric(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return isNaN(n) ? NaN : n;
  }
  return NaN;
}

// ---------------------------------------------------------------------------
// Reason resolution (spec §1.6, §1.3)
// ---------------------------------------------------------------------------

function resolveReason(
  rule: PolicyRule,
  effect: DecisionEffect,
  thresholdMsg?: string,
): string {
  if (thresholdMsg) return thresholdMsg;
  if (rule.reason) return rule.reason;
  return `rule ${rule.id} -> ${effect}`;
}

// ---------------------------------------------------------------------------
// Redact merging (spec §1.5)
// ---------------------------------------------------------------------------

function mergeRedact(
  alwaysRedact: string[] | undefined,
  ruleRedact: string[] | undefined,
): string[] {
  const a = alwaysRedact ?? [];
  const r = ruleRedact ?? [];
  // deduplicate, order: alwaysRedact first, then rule's
  return [...new Set([...a, ...r])];
}

// ---------------------------------------------------------------------------
// Main evaluate
// ---------------------------------------------------------------------------

export function evaluate(doc: PolicyDocument, input: PolicyInput): PolicyDecision {
  // 1. Scan rules in array order.
  for (const rule of doc.rules) {
    if (!ruleMatches(rule, input)) continue;

    // 2. First matching rule wins.
    let effect: DecisionEffect = rule.effect;
    let thresholdMsg: string | undefined;
    let thresholdUsd: number | undefined;
    let amountUsd: number | undefined;

    // 3. requireApprovalOverUsd upgrade
    if (rule.effect === 'allow' && rule.requireApprovalOverUsd != null) {
      const field = rule.amountField ?? 'amount_usd';
      const raw = getByPath(input.args, field);
      const amount = coerceNumeric(raw);
      if (!isNaN(amount) && amount > rule.requireApprovalOverUsd) {
        effect = 'require_approval';
        thresholdUsd = rule.requireApprovalOverUsd;
        amountUsd = amount;
        thresholdMsg = `amount $${amount} exceeds auto-approve threshold $${rule.requireApprovalOverUsd}`;
      }
    }

    return {
      effect,
      ruleId: rule.id,
      reason: resolveReason(rule, effect, thresholdMsg),
      thresholdUsd,
      amountUsd,
      redact: mergeRedact(doc.alwaysRedact, rule.redact),
    };
  }

  // 4. No rule matched → default.
  return {
    effect: doc.defaultEffect,
    ruleId: 'default',
    reason: 'no rule matched; tenant default applies',
    redact: doc.alwaysRedact ?? [],
  };
}
