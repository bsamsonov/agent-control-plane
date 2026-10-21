'use client';
/**
 * Audit traces — table of audit_log entries with run_id filter and drill-down drawer.
 */

import { useState, useEffect, useCallback } from 'react';
import { listAudit } from '@/lib/api';
import type { AuditItem } from '@/lib/api';

const DECISION_COLOR: Record<string, string> = {
  allow: 'text-green-400',
  deny: 'text-red-400',
  require_approval: 'text-yellow-400',
  approved_by_human: 'text-sky-400',
};

export default function TracesPage() {
  const [rows, setRows] = useState<AuditItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterRunId, setFilterRunId] = useState('');
  const [selected, setSelected] = useState<AuditItem | null>(null);

  const fetchTraces = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listAudit({
        limit: 200,
        ...(filterRunId.trim() ? { runId: filterRunId.trim() } : {}),
      });
      setRows(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [filterRunId]);

  useEffect(() => {
    fetchTraces();
  }, [fetchTraces]);

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  return (
    <div className="space-y-6 relative">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold">Audit Traces</h1>
        <div className="flex items-center gap-3">
          <input
            type="text"
            placeholder="Filter by runId…"
            className="bg-gray-900 border border-gray-600 rounded px-3 py-1.5 text-sm text-gray-200 font-mono placeholder-gray-600 w-64"
            value={filterRunId}
            onChange={(e) => setFilterRunId(e.target.value)}
          />
          <button
            type="button"
            onClick={fetchTraces}
            className="text-sm text-gray-400 hover:text-gray-200 underline"
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-600 rounded px-4 py-2 text-red-400 text-sm font-mono">
          {error}
        </div>
      )}

      {loading && <p className="text-gray-500">Loading…</p>}

      {!loading && rows.length === 0 && (
        <p className="text-gray-500 italic">No audit entries found.</p>
      )}

      {rows.length > 0 && (
        <div className="border border-gray-700 rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-800 text-gray-400 text-left">
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Actor</th>
                <th className="px-3 py-2">Agent</th>
                <th className="px-3 py-2 font-mono">Tool</th>
                <th className="px-3 py-2">Decision</th>
                <th className="px-3 py-2 font-mono">Rule</th>
                <th className="px-3 py-2">Reason</th>
                <th className="px-3 py-2 text-right">Latency</th>
                <th className="px-3 py-2 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-gray-700 hover:bg-gray-800/50 cursor-pointer"
                  onClick={() => setSelected(r)}
                >
                  <td className="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">
                    {formatDate(r.ts)}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-300 font-mono">{r.actor}</td>
                  <td className="px-3 py-2 text-gray-300">{r.agentId ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-300">{r.tool ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`font-medium ${DECISION_COLOR[r.decision] ?? 'text-gray-400'}`}>
                      {r.decision}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-500">{r.ruleId ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-gray-500 max-w-[260px] truncate" title={r.reason ?? undefined}>
                    {r.reason ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-gray-500">
                    {r.latencyMs != null ? `${r.latencyMs}ms` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-gray-500">
                    {r.costUsd != null ? `$${r.costUsd.toFixed(4)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Drill-down drawer */}
      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setSelected(null)}
          />
          <div className="relative w-full max-w-lg bg-gray-900 border-l border-gray-700 overflow-y-auto p-6">
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="absolute top-4 right-4 text-gray-500 hover:text-gray-300 text-xl leading-none"
              aria-label="Close"
            >
              ✕
            </button>
            <h2 className="text-lg font-bold mb-4">Audit Record #{selected.id}</h2>
            <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap bg-gray-950 rounded p-4 overflow-auto max-h-[80vh]">
              {JSON.stringify(selected, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
