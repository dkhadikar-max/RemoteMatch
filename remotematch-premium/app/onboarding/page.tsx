import Link from "next/link";
import { ArrowRight, FileText, Sparkles, Target, UploadCloud } from "lucide-react";

export default function OnboardingPage() {
  return (
    <main className="min-h-screen bg-[#07100f] text-white">
      <div className="mx-auto max-w-5xl px-5 py-8 lg:px-8">
        <Link href="/" className="text-sm text-white/45 hover:text-white">← RemoteMatch</Link>
        <div className="mx-auto max-w-2xl py-14">
          <div className="mb-8 flex items-center gap-2 text-xs text-[#20d6b0]"><Sparkles size={14}/> PROFILE INTELLIGENCE</div>
          <h1 className="text-4xl font-semibold tracking-tight">Build your evidence-backed profile.</h1>
          <p className="mt-4 leading-7 text-white/50">Tell us what you want, then give the system evidence it can verify. Your profile becomes the foundation for every future match.</p>
          <div className="mt-9 grid gap-3 sm:grid-cols-3">
            {[
              [Target,"Intent","Roles, work type, geography"],
              [FileText,"Evidence","Skills, experience, outcomes"],
              [UploadCloud,"Resume","PDF extraction + verification"]
            ].map(([Icon,title,desc]) => { const I = Icon as any; return <div key={title as string} className="rounded-2xl border border-white/10 bg-white/[.035] p-5"><I size={19} className="text-[#20d6b0]"/><p className="mt-8 font-medium">{title as string}</p><p className="mt-1 text-xs leading-5 text-white/40">{desc as string}</p></div>})}
          </div>
          <div className="mt-5 rounded-3xl border border-dashed border-white/15 bg-white/[.02] p-10 text-center">
            <UploadCloud className="mx-auto text-white/40" size={30}/>
            <p className="mt-4 font-medium">Drop your resume here</p>
            <p className="mt-1 text-xs text-white/40">PDF · optional but recommended</p>
            <button className="mt-6 rounded-full bg-[#20d6b0] px-5 py-2.5 text-sm font-semibold text-black">Choose PDF</button>
          </div>
          <button className="mt-6 flex w-full items-center justify-center gap-2 rounded-2xl bg-white px-4 py-3.5 font-semibold text-black">Continue to profile <ArrowRight size={16}/></button>
        </div>
      </div>
    </main>
  );
}
