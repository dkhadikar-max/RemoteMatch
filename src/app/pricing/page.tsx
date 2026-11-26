import type { Metadata } from 'next';
import Link from 'next/link';
import { Check } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Simple, transparent pricing. Get started for free or unlock unlimited saves and advanced filters with RemoteMatch Pro.',
  alternates: { canonical: '/pricing' },
};

export default function PricingPage() {
  return (
    <main className="page">
      <section className="py-16 sm:py-20">
        <div className="container max-w-4xl">
          <div className="text-center max-w-xl mx-auto mb-12">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--red)]">
              Plans & Access
            </span>
            <h1 className="mt-2 text-3xl font-bold text-[var(--ink)]">
              Simple, transparent pricing.
            </h1>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Get started for free or unlock unlimited saves and advanced filters with Pro.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            {/* Free Tier */}
            <div className="soft-card p-7 sm:p-8 rounded-3xl border border-[var(--line)] bg-[var(--surface)] space-y-6">
              <div>
                <h2 className="text-xl font-bold text-[var(--ink)]">RemoteMatch Free</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">Get started for free.</p>
                <div className="mt-4 text-3xl font-bold text-[var(--ink)] mono">₹0</div>
              </div>

              <ul className="space-y-3 text-sm text-[var(--muted)]">
                <li className="flex items-center gap-2">
                  <Check size={15} className="text-[#04714f] stroke-[3]" />
                  <span>15 saves per day</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={15} className="text-[#04714f] stroke-[3]" />
                  <span>5 proposal generations per day</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={15} className="text-[#04714f] stroke-[3]" />
                  <span>Basic role & remote filters</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={15} className="text-[#04714f] stroke-[3]" />
                  <span>Application tracker</span>
                </li>
              </ul>

              <Link
                href="/feed"
                className="block w-full text-center rounded-xl border border-[var(--line)] bg-[var(--surface-soft)] hover:bg-[var(--surface)] text-sm font-semibold text-[var(--ink)] py-3 transition-colors shadow-sm min-h-[44px]"
              >
                Start finding jobs →
              </Link>
            </div>

            {/* Pro Tier */}
            <div className="soft-card p-7 sm:p-8 rounded-3xl border-2 border-[var(--red)] bg-[var(--surface)] space-y-6 relative shadow-md">
              <div className="absolute top-4 right-4 rounded-full bg-[var(--red-soft)] text-[var(--red)] border border-[var(--red-soft-border)] px-3 py-1 text-xs font-semibold uppercase tracking-wide">
                Recommended
              </div>

              <div>
                <h2 className="text-xl font-bold text-[var(--ink)]">RemoteMatch Pro</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">More ways to find the right job.</p>
                <div className="mt-4 text-3xl font-bold text-[var(--ink)] mono">
                  ₹499 <span className="text-sm font-normal text-[var(--muted)]">/month</span>
                </div>
              </div>

              <ul className="space-y-3 text-sm text-[var(--ink)] font-medium">
                <li className="flex items-center gap-2">
                  <Check size={15} className="text-[#04714f] stroke-[3]" />
                  <span>Unlimited saves</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={15} className="text-[#04714f] stroke-[3]" />
                  <span>Unlimited proposal materials</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={15} className="text-[#04714f] stroke-[3]" />
                  <span>Rewind accidental passes</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check size={15} className="text-[#04714f] stroke-[3]" />
                  <span>Advanced salary, timezone & seniority filters</span>
                </li>
              </ul>

              <Link
                href="/settings?tab=billing"
                className="block w-full text-center rounded-xl bg-[var(--red)] hover:bg-[var(--red-dark)] text-white text-sm font-semibold py-3 transition-colors shadow-sm min-h-[44px]"
              >
                Upgrade to Pro →
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
