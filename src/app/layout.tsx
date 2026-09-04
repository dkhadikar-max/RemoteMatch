import type { Metadata } from 'next';
import './globals.css';
import { Navbar } from '@/components/navigation/navbar';

export const metadata: Metadata = {
  title: 'RemoteMatch — BYN Remote Job & Opportunity Intelligence',
  description:
    'Swipe remote jobs → Understand your fit → Tailor your application → Apply on the official website. High-signal opportunity matching built on the BYN architecture.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground antialiased min-h-screen flex flex-col selection:bg-emerald-500/30 selection:text-emerald-300">
        <Navbar />
        <main className="flex-1 flex flex-col">{children}</main>
      </body>
    </html>
  );
}
