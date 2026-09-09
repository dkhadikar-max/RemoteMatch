/**
 * RemoteMatch — Auth Flow Change HTTP suite (AFC — email OTP code amendment)
 * ==============================================================================
 * Primary AFC auth entry = an emailed one-time CODE the user types in:
 *   signInWithOtp({ email, options:{ shouldCreateUser:true, data:{full_name} } })
 *   -> VerifyCode screen -> verifyOtp({ email, token: code, type: 'email' })
 *   -> session -> router.push('/feed') -> middleware onboarding gate
 *
 * §0 source checks run always. The live section (TEST_BASE_URL + Supabase env)
 * proves the routing matrix and the OTP verify/reject/resend behavior using
 * admin.generateLink() to obtain the code (no live inbox needed).
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

/** Obtain a real OTP code for `email` (creating the user if needed) via the
 *  admin API — this is exactly what Supabase would email as {{ .Token }}. */
async function issueOtp(email: string): Promise<string> {
  const admin = adminClient();
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error || !data?.properties?.email_otp) {
    throw new Error(`generateLink failed: ${error?.message ?? 'no email_otp'}`);
  }
  return data.properties.email_otp;
}

async function run() {
  console.log('='.repeat(78));
  console.log('AUTH FLOW CHANGE — HTTP SUITE (AFC — OTP CODE)');
  console.log('='.repeat(78));

  // --- §0 source checks (always) ---
  console.log('\n0. SOURCE — passwordless OTP-code entry');
  const authFlow = fs.readFileSync(path.resolve(__dirname, '../src/lib/auth/auth-flow.ts'), 'utf8');
  assert(
    !/export\s+(async\s+)?function\s+(signUpWithPassword|signInWithPassword)/.test(authFlow)
      && !/signInWithPassword\s*\(/.test(authFlow),
    'auth-flow.ts defines/calls no password functions',
  );
  assert(!/emailRedirectTo/.test(authFlow.replace(/\*.*emailRedirectTo.*/g, '')), 'auth-flow.ts passes no emailRedirectTo (OTP code, not link)');
  assert(/startPasswordlessSignup[\s\S]*?shouldCreateUser:\s*true/.test(authFlow), '/signup: signInWithOtp({ shouldCreateUser: true }) — may create');
  assert(/requestSignInCode[\s\S]*?shouldCreateUser:\s*false/.test(authFlow), '/login: signInWithOtp({ shouldCreateUser: false }) — existing account only');
  assert(/resendCode[\s\S]*?shouldCreateUser:\s*false/.test(authFlow), 'resend never creates (shouldCreateUser: false)');
  assert(/data:\s*\{\s*full_name/.test(authFlow), 'signup passes options.data.full_name');
  assert(/verifyOtp\(\{\s*email,\s*token,\s*type:\s*'email'\s*\}\)/.test(authFlow), "verifyEmailOtp uses verifyOtp({ email, token, type: 'email' })");
  assert(/export async function verifyEmailOtp\(email: string, code: string\)/.test(authFlow), 'the email is a function parameter from the sign-in form — not a URL/token identity');

  const signupPage = fs.readFileSync(path.resolve(__dirname, '../src/app/signup/page.tsx'), 'utf8');
  const loginPage = fs.readFileSync(path.resolve(__dirname, '../src/app/login/page.tsx'), 'utf8');
  assert(/VerifyCode/.test(signupPage) && /VerifyCode/.test(loginPage), '/signup and /login render <VerifyCode>');
  assert(!/type="password"/.test(signupPage) && !/type="password"/.test(loginPage), 'no password field on /signup or /login');

  const verifyCode = fs.readFileSync(path.resolve(__dirname, '../src/components/auth/VerifyCode.tsx'), 'utf8');
  assert(
    /window\.location\.replace\('\/feed'\)/.test(verifyCode) && !/router\.push\(/.test(verifyCode),
    'VerifyCode navigates to /feed via a full-document load on success (no router.push race — A)',
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

  // D — friendly copy branches on the Supabase error CODE (stable), and the
  // resend-cooldown case is distinct from the wrong/expired-code case.
  assert(
    /over_email_send_rate_limit/.test(authFlow),
    'auth-flow maps the cooldown code (over_email_send_rate_limit) to its own message (D)',
  );
  assert(
    /otp_expired/.test(authFlow) && /wrong or expired/.test(authFlow),
    'auth-flow: wrong vs expired collapse to one honest message (Supabase returns otp_expired for both) (D)',
  );
  assert(
    /\/\^\\d\{4,12\}\$\//.test(authFlow),
    'verifyEmailOtp rejects a malformed (non-digit) entry client-side before calling Supabase (D)',
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

    // --- 2. OTP verify / reject / resume ---
    console.log('\n2. EMAIL OTP CODE — verify / reject');
    const emailA = uniqueEmail(); emails.push(emailA);
    const client = anonKeyClient();

    const badCode = await client.auth.verifyOtp({ email: emailA, token: '00000000', type: 'email' });
    assert(!badCode.data.session && Boolean(badCode.error), 'invalid code -> rejected, no session');

    const otp1 = await issueOtp(emailA); // creates the user + returns the code
    const okCode = await client.auth.verifyOtp({ email: emailA, token: otp1, type: 'email' });
    assert(Boolean(okCode.data.session) && !okCode.error, 'correct code -> session established');
    const tokenA = okCode.data.session!.access_token;

    const reuse = await anonKeyClient().auth.verifyOtp({ email: emailA, token: otp1, type: 'email' });
    assert(!reuse.data.session && Boolean(reuse.error), 'consumed/expired code -> rejected (same path as expiry)');

    // resend (shouldCreateUser:false, user already exists) -> fresh code
    const resendReq = await anonKeyClient().auth.signInWithOtp({ email: emailA, options: { shouldCreateUser: false } });
    assert(!resendReq.error, 'resend (signInWithOtp, shouldCreateUser:false) -> no error for an existing user');
    const otp2 = await issueOtp(emailA);
    assert(otp2 !== otp1, '  ...a fresh code is issued');

    // login surface never creates an account
    const neverSeen = `remotematch-test-nolist-${Date.now()}@example.com`;
    const loginNew = await anonKeyClient().auth.signInWithOtp({ email: neverSeen, options: { shouldCreateUser: false } });
    assert(Boolean(loginNew.error), 'login (shouldCreateUser:false) for a never-used email -> error, no account');
    const { data: after } = await admin.auth.admin.listUsers();
    assert(!after?.users?.some((u) => u.email === neverSeen), '  ...no auth.users row was created');

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
    const otpC = await issueOtp(emailC);
    const okC = await anonKeyClient().auth.verifyOtp({ email: emailC, token: otpC, type: 'email' });
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
    console.log('\n7. /auth/confirm FALLBACK (unchanged)');
    assert(isRedirectTo(await fetch(`${BASE_URL}/auth/confirm`, { redirect: 'manual' }), '/login?verified=error'),
      'no material -> /login?verified=error');
    assert(isRedirectTo(await fetch(`${BASE_URL}/auth/confirm?token_hash=nope&type=magiclink`, { redirect: 'manual' }), '/login?verified=error'),
      'bad token_hash -> /login?verified=error');
    assert(isRedirectTo(await fetch(`${BASE_URL}/auth/confirm?code=nope`, { redirect: 'manual' }), '/login?verified=error'),
      'bad code -> /login?verified=error');

    // --- 8. cross-user isolation (RPC scoped to auth.uid) ---
    console.log('\n8. CROSS-USER ISOLATION');
    const emailB = uniqueEmail(); emails.push(emailB);
    const otpB = await issueOtp(emailB);
    const okB = await anonKeyClient().auth.verifyOtp({ email: emailB, token: otpB, type: 'email' });
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
