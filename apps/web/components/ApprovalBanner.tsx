'use client';
/**
 * Approval banner — shown when a step requires manual approval.
 * Links to the /approvals page.
 */

import Link from 'next/link';

interface Props {
  stepId: string;
  reason?: string;
}

export default function ApprovalBanner({ stepId, reason }: Props) {
  return (
    <div className="bg-yellow-900/40 border border-yellow-600 rounded-lg px-4 py-3 my-3">
      <div className="flex items-center gap-3">
        <span className="text-yellow-400 text-lg" aria-hidden>⚠</span>
        <div>
          <p className="font-semibold text-yellow-300">
            Step <code className="font-mono text-yellow-200">{stepId}</code> requires approval
          </p>
          {reason && <p className="text-sm text-yellow-400/80 mt-0.5">{reason}</p>}
        </div>
        <Link
          href="/approvals"
          className="ml-auto px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 text-black font-medium rounded text-sm"
        >
          Go to Approvals
        </Link>
      </div>
    </div>
  );
}
