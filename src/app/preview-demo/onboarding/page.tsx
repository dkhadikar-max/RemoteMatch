// Renders the real candidate onboarding component, unmodified. Its GET
// /api/onboarding prefill call is mocked to 404 (same as a brand-new user
// gets on the real app — an empty form), and its POST submit is mocked to
// succeed. See src/lib/preview-demo/mock-fetch.ts.
export { default } from '@/app/onboarding/page';
