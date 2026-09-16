'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Radar, Building2, Server, Briefcase,
  Languages, Users, Activity, ScrollText, Settings as SettingsIcon, LogOut,
} from 'lucide-react';
import { signOutCurrentSession } from '@/lib/auth/auth-flow';

const NAV_ITEMS = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/discovery', label: 'Discovery', icon: Radar },
  { href: '/admin/employers', label: 'Employers', icon: Building2 },
  { href: '/admin/sources', label: 'Sources', icon: Server },
  { href: '/admin/opportunities', label: 'Opportunities', icon: Briefcase },
  { href: '/admin/translation', label: 'Translation', icon: Languages },
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/sync-health', label: 'Sync Health', icon: Activity },
  { href: '/admin/audit-log', label: 'Audit Log', icon: ScrollText },
  { href: '/admin/settings', label: 'Settings', icon: SettingsIcon },
];

export function Sidebar({ adminEmail }: { adminEmail: string }) {
  const pathname = usePathname();

  const handleSignOut = async () => {
    await signOutCurrentSession();
    window.location.replace('/admin/login');
  };

  return (
    <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--surface-soft)] min-h-screen">
      <div className="px-4 py-5 border-b border-[var(--line)]">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-full bg-[var(--red)] text-white shadow-sm">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 17L17 7" />
              <path d="M7 7h10v10" />
            </svg>
          </span>
          <span className="text-sm font-bold text-[var(--ink)]">RemoteMatch Admin</span>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-3">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = href === '/admin' ? pathname === '/admin' : pathname?.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`mx-2 mb-0.5 flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
                active
                  ? 'bg-[var(--red-soft)] text-[var(--red-dark)]'
                  : 'text-[var(--ink)] hover:bg-[var(--surface)]'
              }`}
            >
              <Icon size={15} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-[var(--line)] px-3 py-3">
        <div className="truncate px-1 text-[11px] text-[var(--muted)]">{adminEmail}</div>
        <button
          onClick={handleSignOut}
          className="mt-1.5 flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--ink)]"
        >
          <LogOut size={14} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
