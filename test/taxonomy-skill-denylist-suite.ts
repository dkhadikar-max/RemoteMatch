/**
 * Spec 1 (taxonomy fixes) — ambiguous title/skill-tag denylist.
 * ==============================================================================
 * Proves:
 *   - UNIT: isAmbiguousTitleTag / filterAmbiguousTitleTags behave correctly on
 *     real tag strings seen in production during the 2026-10-30 audit, plus
 *     obvious non-members (genuine skills) that must NOT be filtered.
 *   - REGRESSION (confirmed bad pair, now fixed): the exact two jobs from the
 *     relevance audit ("Strategic Account Executive, UK" / "Enterprise
 *     Account Executive, DACH") no longer register a skill match against a
 *     profile whose only skill is "Account-Executive".
 *   - REGRESSION (confirmed good pair, must NOT break): a profile whose only
 *     skill is "Python" still matches a job tagged "Senior-Python-Engineer" —
 *     the denylist is deliberately narrow and must not catch this.
 *   - Zero change to skillMatches() itself, the scoring formula, or its
 *     weights — only which tags ever reach it.
 *
 * Run: npx tsx test/taxonomy-skill-denylist-suite.ts
 */
import { isAmbiguousTitleTag, filterAmbiguousTitleTags } from '../src/lib/matching/ambiguous-title-tags';
import { computeScreeningFit, generateRuleBasedMatchAnalysis } from '../src/lib/matching/engine';
import type { PersonProfile, CanonicalOpportunity } from '../src/types/byn';

