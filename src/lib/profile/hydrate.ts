'use client';

import { localStore } from '@/lib/db/mock-seed';
import type { EmploymentType, PersonProfile, ProfileIntent, ProfileLocation } from '@/types/byn';

/** The exact shape of `GET /api/onboarding` (see src/app/api/onboarding/route.ts).
 *  Exported so /settings (F — data-source alignment) reads the same contract. */
export interface ServerOnboarding {
  onboardingCompletedAt: string | null;
  fullName: string;
  headline: string;
  rawResumeText: string;
  employmentTypes: string[];
  targetRoles: string[];
  yearsOfExperience: string | null;
  minSalary: number | null;
  preferredCurrency: string;
  workPreference: string | null;
  currentCountry: string;
  currentTimezone: string;
  allowedCountries: string[];
  willingTimezones: string[];
  skills: Array<{ name: string; isPrimary: boolean }>;
}

/**
 * Decision 7a — onboarding is DB-authoritative, but feed/match/settings still
 * read the client-local profile fixture (`localStore`). This refills that
 * fixture from the authoritative server profile so a fresh device / cleared
 * localStorage shows the real profile instead of the demo persona.
 *
 * Only profile CONTENT is touched — never the entitlement fields
 * (planTier / quota), which `localStore` merges from /api/profile elsewhere.
 * Full read-path migration off `localStore` is a separate, later gate.
 */
export async function hydrateLocalProfileFromServer(): Promise<void> {
  let d: ServerOnboarding;
  try {
    const res = await fetch('/api/onboarding', { cache: 'no-store' });
    if (!res.ok) return; // unauthenticated / not configured — leave the fixture as-is
    d = (await res.json()) as ServerOnboarding;
  } catch {
    return; // best-effort — a hydration failure must never block rendering
  }

  // Nothing persisted yet (un-onboarded user) — don't clobber the fixture with
  // empties; the onboarding flow will fill it.
  if (!d.onboardingCompletedAt && d.skills.length === 0 && d.targetRoles.length === 0) {
    return;
  }

  const current = localStore.getProfile();

  const yoe: ProfileIntent['yearsOfExperience'] =
    d.yearsOfExperience === '0-1' || d.yearsOfExperience === '2-3' || d.yearsOfExperience === '4-6' ||
    d.yearsOfExperience === '7-10' || d.yearsOfExperience === '10+'
      ? d.yearsOfExperience
      : current.intent?.yearsOfExperience ?? '2-3';

  const workPref: ProfileLocation['workPreference'] =
    d.workPreference === 'worldwide' || d.workPreference === 'my_country' || d.workPreference === 'selected_countries'
      ? d.workPreference
      : current.location?.workPreference ?? 'worldwide';

  const patch: Partial<PersonProfile> = {
    fullName: d.fullName || current.fullName,
    headline: d.headline || current.headline,
    rawResumeText: d.rawResumeText || current.rawResumeText,
    intent: {
      id: current.intent?.id ?? 'intent-server',
      profileId: current.id,
      employmentTypes: d.employmentTypes as EmploymentType[],
      targetRoles: d.targetRoles,
      yearsOfExperience: yoe,
      minSalary: d.minSalary ?? undefined,
      preferredCurrency: d.preferredCurrency || 'USD',
      availabilityStatus: current.intent?.availabilityStatus ?? 'immediately',
      updatedAt: new Date().toISOString(),
    },
    skills: d.skills.map((s, i) => ({
      id: `s-server-${i}`,
      profileId: current.id,
      skillName: s.name,
      isPrimary: s.isPrimary,
    })),
    location: {
      id: current.location?.id ?? 'loc-server',
      profileId: current.id,
      currentCountry: d.currentCountry || current.location?.currentCountry || 'Worldwide',
      currentTimezone: d.currentTimezone || current.location?.currentTimezone || 'UTC',
      workPreference: workPref,
      allowedCountries: d.allowedCountries,
      willingTimezones: d.willingTimezones,
    },
  };

  localStore.updateProfile(patch);
}
