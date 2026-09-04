 "use client";

import { useState } from "react";
import { ArrowRight, BriefcaseBusiness, Check, ChevronRight, CircleHelp, Globe2, Menu, RotateCcw, Search, ShieldCheck, Sparkles, X, Zap } from "lucide-react";
import { motion } from "motion/react";

const jobs = [
  { id: "1", title: "Senior Product Designer", company: "Arc", location: "Worldwide", salary: "$110k–$145k", score: 94, tags: ["Figma", "SaaS", "Systems"] },
  { id: "2", title: "Product Growth Manager", company: "Remote", location: "Americas / Europe", salary: "$95k–$125k", score: 86, tags: ["Growth", "B2B", "Analytics"] },
  { id: "3", title: "AI Product Strategist", company: "Mercury", location: "Worldwide", salary: "$120k–$160k", score: 78, tags: ["AI", "Strategy", "Product"] }
];

function Score({ value }: { value: number }) {
  return (
    <div className="relative grid size-14 place-items-center rounded-full border border-white/10 bg-black/20">
      <div className="absolute inset-1 rounded-full border-2 border-[var(--teal)]" style={{ clipPath: `inset(0 ${100-value}% 0 0)` }} />
      <span className="text-sm font-semibold">{value}%</span>
    </div>
  );
}