let passed = 0, failed = 0;
function assert(cond: boolean, name: string, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ PASS: ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('UNIT: isAmbiguousTitleTag / filterAmbiguousTitleTags');
{
  // Real tags from the 2026-10-30 relevance audit, confirmed ambiguous —
  // including the exact modifier-stacked variants (Senior-Strategic-...,
  // Strategic-Enterprise-...) actually seen on the real job postings that
  // an earlier, exact-string version of this list missed.
  for (const t of [
    'Account-Executive', 'Strategic-Account-Executive', 'Enterprise-Account-Executive', 'Account-Manager',
    'Senior-Account-Executive', 'Channel-Account-Manager',
    'Senior-Strategic-Account-Executive', 'Strategic-Accounts-Executive', 'Strategic-Enterprise-Account-Executive',
    'Account-Director',
  ]) {
    assert(isAmbiguousTitleTag(t), `"${t}" is on the denylist`);
  }
  // Case/hyphen-insensitive.
  assert(isAmbiguousTitleTag('account executive'), 'denylist check is case-insensitive');
  assert(isAmbiguousTitleTag('ACCOUNT-EXECUTIVE'), 'denylist check is hyphen/case-insensitive together');

  // Real tags from the SAME audit that must NOT be caught — including the
  // confirmed-good "Python" <-> "Senior-Python-Engineer" case, and other
  // genuine technical tags a blanket suffix rule would have wrongly caught.
  for (const t of ['Python', 'React', 'AWS', 'PostgreSQL', 'Senior-Python-Engineer', 'Python-Developer', 'Backend-Engineer', 'Full-Stack-Developer', 'Data-Engineer', 'Software-Engineer', 'Next.js', 'SAP-FI-Consultant', 'Senior-SAP-FI-Consultant']) {
    assert(!isAmbiguousTitleTag(t), `"${t}" is NOT on the denylist (genuine/technical tag)`);
  }

  const filtered = filterAmbiguousTitleTags(['Python', 'Account-Executive', 'AWS', 'Senior-Account-Executive']);
  assert(filtered.length === 2 && filtered.includes('Python') && filtered.includes('AWS'), 'filterAmbiguousTitleTags removes only the denylisted entries, keeps order of the rest', JSON.stringify(filtered));
  assert(filterAmbiguousTitleTags([]).length === 0, 'empty input -> empty output');
  assert(filterAmbiguousTitleTags(null).length === 0, 'null input -> empty output, never throws');
  assert(filterAmbiguousTitleTags(undefined).length === 0, 'undefined input -> empty output, never throws');
}

console.log('\nUNIT: accounting/treasury tags are NOT denylisted (2026-10-31 boundary correction)');
{
  // Real tags from the live catalog (49,514-row scan, 2026-10-31) that must
  // stay eligible for matching — genuine accounting/treasury functions, not
  // sales-title fragments, even though they combine "account(s)" with a
  // title word the primary rule would otherwise catch.
  for (const t of [
    'Accounts-Payable-Manager', 'Accounts-Receivable-Manager', 'Accounts-Payable-Executive',
    'Accounts-Receivable-Director', 'Assistant-Accounts-Payable-Manager', 'Remote-Accounts-Payable-Manager',
    'Global-Director-Of-Account-And-Liquidity-Management',
  ]) {
    assert(!isAmbiguousTitleTag(t), `"${t}" is NOT on the denylist (genuine accounting/treasury function)`);
  }

  // The original confirmed sales-title collisions, including the
  // plural-"Accounts" variants, must be completely unaffected by this
  // correction — none of them name an accounting/treasury function word.
  for (const t of [
    'Account-Executive', 'Senior-Strategic-Account-Executive', 'Strategic-Accounts-Executive',
    'Strategic-Enterprise-Account-Executive', 'Account-Manager', 'Account-Director',
  ]) {
    assert(isAmbiguousTitleTag(t), `"${t}" (confirmed sales-title collision) is still on the denylist after the correction`);
  }
}

console.log('\nUNIT: Technical Account Manager / Account-Based Marketing tags are NOT denylisted (2026-10-31 narrowing pass)');
{
  // Real tags from the live catalog (CDW, Samsara, LocalStack, Ping Identity,
  // Napier AI, Total Expert for TAM; Tines, CCS Fundraising, Samsara,
  // EverCommerce, Brex, RealNetworks, YipitData for ABM) — confirmed genuine,
  // coherent, single-meaning job titles with zero candidate impact either
  // way, per the evidence review. Must stay eligible for skill-overlap
  // scoring despite containing "account" + a title word.
  for (const t of [
    'Technical-Account-Manager', 'Senior-Technical-Account-Manager', 'AWS-Technical-Account-Manager',
    'Technical-Account-Director', 'Technical-Account-Management-Manager',
  ]) {
    assert(!isAmbiguousTitleTag(t), `"${t}" (Technical Account Manager family) is NOT on the denylist`);
  }
  for (const t of [
    'Account-Based-Marketing-Manager', 'Senior-Account-Based-Marketing-Manager',
    'Account-Based-Experience-Marketing-Manager', 'Senior-Account-Based-Experience-Marketing-Manager',
  ]) {
    assert(!isAmbiguousTitleTag(t), `"${t}" (Account-Based Marketing family) is NOT on the denylist`);
  }

  // The confirmed sales-title collisions must be completely unaffected by
  // this narrowing — none of them name "technical" or "account-based".
  for (const t of [
    'Account-Executive', 'Senior-Strategic-Account-Executive', 'Strategic-Accounts-Executive',
    'Strategic-Enterprise-Account-Executive', 'Account-Manager', 'Account-Director', 'Channel-Account-Manager',
  ]) {
    assert(isAmbiguousTitleTag(t), `"${t}" (confirmed sales-title collision) is still on the denylist after the TAM/ABM narrowing`);
  }
}

console.log('\nUNIT: TAM/ABM carve-out is robust to pluralization and punctuation, without reopening the sales-title collision');
{
  // Plural/punctuated variants of the TAM/ABM family must stay excluded —
  // the carve-out must not depend on the exact live-catalog string shapes.
  for (const t of [
    'Technical-Account-Managers', 'Technical/Account/Manager', 'Technical, Account, Manager', 'Technical.Account.Manager',
    'Account-Based-Marketing-Managers', 'Account/Based/Marketing/Manager', 'Account, Based, Marketing, Manager',
  ]) {
    assert(!isAmbiguousTitleTag(t), `"${t}" (TAM/ABM variant with pluralization/punctuation) is NOT on the denylist`);
  }
  // Pluralized confirmed-bad sales-title tags must still be caught — the
  // plural title-word additions above must not be undone by this pass, and
  // the TAM/ABM carve-out words ("technical"/"based") must not appear in
  // these, so they must remain denylisted.
  for (const t of ['Account-Executives', 'Account-Managers', 'Account-Directors', 'Strategic-Account-Executives']) {
    assert(isAmbiguousTitleTag(t), `"${t}" (pluralized sales-title collision) is still on the denylist`);
  }
}

console.log('\nUNIT: carve-out is robust to pluralization and punctuation/formatting variants (not just the exact live-catalog strings)');
{
  // Plural "payables"/"receivables" — not observed combined with a title
  // word in the live catalog today, but the carve-out must not depend on
  // every tag happening to use the singular form.
  for (const t of ['Accounts-Payables-Manager', 'Accounts-Receivables-Director', 'Account-Payables-Executive']) {
    assert(!isAmbiguousTitleTag(t), `"${t}" (plural accounting-function word) is NOT on the denylist`);
  }
  // Punctuation other than hyphens — the live catalog never emits this, but
  // normalization must not silently fuse words together and hide a match.
  for (const t of ['Accounts Payable, Manager', 'Accounts-Payable/Manager', 'Accounts.Payable.Manager', 'Accounts (Payable) Manager']) {
    assert(!isAmbiguousTitleTag(t), `"${t}" (accounting tag with non-hyphen punctuation) is NOT on the denylist`);
  }
  // The same punctuation variants on the SALES side must still be caught —
  // the carve-out's robustness must not accidentally weaken the primary rule.
  for (const t of ['Account/Executive', 'Account, Manager', 'Account.Director']) {
    assert(isAmbiguousTitleTag(t), `"${t}" (sales-title tag with non-hyphen punctuation) is still on the denylist`);
  }
  // Genuine technical tags with periods must still be unaffected by the
  // broadened punctuation normalization.
  assert(!isAmbiguousTitleTag('Next.js'), '"Next.js" is still NOT on the denylist after broadening punctuation handling');
}

function profile(skills: string[]): PersonProfile {
  const now = new Date().toISOString();
  return {
    id: 'p1', email: 'p1@example.com', fullName: 'Test Profile', planTier: 'free',
    dailyEvaluationsCount: 0, lastEvaluationResetAt: now, createdAt: now, updatedAt: now,
    intent: { id: 'i1', profileId: 'p1', employmentTypes: ['Full-time'], targetRoles: [], yearsOfExperience: '2-3', preferredCurrency: 'USD', availabilityStatus: 'immediately', updatedAt: now },
    location: { id: 'l1', profileId: 'p1', currentCountry: 'India', currentTimezone: 'UTC', workPreference: 'worldwide', allowedCountries: [], willingTimezones: [] },
    skills: skills.map((s, i) => ({ id: `s${i}`, profileId: 'p1', skillName: s, yearsUsed: 3, isPrimary: true, evidenceLevel: 'strong' as const })),
    experiences: [],
  };
}

function opportunity(id: string, title: string, requiredSkills: string[]): CanonicalOpportunity {
  const now = new Date().toISOString();
  return {
    id, type: 'job', title, company: 'Test Co', description: `${title} role.`,
    source: 'curated', sourceId: id, officialUrl: 'https://example.com/apply',
    canonicalUrlHash: `h-${id}`, contentHash: `c-${id}`, employmentType: 'Full-time', remoteType: 'Worldwide',
    eligibleCountries: [], excludedCountries: [], timezoneRequirements: [],
    requiredSkills, preferredSkills: [], qualityScore: 85, status: 'active', postedAt: now, lastVerifiedAt: now,
  };
}

console.log('\nREGRESSION: the confirmed bad pair no longer matches');
{
  const user = profile(['Account-Executive']);
  const salesJobUK = opportunity('opp-ae-uk', 'Strategic Account Executive, UK', [
    'Strategic-Account-Executive', 'Enterprise-Account-Executive', 'Account-Executive', 'Senior-Account-Executive', 'Senior-Strategic-Account-Executive', 'Strategic-Accounts-Executive', 'Strategic-Enterprise-Account-Executive',
  ]);
  const fit = computeScreeningFit(user, salesJobUK);
  assert(fit.overlapSkills.length === 0, 'Account-Executive skill no longer overlaps the sales job\'s tags', JSON.stringify(fit.overlapSkills));
  const analysis = generateRuleBasedMatchAnalysis(user, salesJobUK);
  // Only the skill-TAG-derived checklist items are in scope here — generic
  // eligibility facts (seniority tier, remote-work eligibility) are a
  // separate, legitimate part of the checklist and correctly stay "matched"
  // for a worldwide-eligible candidate; this spec only touches skill-tag
  // matching, nothing else in the checklist.
  const matchedTagRequirements = analysis.requirementChecklist.filter(
    (r) => r.status === 'matched' && salesJobUK.requiredSkills.includes(r.requirement)
  );
  assert(matchedTagRequirements.length === 0, 'none of the sales job\'s title-tag requirements are reported as "matched" against this user', JSON.stringify(matchedTagRequirements));
}

console.log('\nREGRESSION: the confirmed GOOD pair still matches (denylist stays narrow)');
{
  const user = profile(['Python']);
  const pythonJob = opportunity('opp-python-eng', 'Senior Python Engineer', ['Senior-Python-Engineer', 'Backend-Engineer', 'Python-Developer']);
  const fit = computeScreeningFit(user, pythonJob);
  assert(fit.overlapSkills.length > 0, 'Python skill still correctly matches a Python-Engineer-tagged job', JSON.stringify(fit.overlapSkills));
}

console.log('\nREGRESSION: a genuine accounting-skill candidate still matches an accounting-tagged job (2026-10-31 correction, end-to-end)');
{
  const user = profile(['Accounts-Payable-Manager']);
  const apJob = opportunity('opp-ap-manager', 'Accounts Payable Manager', ['Accounts-Payable-Manager', 'Accounts-Receivable-Manager']);
  const fit = computeScreeningFit(user, apJob);
  assert(fit.overlapSkills.length > 0, 'Accounts-Payable-Manager skill correctly matches an accounting job tagged with it (not stripped by the denylist)', JSON.stringify(fit.overlapSkills));
}

console.log('\nREGRESSION: a genuine TAM/ABM-skill candidate matches a TAM/ABM-tagged job, end-to-end (2026-10-31 narrowing, engine-level)');
{
  const tamUser = profile(['Technical-Account-Manager']);
  const tamJob = opportunity('opp-tam', 'Technical Account Manager, Public Cloud', [
    'Technical-Account-Manager', 'Cloud-Account-Management', 'Cloud-Solutions-Consultant', 'Customer-Success-Manager',
  ]);
  const tamFit = computeScreeningFit(tamUser, tamJob);
  assert(tamFit.overlapSkills.length > 0, 'Technical-Account-Manager skill correctly matches a TAM-tagged job (not stripped by the denylist)', JSON.stringify(tamFit.overlapSkills));
  const tamAnalysis = generateRuleBasedMatchAnalysis(tamUser, tamJob);
  const tamMatched = tamAnalysis.requirementChecklist.some((r) => r.requirement === 'Technical-Account-Manager' && r.status === 'matched');
  assert(tamMatched, 'Technical-Account-Manager appears as a "matched" requirement in the checklist', JSON.stringify(tamAnalysis.requirementChecklist));

  const abmUser = profile(['Account-Based-Marketing-Manager']);
  const abmJob = opportunity('opp-abm', 'Account Based Marketing (ABM) Manager', [
    'Account-Based-Marketing-Manager', 'ABM-Manager', 'Marketing-Manager', 'B2B-Marketing-Manager',
  ]);
  const abmFit = computeScreeningFit(abmUser, abmJob);
  assert(abmFit.overlapSkills.length > 0, 'Account-Based-Marketing-Manager skill correctly matches an ABM-tagged job (not stripped by the denylist)', JSON.stringify(abmFit.overlapSkills));
  const abmAnalysis = generateRuleBasedMatchAnalysis(abmUser, abmJob);
  const abmMatched = abmAnalysis.requirementChecklist.some((r) => r.requirement === 'Account-Based-Marketing-Manager' && r.status === 'matched');
  assert(abmMatched, 'Account-Based-Marketing-Manager appears as a "matched" requirement in the checklist', JSON.stringify(abmAnalysis.requirementChecklist));
}

console.log('\nENGINE INTEGRATION: edge cases (empty required_skills, and the new all-filtered-out interaction)');
{
  const user = profile(['Python']);

  // Empty required_skills: pre-existing behavior, must still not crash and
  // must still fall back to the generic checklist in generateRuleBasedMatchAnalysis.
  const emptySkillsJob = opportunity('opp-empty', 'Generic Remote Role', []);
  const emptyFit = computeScreeningFit(user, emptySkillsJob);
  assert(emptyFit.overlapSkills.length === 0 && emptyFit.missingSkills.length === 0, 'empty required_skills does not crash computeScreeningFit', JSON.stringify(emptyFit));
  const emptyAnalysis = generateRuleBasedMatchAnalysis(user, emptySkillsJob);
  const emptyFallbackPresent = emptyAnalysis.requirementChecklist.some((r) => r.requirement === 'Remote Collaboration' || r.requirement === 'Communication');
  assert(emptyFallbackPresent, 'empty required_skills still falls back to the generic checklist (pre-existing behavior, unchanged)', JSON.stringify(emptyAnalysis.requirementChecklist));

  // NEW interaction introduced by this fix: a job whose required_skills are
  // ALL denylisted (not empty to begin with, but empty AFTER filtering)
  // must hit the exact same fallback, not crash or produce an empty checklist.
  const allAmbiguousJob = opportunity('opp-all-ambiguous', 'Strategic Account Executive', ['Account-Executive', 'Senior-Account-Executive']);
  const allAmbiguousFit = computeScreeningFit(user, allAmbiguousJob);
  assert(allAmbiguousFit.overlapSkills.length === 0, 'a job whose required_skills are all denylisted has zero overlap (not a crash, not a stale raw-tag match)', JSON.stringify(allAmbiguousFit));
  const allAmbiguousAnalysis = generateRuleBasedMatchAnalysis(user, allAmbiguousJob);
  const fallbackPresent = allAmbiguousAnalysis.requirementChecklist.some((r) => r.requirement === 'Remote Collaboration' || r.requirement === 'Communication');
  assert(fallbackPresent, 'a job whose required_skills are all denylisted falls back to the generic checklist, same as a job with no required_skills at all', JSON.stringify(allAmbiguousAnalysis.requirementChecklist));
  const noAmbiguousTagInChecklist = !allAmbiguousAnalysis.requirementChecklist.some((r) => r.requirement === 'Account-Executive' || r.requirement === 'Senior-Account-Executive');
  assert(noAmbiguousTagInChecklist, 'the denylisted tags themselves never appear in the requirement checklist', JSON.stringify(allAmbiguousAnalysis.requirementChecklist));
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exitCode = failed > 0 ? 1 : 0;
