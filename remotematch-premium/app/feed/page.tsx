import Link from "next/link";
import { ArrowLeft, Check, ChevronRight, Globe2, Heart, RotateCcw, ShieldCheck, X } from "lucide-react";

const jobs = [
  { title: "Senior Product Designer", company: "Arc", fit: 94, location: "Worldwide", salary: "$110k–$145k", tags: ["Figma","SaaS","Systems"], reason: "Strong product systems + SaaS evidence" },
  { title: "AI Product Strategist", company: "Mercury", fit: 88, location: "Worldwide", salary: "$120k–$160k", tags: ["AI","Strategy","Product"], reason: "Strong strategy and AI positioning" },
  { title: "Growth Lead", company: "Linear", fit: 76, location: "Americas / Europe", salary: "$100k–$140k", tags: ["Growth","B2B","Analytics"], reason: "Good role alignment; analytics evidence is partial" }
];

export default function FeedPage() {
  return (
    <main className="min-h-screen bg-[#07100f] text-white">
      <div className="mx-auto max-w-6xl px-5 py-6 lg:px-8">
        <header className="flex items-center justify-between">
          <Link href="/" className="text-sm text-white/60 hover:text-white">← RemoteMatch</Link>
          <div className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-white/60">12 evaluations remaining</div>
        </header>
        <div className="mx-auto max-w-xl py-14">
          <div className="mb-6 flex items-end justify-between">
            <div><p className="text-xs uppercase tracking-[.18em] text-[#20d6b0]">Your feed</p><h1 className="mt-2 text-4xl font-semibold tracking-tight">High-signal remote roles</h1></div>
            <button className="grid size-10 place-items-center rounded-full border border-white/10"><RotateCcw size={16}/></button>
          </div>
          <div className="space-y-4">
            {jobs.map((job) => (
              <article key={job.title} className="rounded-3xl border border-white/10 bg-white/[.035] p-6 shadow-2xl">
                <div className="flex items-start justify-between gap-5">
                  <div>
                    <div className="mb-4 grid size-11 place-items-center rounded-2xl bg-white/10 font-semibold">{job.company[0]}</div>
                    <p className="text-xs text-white/45">{job.company} · {job.location}</p>
                    <h2 className="mt-1 text-2xl font-semibold">{job.title}</h2>
                  </div>
                  <div className="rounded-2xl border border-[#20d6b0]/20 bg-[#20d6b0]/10 px-3 py-2 text-center">
                    <div className="text-xl font-semibold text-[#20d6b0]">{job.fit}%</div>
                    <div className="text-[10px] text-white/50">FIT</div>
                  </div>
                </div>
                <div className="mt-6 flex flex-wrap gap-2">{job.tags.map(t=><span key={t} className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-white/55">{t}</span>)}</div>
                <div className="mt-6 rounded-2xl border border-white/8 bg-black/10 p-4">
                  <p className="text-xs text-white/40">Why you're seeing this</p>
                  <p className="mt-1 text-sm text-white/75">{job.reason}</p>
                </div>
                <div className="mt-5 flex items-center justify-between border-t border-white/8 pt-5">
                  <span className="text-sm text-white/65">{job.salary}</span>
                  <div className="flex gap-2">
                    <button className="grid size-10 place-items-center rounded-full border border-white/10"><X size={17}/></button>
                    <Link href="/match/1" className="grid size-11 place-items-center rounded-full bg-[#20d6b0] text-black"><Heart size={17}/></Link>
                  </div>
                </div>
              </article>
            ))}
          </div>
          <div className="mt-8 flex items-center justify-center gap-5 text-xs text-white/40"><span className="flex items-center gap-1.5"><ShieldCheck size={14}/> Eligibility gated</span><span className="flex items-center gap-1.5"><Globe2 size={14}/> Remote only</span></div>
        </div>
      </div>
    </main>
  );
}
