'use client';
/**
 * Header with tenant/user switcher.
 * Stores the selected user in localStorage under key "macp_user".
 */

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { DEFAULT_USER } from '../lib/api';

const USERS = [
  'marketer@acme.test',
  'admin@acme.test',
  'viewer@acme.test',
  'marketer@globex.test',
] as const;

export default function Header() {
  const [user, setUser] = useState('');

  useEffect(() => {
    const stored = localStorage.getItem('macp_user') ?? DEFAULT_USER;
    localStorage.setItem('macp_user', stored);
    setUser(stored);
  }, []);

  function handleChange(next: string) {
    localStorage.setItem('macp_user', next);
    setUser(next);
    // Pages fetch on mount; reload so the inbox and traces show the new tenant's data.
    window.location.reload();
  }

  return (
    <header className="border-b border-gray-700 bg-gray-900 px-4 py-2 flex items-center gap-4">
      <Link href="/" className="text-lg font-bold tracking-tight text-gray-100">
        MACP
      </Link>
      <nav className="flex gap-3 text-sm">
        <Link href="/" className="text-gray-400 hover:text-gray-200">Run</Link>
        <Link href="/approvals" className="text-gray-400 hover:text-gray-200">Approvals</Link>
        <Link href="/traces" className="text-gray-400 hover:text-gray-200">Traces</Link>
      </nav>
      <div className="ml-auto">
        <label className="text-xs text-gray-500 mr-2">User:</label>
        <select
          value={user}
          onChange={(e) => handleChange(e.target.value)}
          className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-gray-200 font-mono"
        >
          {USERS.map((u) => (
            <option key={u} value={u}>{u}</option>
          ))}
        </select>
      </div>
    </header>
  );
}