export default function RemoteMatchShell() {
  const [index, setIndex] = useState(0);
  const [saved, setSaved] = useState<string[]>([]);
  const job = jobs[index % jobs.length];

  const next = () => setIndex((v) => v + 1);

  return (
    <main className="noise min-h-screen overflow-hidden">
      <div className="grid-bg pointer-events-none fixed inset-0" />
      <nav className="relative z-10 mx-auto flex max-w-7xl items-center justify-between px-5 py-5 lg:px-8">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-xl bg-[var(--teal)] text-black shadow-[0_0_30px_rgba(32,214,176,.25)]">
            <Sparkles size={18} strokeWidth={2.5} />
          </div>
          <span className="text-lg font-semibold tracking-tight">RemoteMatch</span>
        </div>
        <div className="hidden items-center gap-7 text-sm text-[var(--muted)] md:flex">
          <a href="#how" className="transition hover:text-white">How it works</a>
          <a href="#intelligence" className="transition hover:text-white">Match intelligence</a>
          <a href="#proof" className="transition hover:text-white">Why RemoteMatch</a>
        </div>
        <button className="hidden rounded-full border border-white/10 bg-white/[.04] px-4 py-2 text-sm md:block">Sign in</button>
        <button className="grid size-10 place-items-center rounded-full border border-white/10 bg-white/[.04] md:hidden"><Menu size={18}/></button>
      </nav>

      <section className="relative mx-auto max-w-7xl px-5 pb-20 pt-14 lg:px-8 lg:pt-24">
        <div className="grid items-center gap-16 lg:grid-cols-[1.05fr_.95fr]">
          <div>
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--teal)]/20 bg-[var(--teal-soft)] px-3 py-1.5 text-xs font-medium text-[var(--teal)]">
              <Zap size={13} /> Decision intelligence for remote work
            </div>
            <h1 className="max-w-3xl text-5xl font-semibold tracking-[-.045em] sm:text-6xl lg:text-7xl">
              Know your chances <span className="text-[var(--teal)]">before</span> you apply.
            </h1>
            <p className="mt-7 max-w-xl text-lg leading-8 text-[var(--muted)]">
              Upload your resume. Tell us what you want. RemoteMatch evaluates real opportunities against your evidence, intent and eligibility—then tells you what to do next.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <button className="group flex items-center justify-center gap-2 rounded-full bg-[var(--teal)] px-6 py-3.5 font-semibold text-black shadow-[0_10px_40px_rgba(32,214,176,.18)] transition hover:-translate-y-0.5">
                Analyze my resume <ArrowRight size={17} className="transition group-hover:translate-x-1"/>
              </button>
              <button className="rounded-full border border-white/10 bg-white/[.035] px-6 py-3.5 font-medium text-white hover:bg-white/[.06]">Explore the product</button>
            </div>
            <div className="mt-10 flex flex-wrap gap-x-6 gap-y-3 text-xs text-[var(--muted)]">
              <span className="flex items-center gap-2"><ShieldCheck size={15} className="text-[var(--teal)]"/> Evidence-grounded</span>
              <span className="flex items-center gap-2"><Globe2 size={15} className="text-[var(--teal)]"/> Worldwide remote</span>
              <span className="flex items-center gap-2"><BriefcaseBusiness size={15} className="text-[var(--teal)]"/> Official apply links</span>
            </div>
          </div>

          <div className="relative mx-auto w-full max-w-[510px]">
            <div className="absolute -inset-12 rounded-full bg-[var(--teal)]/10 blur-3xl"/>
            <div className="glass relative rounded-[30px] p-3">
              <div className="rounded-[24px] bg-[#0a1412] p-5">
                <div className="mb-5 flex items-center justify-between">
                  <div>
                    <p className="text-xs text-[var(--muted)]">Recommended for you</p>
                    <h2 className="mt-1 text-xl font-semibold">Remote opportunities</h2>
                  </div>
                  <div className="rounded-full border border-white/10 px-3 py-1 text-xs text-[var(--muted)]">18 left today</div>
                </div>
                <motion.div
                  key={job.id + index}
                  initial={{ opacity: 0, y: 12, rotate: 1 }}
                  animate={{ opacity: 1, y: 0, rotate: 0 }}
                  className="rounded-[22px] border border-white/10 bg-gradient-to-br from-white/[.07] to-white/[.025] p-6"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-white/10 text-sm font-bold">{job.company[0]}</div>
                      <p className="text-xs text-[var(--muted)]">{job.company} · {job.location}</p>
                      <h3 className="mt-1 text-2xl font-semibold tracking-tight">{job.title}</h3>
                    </div>
                    <Score value={job.score}/>
                  </div>
                  <div className="mt-7 flex flex-wrap gap-2">
                    {job.tags.map(tag => <span key={tag} className="rounded-full border border-white/10 bg-white/[.035] px-2.5 py-1 text-xs text-[var(--muted)]">{tag}</span>)}
                  </div>
                  <div className="mt-7 flex items-center justify-between border-t border-white/10 pt-5">
                    <div><p className="text-xs text-[var(--muted)]">Estimated range</p><p className="mt-1 font-medium">{job.salary}</p></div>
                    <span className="rounded-full bg-[var(--teal-soft)] px-3 py-1.5 text-xs font-medium text-[var(--teal)]">Strong fit</span>
                  </div>
                </motion.div>
                <div className="mt-4 flex items-center justify-center gap-3">
                  <button onClick={next} className="grid size-12 place-items-center rounded-full border border-white/10 bg-white/[.035] hover:bg-white/[.07]" aria-label="Pass"><X size={19}/></button>
                  <button onClick={() => setSaved(s => s.includes(job.id) ? s : [...s, job.id])} className="grid size-14 place-items-center rounded-full bg-[var(--teal)] text-black shadow-[0_8px_30px_rgba(32,214,176,.16)]" aria-label="Interested"><Check size={21}/></button>
                  <button onClick={() => setIndex(Math.max(0,index-1))} className="grid size-12 place-items-center rounded-full border border-white/10 bg-white/[.035] hover:bg-white/[.07]" aria-label="Rewind"><RotateCcw size={17}/></button>
                </div>
                <div className="mt-4 text-center text-[11px] text-[var(--muted)]">Swipe right to see the full match analysis</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="intelligence" className="mx-auto max-w-7xl px-5 py-24 lg:px-8">
        <div className="grid gap-5 lg:grid-cols-3">
          {[
            ["01", "Profile intelligence", "Turn your resume and onboarding answers into a verified evidence graph—not a generic keyword list."],
            ["02", "Opportunity intelligence", "Normalize, deduplicate and quality-check remote roles before they reach your feed."],
            ["03", "Decision intelligence", "See fit, gaps, eligibility and concrete resume improvements before spending time applying."]
          ].map(([n,t,d]) => (
            <div key={n} className="glass rounded-3xl p-7">
              <span className="text-xs text-[var(--teal)]">{n}</span>
              <h3 className="mt-12 text-xl font-semibold">{t}</h3>
              <p className="mt-3 text-sm leading-6 text-[var(--muted)]">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how" className="border-y border-white/5 bg-white/[.015]">
        <div className="mx-auto max-w-7xl px-5 py-24 lg:px-8">
          <div className="grid gap-12 lg:grid-cols-[.8fr_1.2fr]">
            <div>
              <p className="text-xs font-medium uppercase tracking-[.2em] text-[var(--teal)]">The BYN loop</p>
              <h2 className="mt-4 text-4xl font-semibold tracking-tight">From profile to outcome.</h2>
              <p className="mt-5 max-w-md leading-7 text-[var(--muted)]">The swipe is only the interaction. The system is designed around the complete decision chain.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {["Person + Intent", "Opportunity", "Match", "Decision", "Action", "Outcome"].map((x,i) => (
                <div key={x} className="flex items-center justify-between rounded-2xl border border-white/8 bg-white/[.025] p-5">
                  <span className="text-sm font-medium">{x}</span>
                  <span className="text-xs text-[var(--muted)]">{String(i+1).padStart(2,"0")}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section id="proof" className="mx-auto max-w-7xl px-5 py-24 lg:px-8">
        <div className="glass overflow-hidden rounded-[32px] p-8 lg:p-12">
          <div className="grid gap-10 lg:grid-cols-[1fr_auto] lg:items-center">
            <div>
              <p className="text-xs uppercase tracking-[.2em] text-[var(--teal)]">Built for trust</p>
              <h2 className="mt-4 max-w-2xl text-3xl font-semibold tracking-tight">No invented achievements. No false eligibility. No black-box fit score.</h2>
              <p className="mt-4 max-w-2xl leading-7 text-[var(--muted)]">Every recommendation is anchored to candidate evidence and explicit opportunity constraints. The system records decision-time context so later outcomes can calibrate the model.</p>
            </div>
            <div className="grid min-w-[190px] gap-3">
              {["Evidence grounded", "Eligibility gated", "Outcome tracked"].map(x => <div key={x} className="flex items-center gap-2 text-sm"><Check size={16} className="text-[var(--teal)]"/>{x}</div>)}
            </div>
          </div>
        </div>
      </section>

      <footer className="mx-auto flex max-w-7xl items-center justify-between px-5 py-10 text-xs text-[var(--muted)] lg:px-8">
        <span>© 2026 RemoteMatch</span>
        <span>BYN · Person → Intent → Opportunity → Match → Decision → Action → Outcome</span>
      </footer>
    </main>
  );
}
