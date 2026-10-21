'use client';
/**
 * Home screen — campaign brief form with SSE live step stream.
 */

import { useState, useRef, useCallback } from 'react';
import { createCampaign, streamRunSteps } from '@/lib/api';
import type { StepEvent } from '@/lib/api';
import StepList from '@/components/StepList';
import ApprovalBanner from '@/components/ApprovalBanner';

export default function HomePage() {
  const [brief, setBrief] = useState('');
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasApproval, setHasApproval] = useState(false);
  const [finalStatus, setFinalStatus] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  const handleRun = useCallback(async () => {
    if (!brief.trim()) return;
    setError(null);
    setSteps([]);
    setHasApproval(false);
    setFinalStatus(null);
    setRunning(true);

    try {
      const { runId: rid } = await createCampaign(brief.trim());
      setRunId(rid);

      ctrlRef.current = streamRunSteps(
        rid,
        (ev: StepEvent) => {
          setSteps((prev) => [...prev, ev]);
          // The banner shows while a step waits for a human and hides once a step completes after it.
          setHasApproval(ev.status === 'awaiting_approval');
        },
        (status, runError) => {
          setFinalStatus(status);
          if (runError) setError(`Run ${status}: ${runError}`);
          setHasApproval(false);
          setRunning(false);
          ctrlRef.current = null;
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setRunning(false);
    }
  }, [brief]);

  const handleStop = useCallback(() => {
    ctrlRef.current?.abort();
    ctrlRef.current = null;
    setRunning(false);
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Campaign Brief</h1>

      <textarea
        className="w-full h-32 bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-gray-200 font-mono text-sm placeholder-gray-600 focus:outline-none focus:border-gray-500 resize-y"
        placeholder='Describe your campaign… e.g. "re-engage inactive customers with a 20% off promo"'
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
        disabled={running}
      />

      <div className="flex gap-3 items-center">
        <button
          type="button"
          disabled={running || !brief.trim()}
          onClick={handleRun}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded font-medium transition-colors"
        >
          {running ? 'Running…' : 'Run'}
        </button>
        {running && (
          <button
            type="button"
            onClick={handleStop}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded font-medium"
          >
            Stop
          </button>
        )}
        {runId && (
          <code className="text-xs text-gray-500 font-mono">run: {runId}</code>
        )}
        {finalStatus && (
          <span className={`text-sm font-medium ${finalStatus === 'done' ? 'text-green-400' : 'text-orange-400'}`}>
            run {finalStatus}
          </span>
        )}
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-600 rounded px-4 py-2 text-red-400 text-sm font-mono">
          {error}
        </div>
      )}

      {hasApproval && (
        <ApprovalBanner
          stepId={steps.find((s) => s.status === 'awaiting_approval')?.stepId ?? ''}
          reason={steps.find((s) => s.status === 'awaiting_approval')?.policy?.reason}
        />
      )}

      <StepList steps={steps} />
    </div>
  );
}
