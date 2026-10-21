/**
 * Zod v4 schemas for PolicyDocument and helpers.
 *
 * parsePolicyDocument throws on invalid input (z.parse semantics).
 */
import { z } from 'zod';
import type { PolicyDocument } from './types.js';

// ---------------------------------------------------------------------------
// Atomic schemas
// ---------------------------------------------------------------------------

const roleSchema = z.enum(['admin', 'marketer', 'viewer']);
const decisionEffectSchema = z.enum(['allow', 'deny', 'require_approval']);

// ---------------------------------------------------------------------------
// BudgetState
// ---------------------------------------------------------------------------

const budgetStateSchema = z.object({
  limitUsd: z.number(),
  spentUsd: z.number(),
  pendingUsd: z.number().optional(),
});

// ---------------------------------------------------------------------------
// PolicyInput (not used at rest API boundary, but validated for completeness)
// ---------------------------------------------------------------------------

export const policyInputSchema = z.object({
  tenantId: z.string(),
  actor: z.string(),
  actorRole: roleSchema,
  agentId: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  budget: budgetStateSchema,
  now: z.string().optional(),
});

// ---------------------------------------------------------------------------
// PolicyRule
// ---------------------------------------------------------------------------

const policyRuleWhenSchema = z
  .object({
    roles: z.array(roleSchema).optional(),
    agents: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    args: z.record(z.string(), z.array(z.union([z.string(), z.number(), z.boolean()]))).optional(),
    budgetUtilizationOver: z.number().min(0).max(1).optional(),
  })
  .optional();

const policyRuleSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  when: policyRuleWhenSchema,
  effect: decisionEffectSchema,
  requireApprovalOverUsd: z.number().optional(),
  amountField: z.string().optional(),
  redact: z.array(z.string()).optional(),
  reason: z.string().optional(),
});

// ---------------------------------------------------------------------------
// PolicyDocument
// ---------------------------------------------------------------------------

export const policyDocumentSchema: z.ZodType<PolicyDocument> = z.object({
  version: z.literal(1),
  defaultEffect: decisionEffectSchema,
  alwaysRedact: z.array(z.string()).optional(),
  rules: z.array(policyRuleSchema),
}) as z.ZodType<PolicyDocument>;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parsePolicyDocument(raw: unknown): PolicyDocument {
  return policyDocumentSchema.parse(raw) as PolicyDocument;
}
