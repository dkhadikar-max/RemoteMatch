import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RemoteMatch — Know your chances before you apply.",
  description: "AI-powered remote job matching built on the BYN decision architecture."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
