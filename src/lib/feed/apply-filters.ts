import type { CanonicalOpportunity, OpportunityFilters } from '@/types/byn';

/**
 * Client-side feed filtering. This runs AFTER `scoreOpportunitiesForFeed` and
 * is strictly REMOVAL-ONLY — it never reorders the deck, never touches
 * `fitScore`, and never changes eligibility. Extracted from `feed/page.tsx`
 * unchanged so it can be unit-tested in isolation (see
 * `test/career-transition-suite.ts`).
 *
 * `careerTransition` (Career Transition V1.1, Pro) is the only filter whose
 * data source is server-gated: `opp.careerTransition` is present only when the
 * feed API established a verified Pro + `change_fields` caller, so a Free client
 * that forces `careerTransition: true` into filter state just gets an empty
 * deck, never a transition deck.
 */
export function applyFilters(
  opps: CanonicalOpportunity[],
  filters: OpportunityFilters,
): CanonicalOpportunity[] {
  return opps.filter((opp) => {
    // Career Transition (Pro) — removal-only.
    if (filters.careerTransition && !opp.careerTransition) return false;

    if (filters.targetRole) {
      const target = filters.targetRole.toLowerCase();
      const title = opp.title.toLowerCase();
      if (!title.includes(target)) {
        if (target.includes('frontend') && !title.includes('frontend')) return false;
        if (target.includes('full stack') && !title.includes('full stack') && !title.includes('fullstack')) return false;
        if (target.includes('backend') && !title.includes('backend')) return false;
        if (target.includes('devops') && !title.includes('devops') && !title.includes('infrastructure') && !title.includes('cloud')) return false;
        if (target.includes('staff') && !title.includes('staff') && !title.includes('principal')) return false;
      }
    }

    if (filters.remoteType) {
      if (filters.remoteType === 'Worldwide' && opp.remoteType !== 'Worldwide') return false;
      if (filters.remoteType === 'US' && !opp.remoteType.includes('US') && opp.remoteType !== 'Worldwide') return false;
      if (filters.remoteType === 'EU/EEA' && !opp.remoteType.includes('EU') && !opp.remoteType.includes('EEA') && opp.remoteType !== 'Worldwide') return false;
    }

    // Seniority (Free)
    if (filters.seniority) {
      const title = opp.title.toLowerCase();
      const exp = opp.experienceRequirement || '';
      if (filters.seniority.includes('Entry') && !title.includes('junior') && !title.includes('jr') && !title.includes('associate') && exp !== '0-1') return false;
      if (filters.seniority.includes('Senior') && !title.includes('senior') && !title.includes('sr') && !title.includes('lead') && !title.includes('staff') && exp !== '7-10' && exp !== '10+') return false;
      if (filters.seniority.includes('Staff') && !title.includes('staff') && !title.includes('lead') && !title.includes('principal')) return false;
      if (filters.seniority.includes('Principal') && !title.includes('principal') && !title.includes('distinguished')) return false;
    }

    // Specific Location (Pro Precision Targeting)
    if (filters.specificLocation) {
      const loc = filters.specificLocation.toLowerCase();
      const oppLoc = `${opp.remoteType} ${opp.eligibleCountries.join(' ')} ${opp.description}`.toLowerCase();
      if (loc.includes('us only') || loc.includes('united states')) {
        if (opp.remoteType !== 'US' && !opp.eligibleCountries.includes('US') && !opp.eligibleCountries.includes('USA')) return false;
      } else if (loc.includes('united kingdom') || loc.includes('uk')) {
        if (!oppLoc.includes('uk') && !oppLoc.includes('united kingdom') && opp.remoteType !== 'Worldwide') return false;
      } else if (loc.includes('germany')) {
        if (!oppLoc.includes('germany') && opp.remoteType !== 'Worldwide') return false;
      } else if (loc.includes('canada')) {
        if (!oppLoc.includes('canada') && opp.remoteType !== 'Worldwide') return false;
      } else if (loc.includes('eu/eea') || loc.includes('european union')) {
        if (opp.remoteType !== 'EU/EEA' && !oppLoc.includes('europe') && opp.remoteType !== 'Worldwide') return false;
      }
    }

    // Minimum Salary (Pro)
    if (filters.minSalary && filters.minSalary > 0) {
      const maxSal = opp.salaryMax || opp.salaryMin || 0;
      if (maxSal < filters.minSalary) return false;
    }

    // Strict Timezone (Pro)
    if (filters.strictTimezone) {
      if (filters.strictTimezone.includes('UTC') && !opp.remoteType.toLowerCase().includes('utc') && opp.remoteType !== 'Worldwide') return false;
      if (filters.strictTimezone.includes('Americas') && !opp.remoteType.toLowerCase().includes('us') && opp.remoteType !== 'Worldwide') return false;
      if (filters.strictTimezone.includes('APAC') && !opp.remoteType.toLowerCase().includes('apac') && opp.remoteType !== 'Worldwide') return false;
    }

    return true;
  });
}
