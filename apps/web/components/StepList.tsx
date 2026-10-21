'use client';
/**
 * Live step list — renders step events from SSE stream.
 */

import type { StepEvent } from '@/lib/api';

interface Props {
  steps: StepEvent[];
}

const STATUS_COLOR: Record<string, string> = {
  running: 'text-blue-400',
  ok: 'text-green-400',
  failed: 'text-red-400',
  compensated: 'text-orange-400',
  awaiting_approval: 'text-yellow-400',
};

export default function StepList({ steps }: Props) {
  if (steps.length === 0) return null;

  return (
    <div className="mt-4 space-y-2">
      <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">Live Steps</h3>
      <div className="border border-gray-700 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-800 text-gray-400 text-left">
              <th className="px-3 py-2 font-mono">Step</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Policy</th>
              <th className="px-3 py-2">Reason</th>
              <th className="px-3 py-2 text-right">Duration</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s, i) => (
              <tr key={`${s.stepId}-${i}`} className="border-t border-gray-700 hover:bg-gray-800/50">
                <td className="px-3 py-2 font-mono text-gray-300">{s.stepId}</td>
                <td className="px-3 py-2">
                  <span className={`font-medium ${STATUS_COLOR[s.status] ?? 'text-gray-500'}`}>
                    {s.status}
                  </span>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-gray-400">
                  {s.policy ? `${s.policy.effect} / ${s.policy.ruleId}` : '—'}
                </td>
                <td className="px-3 py-2 text-xs text-gray-500 max-w-xs truncate">
                  {s.policy?.reason ?? '—'}
                </td>
                <td className="px-3 py-2 text-right font-mono text-gray-500">
                  {s.durationMs != null ? `${s.durationMs}ms` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
