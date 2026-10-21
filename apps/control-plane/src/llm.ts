/**
 * LLM model access: any OpenAI-compatible endpoint (OpenAI, a local gateway, vLLM, Ollama),
 * or a deterministic fake when MACP_FAKE_LLM=1 (no network; used by tests, CI and the demo).
 *
 * Real mode is configured by three variables:
 *   LLM_BASE_URL  default https://api.openai.com/v1
 *   LLM_API_KEY   required in real mode
 *   LLM_MODEL     default gpt-4o-mini; the model must support JSON structured output
 */
/** Canned planner output for fake LLM mode. */
export const FAKE_PLAN_OUTPUT = {
  object: {
    steps: [
      { id: '1', title: 'Find inactive customers', tool: 'crm.search_customers', rationale: 'Identify re-engagement targets' },
      { id: '2', title: 'Calculate segment stats', tool: 'crm.get_segment_stats', rationale: 'Size the audience' },
      { id: '3', title: 'Create campaign in ESP', tool: 'esp.create_campaign', rationale: 'Set up the email campaign' },
      { id: '4', title: 'Send re-engagement email', tool: 'esp.send_email', rationale: 'Deliver the message' },
      { id: '5', title: 'Pull campaign metrics', tool: 'analytics.get_campaign_metrics', rationale: 'Measure results' },
    ],
  },
};

export const FAKE_PLAN_STEPS = FAKE_PLAN_OUTPUT.object.steps;

/** Canned content output for fake LLM mode. */
export const FAKE_CONTENT_OUTPUT = {
  object: {
    subject: 'We miss you!',
    body: 'It has been a while since we last saw you. Come back and enjoy 15% off your next purchase!',
    channel: 'email' as const,
  },
};

/** Canned summary output for fake LLM mode. */
export const FAKE_SUMMARY_OUTPUT = {
  text: 'Campaign completed. Metrics collected. All steps executed successfully.',
};

/** Check whether we are in fake mode. Read lazily: tests set the flag after import. */
export function isFakeLLM(): boolean {
  return process.env.MACP_FAKE_LLM === '1';
}

/** Mastra model config for the configured OpenAI-compatible endpoint. */
export function llmModelConfig(): { providerId: string; modelId: string; url: string; apiKey: string } {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error('LLM_API_KEY is not set. Set it, or run with MACP_FAKE_LLM=1 for offline mode.');
  }
  return {
    providerId: 'openai-compatible',
    modelId: process.env.LLM_MODEL ?? 'gpt-4o-mini',
    url: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey,
  };
}
