/**
 * Ambiguous title/skill-tag denylist — Spec 1 (taxonomy fixes), narrow fix.
 * ==============================================================================
 * docs/spec-taxonomy-fixes-2026-10-30.md, Option A: `required_skills` tags
 * that look like a generic job-title fragment rather than a genuine skill
 * are filtered OUT of the opportunity's skill list before it ever reaches
 * skillMatches() — never a change to skillMatches() itself, the scoring
 * formula, or its weights (all three stay frozen/untouched).
 *
 * Confirmed real-world case this exists for (docs/audit-relevance-swipe-
 * journey-2026-10-30.md, Part 1): a user listed "Account-Executive" as a
 * skill, almost certainly meaning accounts-receivable/accounting experience
 * (their target roles were "Account receivable" / "Order to cash"). The
 * same string (and several Senior-/Strategic-/Enterprise- modified
 * variants of it) appears as `required_skills` tags on unrelated SALES
 * postings ("Strategic Account Executive, UK", "Enterprise Account
 * Executive, DACH"), producing two false "interested" matches.
 *
 * Two deliberate design choices:
 *  1. NOT a broad suffix-based heuristic (e.g. "anything ending in
 *     -Engineer/-Architect/-Analyst/-Developer"). That was considered and
 *     rejected: the same audit's own data shows a CONFIRMED GOOD match this
 *     codebase must not regress (a user with the skill "Python" correctly
 *     matched to a job tagged "Senior-Python-Engineer") — a blanket
 *     technical-title-suffix filter would silently break that, and the
 *     first version of this file (an exact-string curated list) still
 *     missed real modifier variants like "Senior-Strategic-Account-
 *     Executive" and "Strategic-Enterprise-Account-Executive" seen on the
 *     actual job postings. The fix below is a targeted WORD-COMBINATION
 *     rule instead: "account" co-occurring with "executive"/"manager"/
 *     "director", in any order and with any modifier words around them —
 *     this catches every real variant seen without touching any tag that
 *     doesn't contain the word "account" at all (so "Software-Engineer",
 *     "Senior-Python-Engineer", "Backend-Engineer" etc. are never affected).
 *  2. A small secondary curated list for OTHER plausible-by-analogy
 *     collision patterns (sales/business-development/success-manager
 *     titles) that were not independently confirmed in the audit sample —
 *     marked as such. Extend either list only with the same kind of named,
 *     evidence-grounded reasoning, not by guessing at patterns.
 *
 * Boundary correction (2026-10-31, false-positive review against the live
 * catalog): the word-combination rule alone conflates two different senses
 * of "account(s)" — the sales/CRM sense ("the Acme account", a client
 * relationship) and the accounting/treasury sense ("accounts payable", a
 * ledger). A live scan of all 49,514 active opportunities' required_skills
 * found 7 tags (42 rows) in the second sense wrongly caught:
 * Accounts-Payable-Manager, Accounts-Receivable-Manager,
 * Accounts-Payable-Executive, Accounts-Receivable-Director,
 * Assistant-/Remote-Accounts-Payable-Manager, and Global-Director-Of-
 * Account-And-Liquidity-Management. Rather than list-exempting those exact
 * strings (which wouldn't generalize), the rule below adds a second,
 * equally narrow word check: a tag naming a specific accounting/treasury
 * FUNCTION ("payable", "receivable", "liquidity") is never a sales-title
 * fragment, no matter what title word sits next to "account(s)" — so this
 * check is checked FIRST and short-circuits the rest. All of the originally
 * confirmed collisions (including the plural-"Accounts" variants,
 * Strategic-Accounts-Executive / Senior-Strategic-Account-Executive) name
 * no such function word, so they are unaffected and still caught.
 *
 * Robustness pass (2026-10-31, same day): a broad live-catalog scan (every
 * tag containing "payab*"/"receiv*"/"liquid*" across all 49,870 active
 * opportunities) found no tag anywhere using punctuation other than
 * hyphens/underscores — this ingestion pipeline consistently emits
 * hyphen-separated words only, so there is no currently-active bypass via
 * slashes, commas, or parentheses. But the scan did surface real plural
 * forms ("Payables-Associate", "Receivables-Specialist") elsewhere in the
 * catalog, which the exact-singular word match would have missed had they
 * ever combined with "account(s)" + a title word — so the function-word
 * set below also accepts the plain plural, and normalization now folds in
 * a few other common separators defensively, for the SAME reason (closing
 * a dormant gap in the three words above, not adding new categories).
 *
 * Evidence review (2026-10-31, final-review follow-up) — two tags the
 * word-combination rule was denylisting on an unsupported assumption, now
 * resolved against live production data (not left as a guess):
 *  - Technical-Account-Manager: real postings at CDW, Samsara, LocalStack,
 *    Ping Identity, Napier AI, Total Expert, and others — every sampled
 *    occurrence is a genuine, coherent, single-meaning technical-account-
 *    management job title (an industry-standard category, "TAM"), not a
 *    collision with an unrelated profession. A `profile_skills` scan found
 *    ZERO candidates currently self-reporting this skill under any variant.
 *  - Account-Based-Marketing-Manager: real postings at Tines, CCS
 *    Fundraising, Samsara, EverCommerce, Brex, RealNetworks, YipitData, and
 *    others — same finding: a coherent, single-meaning marketing-ops title,
 *    zero candidates currently self-reporting it.
 *  Unlike the confirmed Account-Executive collision, neither tag has a
 *  plausible alternate-profession meaning, and neither has ever produced an
 *  observed bad match. They were only being caught because the generic
 *  "account" + title-word combination is broader than the sales-seniority
 *  pattern it was built for: "Technical" and "Account-Based" are independent
 *  semantic modifiers that name a distinct, non-sales role — structurally
 *  the same kind of positive evidence as the accounting/treasury function
 *  words above, not a new kind of exception. Resolved below as a third,
 *  equally narrow carve-out (2026-10-31, taxonomy-denylist narrowing pass).
 *  Extend this list only with the same kind of named, evidence-grounded
 *  case — not by guessing at other plausible-looking modifiers.
 */

