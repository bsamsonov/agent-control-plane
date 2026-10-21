'use client';
/**
 * Approval inbox — list of pending approvals with approve/reject actions.
 */

import { useState, useEffect, useCallback } from 'react';
import { listApprovals, decideApproval } from '@/lib/api';
import type { ApprovalItem } from '@/lib/api';

export default function ApprovalsPage() {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  const fetchApprovals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listApprovals('pending');
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApprovals();
  }, [fetchApprovals]);

  async function handleDecide(id: string, decision: 'approved' | 'rejected') {
    try {
      const note = notes[id]?.trim() || null;
      await decideApproval(id, decision, note);
      // Remove from list
      setItems((prev) => prev.filter((it) => it.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decision failed');
    }
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Approval Inbox</h1>
        <button
          type="button"
          onClick={fetchApprovals}
          className="text-sm text-gray-400 hover:text-gray-200 underline"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-600 rounded px-4 py-2 text-red-400 text-sm font-mono">
          {error}
        </div>
      )}

      {loading && <p className="text-gray-500">Loading…</p>}

      {!loading && items.length === 0 && (
        <p className="text-gray-500 italic">No pending approvals.</p>
      )}

      {items.length > 0 && (
        <div className="border border-gray-700 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-800 text-gray-400 text-left">
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2 font-mono">Run</th>
                <th className="px-3 py-2 font-mono">Step</th>
                <th className="px-3 py-2">Agent</th>
                <th className="px-3 py-2 font-mono">Tool</th>
                <th className="px-3 py-2">Args</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id} className="border-t border-gray-700 hover:bg-gray-800/50 align-top">
                  <td className="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">
                    {formatDate(a.requestedAt)}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-300 max-w-[120px] truncate">
                    {a.runId}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-300">
                    {a.stepId}
                  </td>
                  <td className="px-3 py-2 text-gray-300">{a.agentId}</td>
                  <td className="px-3 py-2 font-mono text-xs text-gray-300">{a.tool}</td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => toggleExpand(a.id)}
                      className="text-xs text-blue-400 hover:underline font-mono"
                    >
                      {expanded[a.id] ? 'Hide' : 'Show'} args
                    </button>
                    {expanded[a.id] && (
                      <pre className="mt-1 text-xs text-gray-400 bg-gray-900 rounded p-2 max-h-40 overflow-auto font-mono whitespace-pre-wrap">
                        {JSON.stringify(a.argsRedacted, null, 2)}
                      </pre>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-col gap-2 min-w-[160px]">
                      <input
                        type="text"
                        placeholder="Note (optional)"
                        className="bg-gray-900 border border-gray-600 rounded px-2 py-1 text-xs text-gray-200 font-mono placeholder-gray-600"
                        value={notes[a.id] ?? ''}
                        onChange={(e) =>
                          setNotes((prev) => ({ ...prev, [a.id]: e.target.value }))
                        }
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => handleDecide(a.id, 'approved')}
                          className="px-3 py-1 bg-green-700 hover:bg-green-600 text-white rounded text-xs font-medium"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDecide(a.id, 'rejected')}
                          className="px-3 py-1 bg-red-700 hover:bg-red-600 text-white rounded text-xs font-medium"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
