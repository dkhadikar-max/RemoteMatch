# RemoteMatch Premium Web App

A premium, responsive Next.js 16.3.3 / React 19.2 starter for RemoteMatch, designed around the BYN architecture:

`PERSON + INTENT + OPPORTUNITY → MATCH → DECISION → ACTION → OUTCOME`

## Included

- Premium dark, BYN/Linear-inspired UI
- Landing page with interactive job card preview
- Onboarding / resume intelligence surface
- Remote job feed
- Transparent match analysis
- Application tracker
- Provider-plugin abstraction for job ingestion
- Mobile-first responsive layout
- Tailwind CSS v4
- Motion-based micro-interactions
- Lucide icons

## Recommended production stack

- Next.js 16.3.x + React 19.2
- Tailwind CSS 4.3+
- Motion for React
- Supabase Auth + PostgreSQL + Storage via `@supabase/ssr`
- Gemini / OpenAI behind an `AIProvider` interface
- Stripe for billing
- PostHog for product analytics
- Zod for API validation
- Vercel for deployment

Supabase's current Next.js guidance uses cookie-based SSR with `@supabase/ssr`.

## Run

```bash
npm install
npm run dev
```

Then open `http://localhost:3000`.

## Important

This package is a premium UI/application shell. Connect it to the existing frozen RemoteMatch BYN backend rather than replacing the verified matching, telemetry, ingestion, or RLS logic.

The job provider interface is intentionally plugin-oriented so new sources can be added without coupling them to the UI.
