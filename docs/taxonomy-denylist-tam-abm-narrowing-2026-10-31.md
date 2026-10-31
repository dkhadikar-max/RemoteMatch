# Taxonomy denylist — narrowing the word-combination rule (TAM / ABM)

2026-10-31 · implemented in `fix-taxonomy-skill-collision-wt` (branch `fix/taxonomy-skill-collision`),
per Deep's explicit authorization following the read-only semantic evidence review of
`Technical-Account-Manager` and `Account-Based-Marketing-Manager`. **No commit, push, PR, merge,
migration, or deployment** — everything below is in the local worktree only.

## What changed

`src/lib/matching/ambiguous-title-tags.ts`:

1. **New carve-out — independent semantic modifiers.** Added `INDEPENDENT_SEMANTIC_MODIFIER_WORDS =
   {'technical', 'based'}`, checked the same way as the existing accounting/treasury function-word
   carve-out (positive evidence of a distinct, non-sales role, short-circuits before the generic
   `account` + title-word check). `"technical"` names the Technical Account Manager family;
   `"based"` (as in `"Account-Based"`) names the Account-Based Marketing family.
2. **Pluralization robustness.** `ACCOUNT_TITLE_WORDS` now also matches the plural forms
   (`executives`, `managers`, `directors`), so a plural variant of a confirmed-bad sales-title tag
   can't slip past the rule by pluralization alone — this closes a real gap the previous version had
   (confirmed by testing: `"Account-Executives"` was NOT caught before this change).
3. Updated header comment to record the resolved evidence review (previously left as an open,
   unresolved question — now resolved with production data, per Deep's authorization).

`src/lib/matching/engine.ts`: **unchanged this pass** (already wired to call `filterAmbiguousTitleTags`
from an earlier phase of this spec — confirmed via diff review, see below). `skillMatches()`, the
scoring formula, and its weights are untouched, as required.

`test/taxonomy-skill-denylist-suite.ts`:
- Removed `'Technical-Account-Manager'` from the "must be ambiguous" list (it was wrongly asserted
  there by an earlier pass, before this evidence review).
- New unit block: TAM family (`Technical-Account-Manager`, `Senior-Technical-Account-Manager`,
  `AWS-Technical-Account-Manager`, `Technical-Account-Director`, `Technical-Account-Management-Manager`)
  and ABM family (`Account-Based-Marketing-Manager`, `Senior-Account-Based-Marketing-Manager`,
  `Account-Based-Experience-Marketing-Manager`, `Senior-Account-Based-Experience-Marketing-Manager`)
  all assert **NOT** denylisted; confirmed sales-title collisions re-asserted **still** denylisted
  immediately after.
- New negative-test block: plural/punctuated TAM/ABM variants stay carved out
  (`Technical-Account-Managers`, `Technical/Account/Manager`, `Account-Based-Marketing-Managers`, …);
  pluralized confirmed-bad sales tags (`Account-Executives`, `Account-Managers`, `Account-Directors`,
  `Strategic-Account-Executives`) are still caught — proving the narrowing didn't reopen the original
  collision.
- New end-to-end `computeScreeningFit`/`generateRuleBasedMatchAnalysis` regression: a candidate whose
  only skill is `Technical-Account-Manager` now correctly matches a job tagged with it (and the tag
  shows as `matched` in the requirement checklist); same for `Account-Based-Marketing-Manager`.

## Test results

`npx tsx test/taxonomy-skill-denylist-suite.ts`: **93/0** (up from the prior run's count; all new
assertions pass, zero regressions in existing ones).

`npx tsc --noEmit`: clean.

Three existing matching suites, re-run in full, **zero assertion changes**:
- `test/skill-match-suite.ts`: 47/0
- `test/feed-profile-scoring-suite.ts`: 8/0
- `test/linkedin-jobs-matching-suite.ts`: 15/0

## Full-catalog scan — before/after (read-only, production, 2026-10-31)

Scanned all **50,123 active opportunity rows** / **413,164** `required_skills` tag instances /
**59,021 distinct tags**.

| | Distinct tags denylisted | Opportunity rows affected |
|---|---|---|
| **Before** (old rule: accounting carve-out only, no TAM/ABM carve-out) | 509 | 4,029 |
| **After** (this pass) | 497 | 3,959 |

**12 distinct tags carved out** (now eligible for skill-overlap matching again), with their active
opportunity-row counts:

| Tag | Active rows |
|---|---|
| `Technical-Account-Manager` | 125 |
| `Senior-Technical-Account-Manager` | 30 |
| `Technical-Account-Executive` | 19 |
| `Account-Based-Marketing-Manager` | 12 |
| `Technical-Account-Manager-Lead` | 8 |
| `Technical-Sales-Account-Manager` | 8 |
| `Technical-Account-Director` | 6 |
| `Technical-Account-Management-Manager` | 6 |
| `Technical-Sales-Account-Executive` | 4 |
| `Account-Based-Marketing-Director` | 3 |
| `Security-Technical-Account-Manager` | 2 |
| `AWS-Technical-Account-Manager` | 1 |

A sanity check (isNew must be a strict subset of wasOld — narrowing only removes, never adds) passed
with zero violations once the comparison script correctly included the pre-existing
`ANALOGOUS_AMBIGUOUS_PHRASES` check in its "old rule" baseline (an error in the *comparison script*
itself, not the production code — caught and fixed before trusting the numbers).

**Representative sample of what's still (correctly) denylisted** (top by opportunity-row count):
`Account-Executive` (1,236), `Account-Manager` (964), `Business-Development-Manager` (682),
`Sales-Manager` (648), `Business-Development` (599), `Customer-Success-Manager` (488),
`Enterprise-Account-Executive` (442), `Key-Account-Manager` (276), `Sales-Account-Manager` (184),
`Senior-Account-Executive` (175), `Strategic-Account-Manager` (145), `Account-Director` (113).

## Remaining ambiguous cases (observed, not evaluated under this authorization)

These surfaced in the still-denylisted top list during the scan and have the same *shape* of question
as TAM/ABM (a compound title containing `account` + a title word), but were **not** part of today's
authorized scope (only TAM and ABM were authorized) and have **not** been evidence-reviewed:

- `Customer-Success-Account-Manager` (124 active rows) — a CS/sales hybrid title; could plausibly be
  another independent-semantic-modifier case (`"customer success"` as the modifier), or could
  genuinely be sales-adjacent. Unreviewed.
- `Director-Of-Account-Management`, `Director-Of-Strategic-Account-Management` (Total Expert) —
  leadership titles over account management; unreviewed.
- `Sales-Account-Manager`, `Strategic-Account-Manager`, `Key-Account-Manager`,
  `Enterprise-Sales-Account-Executive` — these read as squarely within the originally confirmed
  sales-account-management collision pattern (not flagged as questionable), listed here only for
  completeness of the "still denylisted" picture, not as open questions.

No code change was made for any of the above — flagging only, per the instruction to report remaining
ambiguous cases.

## Boundaries explicitly honored

- `skillMatches()`, the scoring formula, and its weights: **untouched** (confirmed via diff review of
  `engine.ts` — the only changes there predate this pass and are limited to calling
  `filterAmbiguousTitleTags()` before the existing comparison logic).
- No migrations, no production writes, no commits, no pushes, no PR, no merge, no deployment.
  Everything above lives in the local worktree (`fix-taxonomy-skill-collision-wt`) only. Two
  temporary read-only scan scripts were written to the worktree/scratchpad for evidence-gathering
  and deleted immediately after use — no record of them remains in the worktree.
