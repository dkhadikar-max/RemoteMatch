import Link from "next/link";
import { ArrowRight, CheckCircle2, Clock3, MessageSquareText } from "lucide-react";

const rows = [
  ["Senior Product Designer", "Arc", "Applied", "94%"],
  ["AI Product Strategist", "Mercury", "Interview", "88%"],
  ["Growth Lead", "Linear", "Interested", "76%"]
];

export default function TrackerPage() {
  return (
    <main className="min-h-screen bg-[#07100f] text-white">
      <div className="mx-auto max-w-6xl px-5 py-6 lg:px-8">
        <Link href="/" className="text-sm text-white/50 hover:text-white">← RemoteMatch</Link>
        <div className="mt-12 flex flex-col justify-between gap-4 md:flex-row md:items-end"><div><p className="text-xs uppercase tracking-[.18em] text-[#20d6b0]">Outcome loop</p><h1 className="mt-2 text-4xl font-semibold tracking-tight">Application tracker</h1></div><div className="text-sm text-white/40">3 active opportunities</div></div>
        <div className="mt-8 overflow-hidden rounded-3xl border border-white/10 bg-white/[.03]">
          {rows.map(([role,company,status,fit]) => <div key={role} className="grid gap-4 border-b border-white/8 p-5 last:border-0 md:grid-cols-[1fr_120px_110px_80px] md:items-center"><div><p className="font-medium">{role}</p><p className="mt-1 text-xs text-white/40">{company}</p></div><span className="text-xs text-white/45">Fit {fit}</span><span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-xs text-white/65">{status === "Applied" ? <CheckCircle2 size={13} className="text-[#20d6b0]"/> : <Clock3 size={13}/>} {status}</span><button className="flex items-center gap-1 text-xs text-white/40 hover:text-white">Notes <MessageSquareText size={13}/></button></div>)}
        </div>
        <div className="mt-7 rounded-3xl border border-white/10 bg-white/[.03] p-6"><p className="text-xs uppercase tracking-[.16em] text-white/35">BYN outcome signal</p><p className="mt-2 text-sm text-white/60">Reported interviews feed future calibration. Your original decision-time score remains immutable.</p></div>
      </div>
    </main>
  );
}