/** Word-combination rule, the CONFIRMED collision pattern. Both singular and
 *  plural "account(s)" are seen on real postings ("Strategic Accounts
 *  Executive"), and title words are matched in both singular and plural form
 *  so a plural variant of a confirmed-bad tag (e.g. a hypothetical
 *  "Account-Executives" listing) can't slip past this check by pluralization
 *  alone — narrowing the rule elsewhere must not reopen that gap. */
const ACCOUNT_WORDS: ReadonlySet<string> = new Set(['account', 'accounts']);
const ACCOUNT_TITLE_WORDS: ReadonlySet<string> = new Set([
  'executive', 'executives', 'manager', 'managers', 'director', 'directors',
]);

/** Accounting/treasury FUNCTION words — positive evidence the tag names a
 *  financial process, not a client-relationship job title. Presence of any
 *  of these next to "account(s)" overrides the sales-title match above.
 *  Narrow and evidence-grounded (the 7 confirmed tags above), not a guess:
 *  extend only with the same kind of named, confirmed case. */
const ACCOUNTING_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'payable', 'payables', 'receivable', 'receivables', 'liquidity',
]);

/** Independent-semantic-modifier words — the same kind of positive evidence
 *  as the accounting/treasury function words above, for a different pair of
 *  confirmed-legitimate compound titles (see the Evidence review comment).
 *  "Technical" names the Technical Account Manager family; "based" (as in
 *  "Account-Based") names the Account-Based Marketing family — in both
 *  cases the modifier makes the tag a distinct, non-sales role regardless
 *  of which title word sits next to "account(s)". */
const INDEPENDENT_SEMANTIC_MODIFIER_WORDS: ReadonlySet<string> = new Set(['technical', 'based']);

/** Plausible-by-analogy, NOT independently confirmed in the 2026-10-30 audit
 *  sample — kept separate and smaller so it's easy to prune if it ever
 *  causes an unwanted miss. */
const ANALOGOUS_AMBIGUOUS_PHRASES: ReadonlySet<string> = new Set([
  'sales manager',
  'business development manager',
  'business development',
  'client success manager',
  'customer success manager',
]);

/** Lowercase, hyphens/underscores/slashes/commas/periods/parentheses ->
 *  spaces, collapse whitespace. The live catalog has never been observed
 *  using anything but hyphens (2026-10-31 scan, 49,870 active rows), so this
 *  is defensive hardening, not a response to an active case — it keeps
 *  "Account/Executive" or "Account, Executive" from slipping past the exact
 *  word-match checks below by punctuation alone. Deliberately a separate
 *  normalization from skill-match.ts's normalizeSkillKey() — this module's
 *  only job is a denylist membership test, not the match predicate itself,
 *  so it doesn't need (and shouldn't inherit) that function's alias map or
 *  short-skill token rules. */
function normalizeForDenylist(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[-_/,.()&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True if this required_skills tag looks like a generic job-title fragment
 *  known to collide with an unrelated profession's self-described skill. */
export function isAmbiguousTitleTag(tag: string): boolean {
  if (typeof tag !== 'string') return false;
  const normalized = normalizeForDenylist(tag);
  if (!normalized) return false;

  const words = normalized.split(' ');

  // Accounting/treasury function words are checked first: they're positive
  // evidence this is a genuine finance-domain tag, not a sales-title
  // fragment, regardless of what else the tag contains.
  const hasAccountingFunctionWord = words.some((w) => ACCOUNTING_FUNCTION_WORDS.has(w));
  if (hasAccountingFunctionWord) return false;

  // Independent-semantic-modifier words are checked next, same reasoning as
  // the accounting/treasury check above: positive evidence of a distinct,
  // non-sales role, regardless of what title word sits next to "account(s)".
  const hasIndependentSemanticModifier = words.some((w) => INDEPENDENT_SEMANTIC_MODIFIER_WORDS.has(w));
  if (hasIndependentSemanticModifier) return false;

  const hasAccountWord = words.some((w) => ACCOUNT_WORDS.has(w));
  const hasTitleWord = words.some((w) => ACCOUNT_TITLE_WORDS.has(w));
  if (hasAccountWord && hasTitleWord) return true;

  return ANALOGOUS_AMBIGUOUS_PHRASES.has(normalized);
}

/**
 * Filters an opportunity's `requiredSkills` (or any string array of the same
 * shape) down to the entries that are NOT on the ambiguous-title denylist.
 * Call this once, at the point `opportunity.requiredSkills` is first read
 * for matching — never inside skillMatches() itself, and never on the
 * profile/user side (the collision is specifically about job TAGS being
 * title fragments; a user's own skill list is left completely untouched).
 */
export function filterAmbiguousTitleTags(requiredSkills: readonly string[] | null | undefined): string[] {
  if (!requiredSkills) return [];
  return requiredSkills.filter((s) => !isAmbiguousTitleTag(s));
}
