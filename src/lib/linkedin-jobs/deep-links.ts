import type { LinkedInJobSearchFilters } from '@/types/linkedin-jobs';

/**
 * LinkedIn Job Finder — outbound deep-link builders (plan §22 step [5],
 * §26 Mode C, §28). Every function here builds an ordinary hyperlink to a
 * real linkedin.com page — no API call, no data returned to RemoteMatch,
 * no compliance dependency (plan §23 #6). These are the ONLY functions in
 * this feature that construct a linkedin.com URL for anything other than
 * "open the exact listing the user found."
 */

const LI_DATE_POSTED_PARAM: Record<Exclude<LinkedInJobSearchFilters['datePosted'], undefined>, string | null> = {
  any: null,
  past24h: 'r86400',
  pastWeek: 'r604800',
  pastMonth: 'r2592000',
};

/** Builds a pre-filled linkedin.com/jobs/search URL from the same filters
 *  the automated search form collects — for the "Search on LinkedIn
 *  directly" mode (plan §26 Mode C), opened in a new tab. */
export function buildLinkedInJobSearchUrl(filters: LinkedInJobSearchFilters): string {
  const url = new URL('https://www.linkedin.com/jobs/search');
  if (filters.keywords) url.searchParams.set('keywords', filters.keywords);
  if (filters.location) url.searchParams.set('location', filters.location);
  if (filters.remoteOnly) url.searchParams.set('f_WT', '2'); // LinkedIn's own remote-filter facet value
  const datePosted = filters.datePosted && LI_DATE_POSTED_PARAM[filters.datePosted];
  if (datePosted) url.searchParams.set('f_TPR', datePosted);
  return url.toString();
}

/** Builds a linkedin.com people-search URL scoped to a company (+ optional
 *  role keyword) — plan §28. Never returns data to RemoteMatch; the user
 *  browses and picks a person entirely on LinkedIn's own site. */
export function buildLinkedInPeopleSearchUrl(company: string, roleKeyword?: string): string {
  const url = new URL('https://www.linkedin.com/search/results/people/');
  const keywords = roleKeyword ? `${company} ${roleKeyword}` : company;
  url.searchParams.set('keywords', keywords);
  return url.toString();
}

/** Small, static suggestion list — derived from the job title/department
 *  the user is looking at, NOT from any LinkedIn data (plan §28 point 2). */
export function suggestPeopleSearchRoleKeywords(jobTitle: string): string[] {
  const lower = jobTitle.toLowerCase();
  const suggestions = ['Recruiter', 'Hiring Manager', 'Talent Acquisition'];
  const teamWord = lower.match(/\b(engineering|design|product|sales|marketing|data|people|finance|operations)\b/);
  if (teamWord) {
    const team = teamWord[1];
    suggestions.push(`${team.charAt(0).toUpperCase()}${team.slice(1)} Manager`);
  }
  return suggestions;
}
