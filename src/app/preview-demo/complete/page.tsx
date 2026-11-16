import Link from 'next/link';

export default function PreviewDemoCompletePage() {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-2xl items-center px-4 py-12">
      <section className="w-full rounded-3xl border border-[var(--line)] bg-white p-7 text-center shadow-sm sm:p-10">
        <p className="mt-5 text-xs font-bold uppercase tracking-[0.16em] text-[var(--red)]">Preview complete</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-[var(--ink)] sm:text-3xl">Your demo profile is ready</h1>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-[var(--muted)]">
          The onboarding flow completed against local preview data. No account, production profile, or database was changed.
        </p>
        <Link href="/preview-demo" className="soft-button primary mt-6 inline-flex">Back to preview screens</Link>
      </section>
    </main>
  );
}
