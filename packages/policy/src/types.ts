/**
 * Contract of the Policy Decision Point (PDP).
 *
 * Frozen interface: every other package depends on these shapes. Do not change.
 *
 * Design note: `require_approval` is a first-class outcome, not an error. The
 * orchestrator suspends the workflow on it; it is not a failure path.
 */

export type Role = 'admin' | 'marketer' | 'viewer';

export type DecisionEffect = 'allow' | 'deny' | 'require_approval';

/** Everything the PDP is allowed to look at. Pure input — no I/O inside the PDP. */
export interface PolicyInput {
  tenantId: string;
  /** Human or system principal on whose behalf the agent acts. */
  actor: string;
  actorRole: Role;
  /** e.g. "planner" | "content" | "channel" | "segment-py" | "analytics" */
  agentId: string;
  /** Fully qualified tool name: "<server>.<tool>", e.g. "esp.send_email". */
  tool: string;
  /** Raw tool arguments (already parsed JSON). */
  args: Record<string, unknown>;
  budget: BudgetState;
  /** ISO timestamp; injected for determinism in tests. */
  now?: string;
}

export interface BudgetState {
  limitUsd: number;
  spentUsd: number;
  /** Cost the current call is expected to incur, if known. */
  pendingUsd?: number;
}

export interface PolicyDecision {
  effect: DecisionEffect;
  /** Id of the winning rule, or "default" / "no-rule-matched". */
  ruleId: string;
  /** Short human-readable justification, shown in the Approval Inbox and audit log. */
  reason: string;
  /** Threshold that triggered require_approval, when applicable. */
  thresholdUsd?: number;
  /** Amount extracted from args by the rule's amountField, when applicable. */
  amountUsd?: number;
  /** Arg paths the redactor must mask before persisting. Union of matched rules. */
  redact: string[];
}

/**
 * A rule matches when EVERY provided `when` clause matches. Absent clause = wildcard.
 * Rules are evaluated in array order; the FIRST match wins (no scoring, no merging).
 * If none matches, `defaultEffect` applies with ruleId "default".
 */
export interface PolicyRule {
  id: string;
  description?: string;
  when?: {
    /** Exact role list. */
    roles?: Role[];
    /** Agent ids; "*" allowed. */
    agents?: string[];
    /** Tool globs: exact ("esp.send_email") or prefix glob ("esp.*"). */
    tools?: string[];
    /** Arg equality constraints, dot-path -> allowed values. */
    args?: Record<string, Array<string | number | boolean>>;
    /** Budget guard: matches when spent + pending exceeds this fraction (0..1) of limit. */
    budgetUtilizationOver?: number;
  };
  effect: DecisionEffect;
  /**
   * Only meaningful with effect "allow": if the amount at `amountField` is
   * strictly greater than `thresholdUsd`, the effect becomes require_approval.
   */
  requireApprovalOverUsd?: number;
  /** Dot-path into args holding a numeric USD amount. Default: "amount_usd". */
  amountField?: string;
  /** Dot-paths in args to redact in audit/approval records. */
  redact?: string[];
  reason?: string;
}

export interface PolicyDocument {
  version: 1;
  defaultEffect: DecisionEffect;
  /** Applied to every decision regardless of matched rule. */
  alwaysRedact?: string[];
  rules: PolicyRule[];
}
