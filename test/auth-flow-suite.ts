/**
 * RemoteMatch — Auth Flow HTTP suite (email + password login, 2026-09-16 reversal)
 * ==============================================================================
 * Supersedes the Auth Flow Change (AFC)'s passwordless-OTP-only contract per
 * explicit product direction: "login should only be email and password, no
 * otp." New contract:
 *   /signup: supabase.auth.signUp({ email, password, options:{data:{full_name}} })
 *     -> VerifyCode screen (UNCHANGED — still an emailed CODE, since an
 *        unverified inbox must never grant access) -> verifyOtp({ email,
 *        token: code, type: 'email' }) -> session established
 *   /login: supabase.auth.signInWithPassword({ email, password }) -> session
 *     established directly, no code screen at all
 *   /forgot-password + /reset-password: resetPasswordForEmail() ->
 *     /auth/confirm (type=recovery) -> /reset-password -> updateUser({password})
 *     — the path for every pre-existing passwordless account (AFC-era) to
 *     get a password, and for anyone who forgets theirs.
 *
 * Everything downstream of "a session exists" (onboarding boundary, routing
 * matrix, cross-user isolation, E1 no-fabricated-defaults) is UNCHANGED by
 * this reversal — those sections are preserved as-is, just now reached via
 * signUp+verifyOtp+signInWithPassword instead of signInWithOtp twice.
 *
 * Run: TEST_BASE_URL=... npx tsx test/auth-flow-suite.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { hasRequiredEnv, adminClient, anonKeyClient, uniqueEmail, sessionCookieHeader } from './helpers/verified-session';
import { isAccountVerified } from '../src/lib/auth/get-authenticated-user';
import type { User } from '@supabase/supabase-js';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
let passed = 0, failed = 0, skipped = 0;
function assert(c: boolean, m: string) { if (c) { passed++; console.log(`  ✓ ${m}`); } else { failed++; console.error(`  ✗ ${m}`); } }
function skip(m: string) { skipped++; console.log(`  – SKIP: ${m}`); }
const isRedirectTo = (res: Response, frag: string) =>
  [301, 302, 303, 307, 308].includes(res.status) && (res.headers.get('location') || '').includes(frag);

const COMPLETE = {
  fullName: 'AFC Test User', headline: 'Engineer',
  employmentTypes: ['Full-time'], targetRoles: ['Backend Engineer'],
  yearsOfExperience: '4-6', minSalary: 100000, preferredCurrency: 'USD',
  skills: [{ name: 'TypeScript', isPrimary: true }, { name: 'Postgres', isPrimary: false }],
  workPreference: 'worldwide', currentCountry: 'Portugal', currentTimezone: 'WET',
  allowedCountries: ['Worldwide'], willingTimezones: ['UTC', 'WET'], rawResumeText: 'test resume',
};

const TEST_PASSWORD = 'Correct-Horse-Battery-Staple-1';

/** Obtain a real OTP code for `email`'s pending signup verification via the
 *  admin API — this is exactly what Supabase emails as {{ .Token }}. Used
 *  only to complete the signup-verification step; the account itself is
 *  created with a real password via signUp(), not via this call. */
async function issueOtp(email: string): Promise<string> {
  const admin = adminClient();
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error || !data?.properties?.email_otp) {
    throw new Error(`generateLink failed: ${error?.message ?? 'no email_otp'}`);
  }
  return data.properties.email_otp;
}

/** Creates a brand-new account with a real password, then completes the
 *  (unchanged) code-verification step and returns the established session. */
async function signUpAndVerify(email: string, password: string, fullName: string) {
  const client = anonKeyClient();
  const { error: signUpErr } = await client.auth.signUp({ email, password, options: { data: { full_name: fullName } } });
  if (signUpErr) throw new Error(`signUp failed: ${signUpErr.message}`);
  const code = await issueOtp(email);
  const result = await anonKeyClient().auth.verifyOtp({ email, token: code, type: 'email' });
  if (result.error || !result.data.session) throw new Error(`verifyOtp failed: ${result.error?.message}`);
  return result;
}

