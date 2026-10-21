/**
 * LLM agents — planner, content, summarizer.
 *
 * When MACP_FAKE_LLM=1 (tests/CI) agents return deterministic canned output
 * with zero network calls. Mastra is NOT instantiated in that mode.
 *
 * In real mode, agents are Mastra (@mastra/core) agents on the OpenAI-compatible model
 * configured in llm.ts. Planner and content use structured output validated by zod.
 * Agents have no tools: every side effect goes through the workflow and the PDP.
 */
import { z } from 'zod';
import { isFakeLLM, llmModelConfig, FAKE_PLAN_OUTPUT, FAKE_CONTENT_OUTPUT, FAKE_SUMMARY_OUTPUT } from './llm.js';

const PlanSchema = z.object({
  steps: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        tool: z.string().optional(),
        rationale: z.string().optional(),
      }),
    )
    .min(1),
});

const ContentSchema = z.object({
  subject: z.string().min(1).max(120),
  body: z.string().min(1),
  channel: z.enum(['email', 'ads']),
});

async function makeAgent(id: string, instructions: string) {
  const { Agent } = await import('@mastra/core/agent');
  return new Agent({ id, name: id, instructions, model: llmModelConfig() });
}

export interface PlanStep {
  id: string;
  title: string;
  tool?: string;
  rationale?: string;
}

export interface PlanOutput {
  /** Budget stated in the brief; drives the policy amount check. */
  budgetUsd?: number;
  steps: PlanStep[];
}

export interface ContentOutput {
  subject: string;
  body: string;
  channel: 'email' | 'ads';
}

/**
 * Planner agent: given a marketing brief, returns a structured plan.
 */
/**
 * The stated budget is extracted deterministically from the brief rather than left to the
 * model. The amount is what the policy threshold is compared against, so a hallucinated
 * number would be a security bug, not a quality problem.
 */
export function extractBudgetUsd(brief: string): number {
  const m = /\$\s*([\d][\d,]*(?:\.\d+)?)/.exec(brief);
  const parsed = m ? Number(m[1]!.replace(/,/g, '')) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BUDGET_USD;
}

/** Used when a brief names no budget at all. Above acme's $100 threshold on purpose. */
export const DEFAULT_BUDGET_USD = 250;

export async function planCampaign(_brief: string): Promise<PlanOutput> {
  if (isFakeLLM()) {
    return { ...(FAKE_PLAN_OUTPUT.object as PlanOutput), budgetUsd: extractBudgetUsd(_brief) };
  }

  const agent = await makeAgent(
    'planner',
    'You are a marketing campaign planner. Given a brief, produce a short step-by-step plan. ' +
      'Tools available to the workflow: crm.search_customers, crm.get_segment_stats, ' +
      'esp.create_campaign, esp.send_email, analytics.get_campaign_metrics.',
  );
  const result = await agent.generate(_brief, { structuredOutput: { schema: PlanSchema, jsonPromptInjection: true } });
  return { ...result.object, budgetUsd: extractBudgetUsd(_brief) };
}

/**
 * Content agent: given segment info, returns email subject and body.
 */
export async function generateContent(_segmentInfo: unknown): Promise<ContentOutput> {
  if (isFakeLLM()) {
    // Saga test hook: inject __FAIL__ marker into subject
    if (process.env.MACP_SAGA_TEST === '1') {
      return { subject: 'Special offer __FAIL__', body: 'Come back and enjoy 15% off!', channel: 'email' };
    }
    return FAKE_CONTENT_OUTPUT.object as ContentOutput;
  }

  const agent = await makeAgent(
    'content',
    'You are an email copywriter. Given segment data, write a short re-engagement email. ' +
      'Return channel "email".',
  );
  const result = await agent.generate(JSON.stringify(_segmentInfo), { structuredOutput: { schema: ContentSchema, jsonPromptInjection: true } });
  return result.object;
}

/**
 * Summarizer: given campaign metrics, returns a human-readable summary.
 */
export async function summarizeResults(_metrics: unknown): Promise<string> {
  if (isFakeLLM()) return FAKE_SUMMARY_OUTPUT.text;

  const agent = await makeAgent('summarizer', 'You summarize campaign metrics in one short paragraph.');
  const result = await agent.generate(JSON.stringify(_metrics));
  return result.text;
}
