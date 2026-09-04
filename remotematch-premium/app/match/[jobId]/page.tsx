import Link from "next/link";
import { ArrowRight, Check, ChevronDown, CircleAlert, ExternalLink, ShieldCheck, Sparkles } from "lucide-react";

export default async function MatchPage({ params }: { params: Promise<{ jobId: string }> }) {
  await params;
  const checks = [
    ["Role & intent alignment", "Strong", "Your target roles overlap directly."],
    ["Core skills", "Strong", "8 of 9 core requirements evidenced."],
    ["Seniority & type", "Strong", "Senior + full-time compatible."],
    ["Remote eligibility", "Confirmed", "Worldwide access confirmed."],
    ["Evidence quality", "Good", "One capability needs stronger proof."]
  ];
  return (
    <main className="min-h-screen bg-[#07100f] text-white">
      <div className="mx-auto max-w-6xl px-5 py-6 lg:px-8">
        <Link href="/feed" className="text-sm text-white/50 hover:text-white">← Back to feed</Link>
        <div className="mt-10 grid gap-6 lg:grid-cols-[1.25fr_.75fr]">
          <section className="rounded-[32px] border border-white/10 bg-white/[.035] p-7 lg:p-9">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div><div className="mb-4 grid size-12 place-items-center rounded-2xl bg-white/10 font-semibold">A</div><p className="text-xs text-white/45">Arc · Worldwide</p><h1 className="mt-1 text-4xl font-semibold tracking-tight">Senior Product Designer</h1><p className="mt-3 text-white/50">$110k–$145k · Full-time · Remote</p></div>
              <div className="rounded-3xl border border-[#20d6b0]/25 bg-[#20d6b0]/10 p-5 text-center"><div className="text-4xl font-semibold text-[#20d6b0]">94%</div><div className="mt-1 text-xs text-white/45">Strong fit</div></div>
            </div>

            <div className="mt-9 rounded-2xl border border-white/8 bg-black/10 p-5">
              <div className="flex items-center justify-between"><h2 className="font-semibold">Why you're seeing this</h2><Sparkles size={17} className="text-[#20d6b0]"/></div>
              <p className="mt-3 text-sm leading-6 text-white/60">Your product design background, SaaS experience and systems thinking align strongly with the role. One analytics requirement is only partially evidenced.</p>
            </div>

            <div className="mt-7">
              <div className="flex items-center justify-between"><h2 className="text-xl font-semibold">How is this calculated?</h2><ChevronDown size={18} className="text-white/40"/></div>
              <div className="mt-4 divide-y divide-white/8 rounded-2xl border border-white/8">
                {checks.map(([name,status,desc]) => <div key={name} className="flex items-start justify-between gap-5 p-4"><div><p className="text-sm font-medium">{name}</p><p className="mt-1 text-xs leading-5 text-white/40">{desc}</p></div><span className="shrink-0 rounded-full bg-white/5 px-2.5 py-1 text-[11px] text-[#20d6b0]">{status}</span></div>)}
              </div>
            </div>

            <div className="mt-7 rounded-2xl border border-[#7c7cff]/20 bg-[#7c7cff]/7 p-5">
              <p className="text-xs uppercase tracking-[.16em] text-[#a9a9ff]">What could change this score?</p>
              <p className="mt-2 text-sm leading-6 text-white/65">Add one concrete analytics outcome from a real project. Do not invent a metric; supply the real scope and result and we will re-evaluate your evidence.</p>
            </div>
          </section>

          <aside className="space-y-4">
            <div className="rounded-[28px] border border-white/10 bg-white/[.035] p-6">
              <div className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={17} className="text-[#20d6b0]"/> Application readiness</div>
              <div className="mt-5 space-y-3">{["Eligibility passed","8/9 requirements evidenced","3 resume improvements ready"].map(x=><div key={x} className="flex items-center gap-2 text-sm text-white/65"><Check size={15} className="text-[#20d6b0]"/>{x}</div>)}</div>
              <button className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-[#20d6b0] px-4 py-3 font-semibold text-black">Build application kit <ArrowRight size={16}/></button>
            </div>
            <div className="rounded-[28px] border border-white/10 bg-white/[.035] p-6">
              <p className="text-xs uppercase tracking-[.16em] text-white/35">Job-specific improvements</p>
              <div className="mt-4 space-y-4">{["Move SaaS systems work higher", "Strengthen one analytics bullet", "Lead with product outcomes"].map((x,i)=><div key={x} className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#20d6b0]/10 text-xs text-[#20d6b0]">{i+1}</span><p className="text-sm leading-5 text-white/65">{x}</p></div>)}</div>
            </div>
            <a href="https://example.com" target="_blank" rel="noreferrer" className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[.04] px-4 py-3 text-sm font-medium">Apply on official website <ExternalLink size={15}/></a>
            <p className="flex items-center gap-2 px-1 text-[11px] text-white/35"><CircleAlert size={13}/> Verify the destination before submitting sensitive information.</p>
          </aside>
        </div>
      </div>
    </main>
  );
}