async function run() {
  console.log('='.repeat(78));
  console.log('AUTH FLOW — HTTP SUITE (EMAIL + PASSWORD LOGIN)');
  console.log('='.repeat(78));

  // --- §0 source checks (always) ---
  console.log('\n0. SOURCE — password login, code-verified signup, password reset');
  const authFlow = fs.readFileSync(path.resolve(__dirname, '../src/lib/auth/auth-flow.ts'), 'utf8');
  assert(
    /export async function signInWithPassword\(email: string, password: string\)/.test(authFlow) &&
      /signInWithPassword\(\{\s*email,\s*password\s*\}\)/.test(authFlow),
    '/login: signInWithPassword({ email, password })',
  );
  assert(
    /export async function startSignupWithPassword/.test(authFlow) &&
      /auth\.signUp\(\{\s*\n\s*email,\s*\n\s*password,/.test(authFlow),
    '/signup: signUp({ email, password, ... }) — password set at creation time',
  );
  assert(/resendCode[\s\S]*?shouldCreateUser:\s*false/.test(authFlow), 'resend (signup verification only) never creates (shouldCreateUser: false)');
  assert(/data:\s*\{\s*full_name/.test(authFlow), 'signup passes options.data.full_name (014 trigger still fed identically)');
  assert(/verifyOtp\(\{\s*email,\s*token,\s*type:\s*'email'\s*\}\)/.test(authFlow), "verifyEmailOtp (signup verification) uses verifyOtp({ email, token, type: 'email' }) — unchanged");
  assert(
    /export async function requestPasswordReset/.test(authFlow) && /resetPasswordForEmail/.test(authFlow),
    'requestPasswordReset() calls resetPasswordForEmail() — the path for every pre-existing passwordless account',
  );
  assert(
    /export async function setNewPassword/.test(authFlow) && /updateUser\(\{\s*password\s*\}\)/.test(authFlow),
    'setNewPassword() calls updateUser({ password })',
  );

  const signupPage = fs.readFileSync(path.resolve(__dirname, '../src/app/signup/page.tsx'), 'utf8');
  const loginPage = fs.readFileSync(path.resolve(__dirname, '../src/app/login/page.tsx'), 'utf8');
  assert(/<VerifyCode/.test(signupPage), '/signup still renders <VerifyCode> (email verification unchanged)');
  assert(!/<VerifyCode/.test(loginPage), '/login no longer renders <VerifyCode> — no OTP screen in the login path at all');
  assert(/type="password"/.test(signupPage) && /type="password"/.test(loginPage), '/signup and /login both render a password field');
  assert(/signInWithPassword/.test(loginPage) && !/requestSignInCode|signInWithOtp/.test(loginPage), '/login calls signInWithPassword only — no OTP call anywhere in the page');
  assert(/Forgot password/.test(loginPage), '/login links to the forgot-password flow — the path for pre-existing passwordless accounts');

  const forgotPage = fs.readFileSync(path.resolve(__dirname, '../src/app/forgot-password/page.tsx'), 'utf8');
  const resetPage = fs.readFileSync(path.resolve(__dirname, '../src/app/reset-password/page.tsx'), 'utf8');
  assert(/requestPasswordReset/.test(forgotPage), '/forgot-password calls requestPasswordReset()');
  assert(/setNewPassword/.test(resetPage) && /type="password"/.test(resetPage), '/reset-password renders a password field and calls setNewPassword()');

  const verifyCode = fs.readFileSync(path.resolve(__dirname, '../src/components/auth/VerifyCode.tsx'), 'utf8');
  assert(
    /window\.location\.replace\('\/feed'\)/.test(verifyCode) && !/router\.push\(/.test(verifyCode),
    'VerifyCode (signup) navigates to /feed via a full-document load on success (no router.push race — A)',
  );
  assert(
    /window\.location\.replace\(sanitizeRedirectPath/.test(loginPage) && !/router\.push\(/.test(loginPage),
    'login navigates via a full-document load on success, honoring the sanitized ?redirect= target (A)',
  );

  // A/B — post-mutation navigation is a hard load, not a client push, so
  // middleware always sees the fresh cookie / onboarding state on a top-level
  // request and cannot transiently bounce a just-authenticated user to /login.
  const onboardingPage = fs.readFileSync(path.resolve(__dirname, '../src/app/onboarding/page.tsx'), 'utf8');
  assert(
    /window\.location\.replace\('\/feed'\)/.test(onboardingPage) && !/router\.push\(/.test(onboardingPage),
    'onboarding page navigates to /feed via a full-document load after a successful complete_onboarding (B)',
  );

  // C — an accessible Sign out control wired to signOutCurrentSession, with a
  // hard load to /login so no client state keeps rendering as signed-in.
  const settingsPage = fs.readFileSync(path.resolve(__dirname, '../src/app/settings/page.tsx'), 'utf8');
  assert(/signOutCurrentSession\(\)/.test(settingsPage), 'settings calls signOutCurrentSession()');
  assert(
    /const accountCard =/.test(settingsPage) &&
      (settingsPage.match(/\{accountCard\}/g) || []).length >= 2,
    'settings renders the Sign out card on both the default Profile tab and the Settings tab (C)',
  );
  assert(
    /handleSignOut[\s\S]*?window\.location\.replace\('\/login'\)/.test(settingsPage) && !/router\.push\(/.test(settingsPage),
    'sign out does a full-document load to /login (C)',
  );

  // D — friendly copy branches on the Supabase error CODE (stable).
  assert(
    /over_email_send_rate_limit/.test(authFlow),
    'auth-flow maps the cooldown code (over_email_send_rate_limit) to its own message (D)',
  );
  assert(
    /otp_expired/.test(authFlow) && /wrong or expired/.test(authFlow),
    'auth-flow: signup-code wrong vs expired collapse to one honest message (Supabase returns otp_expired for both) (D)',
  );
  assert(
    /invalid_credentials/.test(authFlow) && /Incorrect email or password/.test(authFlow),
    'auth-flow: wrong password vs unknown email collapse to one honest message, naming the recovery action (D)',
  );
  assert(
    /\/\^\\d\{4,12\}\$\//.test(authFlow),
    'verifyEmailOtp (signup) rejects a malformed (non-digit) entry client-side before calling Supabase (D)',
  );

  // E1 — onboarding is the authoritative DB write, so it must not ship
  // fabricated field defaults that get persisted for a user who never chose
  // them. Every required field starts empty/unset; workPreference:'worldwide'
  // is the one intentional product default.
  assert(
    !/Alex Chen/.test(onboardingPage) && !/TechFlow Cloud/.test(onboardingPage) && !/PixelCraft Studio/.test(onboardingPage),
    'onboarding page carries no sample-resume / demo-identity default text (E1)',
  );
  assert(
    /useState<EmploymentType\[\]>\(\[\]\)/.test(onboardingPage) &&
      /useState<string\[\]>\(\[\]\)/.test(onboardingPage) &&
      /const \[resumeText, setResumeText\] = useState\(''\)/.test(onboardingPage) &&
      /const \[headline, setHeadline\] = useState\(''\)/.test(onboardingPage) &&
      /const \[currentCountry, setCurrentCountry\] = useState\(''\)/.test(onboardingPage) &&
      /const \[currentTimezone, setCurrentTimezone\] = useState\(''\)/.test(onboardingPage),
    'onboarding required fields (employmentTypes/targetRoles/skills/resume/headline/country/timezone) start empty (E1)',
  );
  assert(
    /useState<YearsOfExperience \| ''>\(''\)/.test(onboardingPage),
    "onboarding yearsOfExperience state is representable as unset ('') (E1)",
  );
  assert(
    /willingTimezones, setWillingTimezones\] = useState<string\[\]>\(\[\]\)/.test(onboardingPage) &&
      !/\['UTC', 'EST', 'PST'\]/.test(onboardingPage),
    'onboarding overlap-band state starts empty — no phantom EST/PST that no button can clear (E1)',
  );
  assert(
    /const canContinue =/.test(onboardingPage) && /disabled=\{!canContinue\}/.test(onboardingPage),
    'onboarding gates each stage Continue on the required field being filled (E1)',
  );

  const confirmRoute = fs.readFileSync(path.resolve(__dirname, '../src/app/auth/confirm/route.ts'), 'utf8');
  assert(/verifyOtp\(\{\s*token_hash/.test(confirmRoute) && /exchangeCodeForSession\(code\)/.test(confirmRoute),
    '/auth/confirm KEPT as a fallback — still handles token_hash + code');
  assert(!/verifyOtp\([^)]*email/.test(confirmRoute), '/auth/confirm never passes an email to verifyOtp');
  assert(
    /type === 'recovery'[\s\S]*?\/reset-password/.test(confirmRoute),
    "/auth/confirm routes a type='recovery' link to /reset-password instead of /feed or /onboarding",
  );

  // anonymous session rejected regardless of infra
  const anon = { is_anonymous: true, email_confirmed_at: new Date().toISOString() } as unknown as User;
  assert(isAccountVerified(anon) === false, 'ROUTING MATRIX: anonymous session -> rejected (isAccountVerified false)');

  if (!hasRequiredEnv() || !process.env.TEST_BASE_URL) {
    console.log('\nTEST_BASE_URL / Supabase env not all set — skipping the live portion.');
    console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped.`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  const admin = adminClient();
  const emails: string[] = [];
  const cleanup = async () => {
    for (const e of emails) {
      const { data } = await admin.auth.admin.listUsers();
      const u = data?.users?.find((x) => x.email === e);
      if (u) await admin.auth.admin.deleteUser(u.id).catch(() => {});
    }
  };

  try {
    // --- 1. /api/onboarding auth boundary ---
    console.log('\n1. /api/onboarding AUTH BOUNDARY');
    assert((await fetch(`${BASE_URL}/api/onboarding`, { redirect: 'manual' })).status === 401, 'GET /api/onboarding unauthenticated -> 401');
    assert(
      (await fetch(`${BASE_URL}/api/onboarding`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(COMPLETE), redirect: 'manual' })).status === 401,
      'POST /api/onboarding unauthenticated -> 401',
    );

    // --- 2. EMAIL + PASSWORD LOGIN (signup still code-verified) ---
    console.log('\n2. SIGNUP (password + code verification) then LOGIN (password only)');
    const emailA = uniqueEmail(); emails.push(emailA);

    const okCode = await signUpAndVerify(emailA, TEST_PASSWORD, 'AFC Test User');
    assert(Boolean(okCode.data.session) && !okCode.error, 'signUp(password) + code verification -> session established');
    const tokenA = okCode.data.session!.access_token;

    const wrongPassword = await anonKeyClient().auth.signInWithPassword({ email: emailA, password: 'definitely-the-wrong-password' });
    assert(!wrongPassword.data.session && Boolean(wrongPassword.error), 'signInWithPassword with the WRONG password -> rejected, no session');

    const rightPassword = await anonKeyClient().auth.signInWithPassword({ email: emailA, password: TEST_PASSWORD });
    assert(Boolean(rightPassword.data.session) && !rightPassword.error, 'signInWithPassword with the CORRECT password -> session established — no code involved anywhere in this call');

    // login surface never touches signInWithOtp at all any more
    const neverSeen = `remotematch-test-nolist-${Date.now()}@example.com`;
    const loginUnknown = await anonKeyClient().auth.signInWithPassword({ email: neverSeen, password: 'whatever-password-123' });
    assert(Boolean(loginUnknown.error), 'signInWithPassword for a never-used email -> error, no account, no OTP fallback');

    // --- 3. ROUTING MATRIX ---
    console.log('\n3. POST-AUTH ROUTING MATRIX');
    for (const p of ['/feed', '/onboarding', '/tracker', '/settings', '/match/opp-curated-curated-001']) {
      assert(isRedirectTo(await fetch(`${BASE_URL}${p}`, { redirect: 'manual' }), '/login'), `no session: GET ${p} -> /login`);
    }
    // API routes read the Bearer header (getAuthenticatedUser); PAGE routes are
    // gated by middleware which reads the @supabase/ssr auth COOKIE — so page
    // assertions must present the session as a cookie, not a header.
    const HA = { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' };
    const CA = { Cookie: sessionCookieHeader(okCode.data.session!) };
    const getA0 = await (await fetch(`${BASE_URL}/api/onboarding`, { headers: HA })).json();
    assert(getA0.onboardingCompletedAt === null, 'new verified user: onboardingCompletedAt null');
    assert(
      getA0.currentTimezone === '' && getA0.headline === '' && getA0.rawResumeText === '' &&
        Array.isArray(getA0.employmentTypes) && getA0.employmentTypes.length === 0 &&
        getA0.yearsOfExperience === null && getA0.willingTimezones.length === 0,
      'new verified user: GET /api/onboarding prefill has no fabricated field values (E1)',
    );
    assert(isRedirectTo(await fetch(`${BASE_URL}/feed`, { headers: CA, redirect: 'manual' }), '/onboarding'),
      'new verified user: GET /feed -> /onboarding (middleware, cookie session)');

    // incomplete submit
    console.log('\n4. INCOMPLETE ONBOARDING');
    assert(
      (await fetch(`${BASE_URL}/api/onboarding`, { method: 'POST', headers: HA, body: JSON.stringify({ ...COMPLETE, targetRoles: [] }), redirect: 'manual' })).status === 400,
      'POST incomplete -> 400',
    );
    assert((await (await fetch(`${BASE_URL}/api/onboarding`, { headers: HA })).json()).onboardingCompletedAt === null, '  ...still not onboarded');

    // onboarding_completed_at not client-writable
    console.log('\n5. onboarding_completed_at NOT CLIENT-WRITABLE');
    const client = anonKeyClient();
    await client.auth.setSession(okCode.data.session!);
    await client.from('profiles').update({ onboarding_completed_at: new Date().toISOString() }).eq('id', okCode.data.user!.id);
    assert(
      (await (await fetch(`${BASE_URL}/api/onboarding`, { headers: HA })).json()).onboardingCompletedAt === null,
      'direct client UPDATE of onboarding_completed_at has no effect',
    );

    // complete -> feed
    console.log('\n6. COMPLETE ONBOARDING -> /feed');
    const okBody = await (await fetch(`${BASE_URL}/api/onboarding`, { method: 'POST', headers: HA, body: JSON.stringify(COMPLETE), redirect: 'manual' })).json();
    assert(okBody.ok === true && typeof okBody.onboardingCompletedAt === 'string', 'POST complete -> { ok: true } + timestamp');
    const getA1 = await (await fetch(`${BASE_URL}/api/onboarding`, { headers: HA })).json();
    assert(getA1.onboardingCompletedAt !== null && getA1.skills.length === 2 && getA1.workPreference === 'worldwide',
      '  ...intent / skills / location / name persisted');
    assert((await fetch(`${BASE_URL}/feed`, { headers: CA, redirect: 'manual' })).status === 200, 'completed verified user: GET /feed -> 200 (middleware, cookie session)');
    assert(isRedirectTo(await fetch(`${BASE_URL}/onboarding`, { headers: CA, redirect: 'manual' }), '/feed'),
      'completed verified user: GET /onboarding -> /feed (middleware, cookie session)');

    // --- 6b. E1 GATE: a required-fields-only submit persists NO fabricated
    //         residue for the fields the user left untouched. ---
    console.log('\n6b. E1 — no fabricated onboarding residue');
    const emailC = uniqueEmail(); emails.push(emailC);
    const okC = await signUpAndVerify(emailC, TEST_PASSWORD, 'Minimal User');
    const HC = { Authorization: `Bearer ${okC.data.session!.access_token}`, 'Content-Type': 'application/json' };
    const MINIMAL = {
      fullName: 'Minimal User',
      employmentTypes: ['Contract'],
      targetRoles: ['Data Engineer'],
      yearsOfExperience: '2-3',
      skills: [{ name: 'Rust', isPrimary: true }],
      workPreference: 'worldwide',
      currentCountry: 'Estonia',
      currentTimezone: 'EET',
      // deliberately omitted: headline, rawResumeText, minSalary,
      // willingTimezones, allowedCountries
    };
    const okC1 = await (await fetch(`${BASE_URL}/api/onboarding`, { method: 'POST', headers: HC, body: JSON.stringify(MINIMAL), redirect: 'manual' })).json();
    assert(okC1.ok === true, 'minimal required-only submit -> { ok: true }');
    const getC = await (await fetch(`${BASE_URL}/api/onboarding`, { headers: HC })).json();
    assert(getC.headline === null || getC.headline === '', '  ...headline persisted as null/empty (not fabricated)');
    assert(getC.rawResumeText === null || getC.rawResumeText === '', '  ...resume persisted as null/empty (not the sample resume)');
    assert(Array.isArray(getC.willingTimezones) && getC.willingTimezones.length === 0, '  ...willing_timezones empty (no phantom EST/PST)');
    assert(
      getC.targetRoles.length === 1 && getC.targetRoles[0] === 'Data Engineer' &&
        getC.skills.length === 1 && getC.skills[0].name === 'Rust',
      '  ...only the explicitly chosen role/skill persisted',
    );
    assert(getC.minSalary === null, '  ...min_salary null');

    // --- 7. /auth/confirm fallback intact ---
    console.log('\n7. /auth/confirm FALLBACK (unchanged) + recovery routing');
    assert(isRedirectTo(await fetch(`${BASE_URL}/auth/confirm`, { redirect: 'manual' }), '/login?verified=error'),
      'no material -> /login?verified=error');
    assert(isRedirectTo(await fetch(`${BASE_URL}/auth/confirm?token_hash=nope&type=magiclink`, { redirect: 'manual' }), '/login?verified=error'),
      'bad token_hash -> /login?verified=error');
    assert(isRedirectTo(await fetch(`${BASE_URL}/auth/confirm?code=nope`, { redirect: 'manual' }), '/login?verified=error'),
      'bad code -> /login?verified=error');

    // --- 8. cross-user isolation (RPC scoped to auth.uid) ---
    console.log('\n8. CROSS-USER ISOLATION');
    const emailB = uniqueEmail(); emails.push(emailB);
    const okB = await signUpAndVerify(emailB, TEST_PASSWORD, 'User B');
    const HB = { Authorization: `Bearer ${okB.data.session!.access_token}`, 'Content-Type': 'application/json' };
    await fetch(`${BASE_URL}/api/onboarding`, { method: 'POST', headers: HB, body: JSON.stringify({ ...COMPLETE, fullName: 'User B' }), redirect: 'manual' });
    const aStill = await (await fetch(`${BASE_URL}/api/onboarding`, { headers: HA })).json();
    const bNow = await (await fetch(`${BASE_URL}/api/onboarding`, { headers: HB })).json();
    assert(aStill.fullName === 'AFC Test User', "B's submission did not change A's profile");
    assert(bNow.fullName === 'User B', "  ...B's own profile was written (RPC scoped to auth.uid())");
  } finally {
    await cleanup();
  }

  console.log('\n' + '='.repeat(78));
  console.log(`${passed} passed, ${failed} failed, ${skipped} skipped.`);
  console.log('='.repeat(78));
  if (failed > 0) process.exitCode = 1;
}

run().catch((e) => { console.error('Fatal:', e); process.exit(1); });
