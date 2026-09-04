import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";
import { Compass, UserRound, BriefcaseBusiness } from "lucide-react";

export const metadata: Metadata = { title: "BYN — Know your chances before you apply.", description: "A decision-first remote opportunity platform." };

export default function RootLayout({children}:{children:React.ReactNode}){
 return <html lang="en"><body>
  <header className="sticky top-0 z-30 border-b border-[#e7e7e3] bg-[#fafaf9]/95 backdrop-blur-sm">
   <div className="container flex h-[68px] items-center justify-between gap-6">
    <Link href="/" className="flex items-center gap-2.5 font-bold tracking-tight"><span className="grid size-9 place-items-center rounded-xl bg-[#087f70] text-sm text-white">B</span><span>BYN</span></Link>
    <nav className="hidden items-center gap-1 md:flex">
      <Link className="rounded-xl px-4 py-2 text-sm hover:bg-[#f1f1ef]" href="/feed">Discover</Link>
      <Link className="rounded-xl px-4 py-2 text-sm hover:bg-[#f1f1ef]" href="/tracker">Applications</Link>
      <Link className="rounded-xl px-4 py-2 text-sm hover:bg-[#f1f1ef]" href="/settings">Profile</Link>
    </nav>
    <div className="hidden items-center gap-3 md:flex"><span className="status good"><span className="size-1.5 rounded-full bg-current"/>12 evaluations remaining</span><span className="grid size-9 place-items-center rounded-full border border-[#e7e7e3] bg-white text-sm">D</span></div>
   </div>
  </header>
  {children}
  <nav className="fixed inset-x-3 bottom-3 z-40 flex items-center justify-around rounded-2xl border border-[#e2e2df] bg-white/95 p-2 shadow-[0_12px_35px_rgba(24,25,23,.12)] backdrop-blur md:hidden">
   <Link href="/feed" className="grid place-items-center gap-0.5 rounded-xl px-5 py-2 text-[11px]"><Compass size={18}/><span>Discover</span></Link>
   <Link href="/tracker" className="grid place-items-center gap-0.5 rounded-xl px-5 py-2 text-[11px]"><BriefcaseBusiness size={18}/><span>Applications</span></Link>
   <Link href="/settings" className="grid place-items-center gap-0.5 rounded-xl px-5 py-2 text-[11px]"><UserRound size={18}/><span>Profile</span></Link>
  </nav>
 </body></html>
}
