/**
 * Smoke test for real LLM mode: runs the three agents once against the configured
 * OpenAI-compatible endpoint. Needs LLM_API_KEY (and optionally LLM_BASE_URL, LLM_MODEL).
 *   LLM_API_KEY=... npx tsx scripts/llm-smoke.ts
 */
import { planCampaign, generateContent, summarizeResults } from '../apps/control-plane/src/agents.js';

async function main(): Promise<void> {
  const brief = 'Reactivate customers who have not purchased in 90 days, budget $500, channels email + ads.';
  const t0 = Date.now();
  const plan = await planCampaign(brief);
  console.log('plan:', JSON.stringify(plan, null, 2));
  const content = await generateContent({ segment_size: 20, avg_ltv_usd: 2650, inactive_days: 90 });
  console.log('content:', JSON.stringify(content, null, 2));
  const summary = await summarizeResults({ sent: 20, opens: 9, clicks: 3, charged_usd: 500 });
  console.log('summary:', summary);
  console.log(`ok in ${Date.now() - t0} ms`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
