import { notFound } from 'next/navigation';

/**
 * The /staging dashboard is an internal dev-only tool backed by fixture data
 * (see src/app/api/staging/metrics/route.ts) — never real production
 * numbers, never meant to be publicly reachable. It was never gated, so
 * anyone with the URL could reach it in production (robots.txt disallows
 * crawling it, but that isn't access control). This closes it for real:
 * unreachable (404) once deployed to production, still usable in local
 * dev/preview so it remains available as a dev tool.
 */
export default function StagingLayout({ children }: { children: React.ReactNode }) {
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }
  return children;
}
