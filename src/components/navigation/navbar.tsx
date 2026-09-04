'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Compass,
  Briefcase,
  User,
  Sparkles,
  Sun,
  Moon,
  Layers,
  ArrowUpRight,
  Activity,
} from 'lucide-react';

export function Navbar() {
  const pathname = usePathname();
  const [isDark, setIsDark] = useState(true);
  const [evaluationCount, setEvaluationCount] = useState(3);
  const maxFree = 20;

  useEffect(() => {
    // Check initial theme
    if (typeof window !== 'undefined') {
      const isLightTheme = document.documentElement.classList.contains('light');
      setIsDark(!isLightTheme);
    }
  }, []);

  const toggleTheme = () => {
    if (typeof window !== 'undefined') {
      if (isDark) {
        document.documentElement.classList.add('light');
        setIsDark(false);
      } else {
        document.documentElement.classList.remove('light');
        setIsDark(true);
      }
    }
  };

  const navItems = [
    { label: 'Feed', href: '/feed', icon: Compass },
    { label: 'Tracker', href: '/tracker', icon: Briefcase },
    { label: 'Profile', href: '/settings', icon: User },
    { label: 'Control Room', href: '/staging', icon: Activity },
  ];

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <Link href="/feed" className="flex items-center gap-2 group">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-emerald-500 to-indigo-500 shadow-md shadow-emerald-500/10 group-hover:scale-105 transition-transform">
              <Layers className="h-5 w-5 text-white" />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-base tracking-tight text-foreground">
                  RemoteMatch
                </span>
                <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-400 border border-indigo-500/20">
                  BYN
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground hidden sm:block">
                High-Signal Remote Matching
              </span>
            </div>
          </Link>
        </div>

        {/* Center Nav */}
        <nav className="flex items-center gap-1 sm:gap-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-secondary text-foreground font-semibold'
                    : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                }`}
              >
                <Icon className={`h-4 w-4 ${isActive ? 'text-primary' : ''}`} />
                <span className="hidden sm:inline">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Right Controls: Daily limit quota + Pro Upgrade + Theme */}
        <div className="flex items-center gap-2.5">
          {/* Daily Evaluation Counter */}
          <div className="hidden md:flex items-center gap-1.5 rounded-full border border-border bg-secondary/60 px-3 py-1 text-xs">
            <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-muted-foreground">Evaluations:</span>
            <span className="font-semibold text-foreground">
              {maxFree - evaluationCount} / {maxFree}
            </span>
          </div>

          {/* Pro Badge / Upgrade */}
          <Link
            href="/settings?tab=billing"
            className="flex items-center gap-1 rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-xs font-semibold text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors"
          >
            <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
            <span>Pro $12</span>
          </Link>

          {/* Theme Switcher */}
          <button
            onClick={toggleTheme}
            aria-label="Toggle Theme"
            className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </header>
  );
}
