# RemoteMatch — Additional Supply Discovery

**Type:** Phase B planning specification.
**Review state:** **Review 1 incorporated.** B1 (architecture / spec sign-off) approved; the six open questions are resolved (§17). This version supersedes the initial draft. Nothing below C1 is authorized for implementation. **Next gate is B2** (acquisition spike).
**Depends on:** the signed Live Supply Activation spec (v2), shipped as migration `010_live_supply_catalog.sql` + `src/lib/ingestion/catalog-sync.ts` (Phase A).
**Does not touch:** matching / scoring / `computeQualityScore()`, swipe mechanics, monetization / quota, the frozen SEO architecture, the auth invariant, or the P0/P1 outcome contracts. Discovery adds an *upstream* supply path; everything downstream of the `opportunities` catalog is unchanged.
**Guiding principle for this phase:** keep the first implementation deliberately smaller than the eventual vision. Instrument → accumulate evidence → validate → activate, exactly as P0 → P1.

---

## Decision summary (Review 1)

| # | Question | Decision |
|---|---|---|
| 1 | Option A (run freehire as a service) vs Option B (port adapters) | **Option B — single deploy is a hard constraint for this phase.** B2 spike still runs first, to confirm porting is cheaper than operating a service. |
| 2 | Initial employer allowlist | **RemoteMatch-curated, evidence-based.** Eligibility = observable evidence the company publishes remote roles via an official career/ATS source. Not a quality judgement about the employer. |
| 3 | Review queue | **CLI / protected admin script / seed migration, with a mandatory audit trail. No admin UI in C3.** Build the UI only when manual approval volume becomes operationally annoying — that annoyance is the trigger. |
| 4 | `target_supply` per pattern | **Demand-scaled with a floor and ceiling.** `clamp(base + demand_factor × meaningful_demand, min, max)`. Constants not frozen now; set from the observed distribution at C2. |
| 5 | Enough users for the demand model? | **Instrument C2 now as measurement only. Gate automated gap-triggered discovery** on an evidence bar whose numeric thresholds come from the observed distribution, not invented today. |
| 6 | Direct employers (Layer 3) | **Separate future track.** Architecturally compatible (via `source_type`), not on this roadmap. Must not contaminate the supply-discovery MVP. |

---

## 0. The gating decision: build the agent, or adopt existing infrastructure?

**Resolved: adopt the deterministic acquisition layer, build only the demand / discovery / learning layer. Do not build a general "scraping agent."**

### 0.1 The problem splits into three layers with very different build economics

| Layer | What it does | Off-the-shelf maturity | Decision |
|---|---|---|---|
| **Acquisition** | Given a known source, fetch → parse → normalize its current listings, on a schedule, with retries and pagination | **High.** ATS boards expose stable, documented, public JSON. MIT-licensed projects already maintain endpoint shapes and company→ATS mappings for 90+ platforms. | **Adopt** |
| **Demand modelling** | Turn RemoteMatch's own user requirements + catalog state + P0/P1 outcome data into a ranked list of supply gaps | **None.** Depends entirely on our users, our facets, our catalog, our outcomes. | **Build** |
| **Discovery** | Given a supply gap, decide *which* employers / ATS boards could plausibly fill it, validate them, register them permanently | **Partial.** Company lists and ATS directories exist as data; the judgement does not. | **Build (thin), data-adopt** |

An autonomous "crawl the internet for jobs" agent is the wrong framing for all three. Acquisition is boring deterministic code. Demand is analytics. Only discovery benefits from model reasoning, and only narrowly.

### 0.2 Repo evaluation

**JobSpy** (`speedyapply/JobSpy`) — [github.com/speedyapply/JobSpy](https://github.com/speedyapply/JobSpy) — **reject as foundation.**
Python ≥3.10 service; HTML-scrapes LinkedIn / Indeed / Glassdoor / Google / ZipRecruiter — exactly the ToS-hostile, active-anti-bot sources the strategy avoids; documented 429s; needs a rotating proxy pool; no consent model. MIT on the code grants nothing about the target sites' terms or the scraped data. Keep only as a parsing-idiom reference; do not deploy.

**freehire** (`strelov1/freehire`) — [github.com/strelov1/freehire](https://github.com/strelov1/freehire) — **adopt as Option B (port), pending B2 confirmation.**
MIT on code *and* the pipeline data / ATS source catalogue. Go + SvelteKit, ~3.3k commits, active. 92 ATS platforms (Greenhouse, Lever, Ashby, Workday, iCIMS, …) via direct public endpoints; same fetch → normalize → dedup → upsert pipeline shape as our Phase A. Ships an HTTP API + CLI; self-host via Docker Compose. Its search/dedup layer (pgvector + Meilisearch) partly duplicates our catalog and is heavier than we need.

Other repos to check at B2 only if useful: `kalil0321/ats-scrapers` (MIT ATS library), `Feashliaa/job-board-aggregator` (Greenhouse/Lever/Ashby/Workday ETL).

### 0.3 The two forms of adoption, and the decision

- **Option A — run freehire as an internal upstream service.** Deploy it (or a trimmed fork) on Railway; RemoteMatch adds one `JobProvider` calling its HTTP API. Rejected for this phase: a second service + its Postgres/Meilisearch to operate, monitor and secure; a new network boundary; inherited refresh cadence and bugs; coarser control over which companies we pull.
- **Option B — port the MIT ATS endpoint catalogue + normalization rules; implement 2–3 deterministic TS adapters (Greenhouse, Lever, Ashby) behind the existing `JobProvider` interface.** **Chosen.** No new service; provider failures stay inside the existing `Promise.allSettled` isolation; the existing catalog / lifecycle / freshness controls are reused unchanged; provenance is straightforward; the MVP only needs 2–3 integrations.

**Single-deploy is a hard constraint for this phase.** Revisit Option A only if the approved ATS-platform count later crosses ~20, where maintaining adapters ourselves stops being cheap — and as its own decision, not a default.

### 0.4 The agent we actually need — narrow, and much later

Not "an AI scraper that browses the internet and finds jobs." Instead: a **Demand-driven Source Discovery Agent** whose entire job is to answer, on request:

> "What source could satisfy this unmet demand?"

It is **not** responsible for scheduling, crawling, routine fetching, deduplication, availability, lifecycle, publishing, scoring, or matching. Those are deterministic and mostly already built. The agent produces *proposals*; humans approve; deterministic code acts. First appears at gate D1, behind manual trigger and human approval.

---

## 1. Demand model

**Purpose:** produce a ranked, deterministic table of supply gaps — `(demand_pattern, gap_score)` — as the sole interface between demand and discovery. No model reasoning in this layer.

### 1.1 Demand pattern

A normalized tuple of the facets RemoteMatch already matches on. MVP definition — deliberately coarse, no clustering:

```
DemandPattern = {
  role_family:        enum      // deterministic title lexicon, e.g. "product_management"
  seniority:          enum      // junior | mid | senior | staff+   (title tokens; reuses createNormalizedJobKey's strip list)
  region_scope:       enum      // worldwide | us | eu_eea | india | timezone_restricted   (reuses RemoteType)
  domain:             enum|null // saas | fintech | health | ... | null
  comp_floor_bucket:  enum|null // <80k | 80-120k | 120-160k | 160k+ | null
}
```

Coarse on purpose: at current verified-account volume, statistical clustering of free-text searches would be fitting noise. A fixed facet tuple is inspectable, stable across time windows, and directly comparable to catalog inventory (stored on the same facets). Embedding / clustering-based demand-pattern learning is **deferred to Phase E** and gated on volume.

### 1.2 Demand signals — "meaningful demand", not raw signups

Raw account count is not demand. A person who signed up six months ago and never returned must not weigh the same as someone actively searching this week.

```
verified user  →  has an active search requirement  →  normalized to a demand pattern  →  weighted by recency
```

| Signal | Source | Provenance | Contributes when |
|---|---|---|---|
| Active user requirement | onboarding profile + saved filters | first-party, user-stated | the account is verified and the requirement is current |
| Revealed demand | `decisionSnapshot` on swipes | server-authoritative (P0) | within the recency window |
| Search / filter events | feed query params | first-party | within the recency window |
| Application intent | `applications` (interested / applied) | server-authoritative (P0) | within the recency window |

```
demand_weight(pattern) = Σ  signal_base_weight(s) · recency_weight(age(s))
```

`recency_weight` decays with age (a bounded decay — exact half-life set at C2 from observed return-visit behaviour). `signal_base_weight` is a fixed, documented linear scale (an active requirement > a one-off filter tweak). **No learned weights in Phases B–E.** Coefficients are recorded in a spec addendum at Gate C2 and not silently re-tuned later.

### 1.3 Supply inventory

For each pattern:

- `active_supply(pattern)` — count of `opportunities` rows currently `active` and satisfying the tuple, read through the same facet columns matching uses.
- `effective_supply(pattern)` — `active_supply` discounted for staleness and for jobs the driving users have already been shown and swiped away (a job every relevant user has rejected is not supply).

### 1.4 Supply gap — demand-scaled target with floor and ceiling

```
target_supply(pattern) = clamp( base + demand_factor · demand_weight(pattern), min_target, max_target )

shortfall(pattern)     = max(0, target_supply(pattern) − effective_supply(pattern)) / target_supply(pattern)
gap_score(pattern)     = demand_weight(pattern) · shortfall(pattern)
```

Intent:

```
low demand    → maintain minimum viable supply (min_target)
medium demand → expand source discovery
high demand   → aggressively close the gap (up to max_target)
```

`base`, `demand_factor`, `min_target`, `max_target` are **not frozen now**. They are set at Gate C2 from the observed distribution of `demand_weight` across real patterns, and recorded in the addendum. Output: a ranked table by `gap_score`, recomputed on a schedule. **This table is the entire demand→discovery interface.**

### 1.5 What the demand model may not do

- No reads or writes to matching / scoring. Operates on patterns, never personalizes.
- In Phases B–C it only *reports* gaps. It never triggers discovery. Auto-triggering is gate D3, behind the evidence bar in §5.
- It never emits a supply *claim* ("Remote PMs have insufficient supply") in Phase C — a small population can make three PM users look like a shortage. C2 output is raw instrumentation plus an explicit dataset-adequacy assessment (§5).

---

## 2. Agent responsibilities (and hard limits)

"Agent" = a bounded, single-purpose task using model reasoning, invoked deterministically, output treated as a proposal — never an action.

### 2.1 Task A — Demand-driven candidate source proposal (gate D1)

- **Input:** one demand pattern + gap context (current active jobs, which employers already supply it, which registered sources were already tried).
- **Output:** candidate sources, each `{ employer_name, hypothesised_ats | career_page_url, why_relevant, confidence }`.
- Runs **at most once per demand pattern**, then cached in the registry indefinitely. Re-run only on explicit manual request or if a pattern's registered sources have all gone stale.
- Web search + fetch **only through the SSRF-safe egress helper** (§13). Never fetches user-influenced URLs.
- Output goes to a **review queue** (§3.3), not the acquisition scheduler.

### 2.2 Task B — Unknown-structure extraction (gate D4, likely far out)

- Only for an already-approved employer with **no known ATS adapter**.
- **Output:** structured candidates in `RawJobPayload` shape, per-field confidence, the raw snippet each field came from.
- Goes through the **identical** deterministic validation, normalization, dedup, and catalog lifecycle as every provider. Never sets `status`.
- Most MVP and near-term sources have a known ATS, so Task B may not be needed for a long time. Not on the critical path.

### 2.3 Out of scope for any agent

Deciding a job is "good enough to publish" (deterministic content gate + lifecycle); deciding a job is still available (freshness, §11); scoring / ranking / matching; **any direct write** to `opportunities`, `applications`, or the registry; bulk per-job model calls (§12 forbids it). Agents propose; deterministic code writes after a gate.

---

## 3. Source registry

The durable asset. A source is learned once and reused for every future demand it can serve.

### 3.1 Core principle — source knowledge is reusable independently of the demand that discovered it

```
User A · Senior Data Engineer / US / Remote
   → discovers Acme → Greenhouse → source registered

User B · Backend Engineer / US / Remote     → same Acme source, no rediscovery
User C · Software Engineer / Worldwide       → same Acme source, no rediscovery
```

A registered source is queried for **any** demand pattern it can serve. `source_discovery_events` records the pattern that *triggered* discovery, for audit and confound analysis; the source row itself is pattern-agnostic supply. The compounding asset is not "what jobs to fetch" — it is an accumulating **map of where relevant remote employment supply exists**. `demand_pattern_sources` is a convenience index for "which sources are known to serve pattern P", not a restriction on what a source may supply.

### 3.2 Schema (new migration, additive — Gate C1)

```sql
CREATE TABLE sources (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                    text UNIQUE NOT NULL,          -- stable key; used in opportunities.source; [a-z0-9-] only
  source_type             text NOT NULL,                 -- 'provider' | 'ats' | 'discovered_source' | 'employer_direct'
                                                          --   employer_direct is reserved for Layer 3 (§6); not implemented now
  kind                    text NOT NULL,                 -- 'primary_api' | 'ats_board' | 'career_feed' | 'aggregator'
  ats_platform            text,                          -- 'greenhouse' | 'lever' | 'ashby' | ... | null
  employer_name           text,
  endpoint_template       text NOT NULL,                 -- how to fetch; no secrets inline
  acquisition_method      text NOT NULL,                 -- 'http_json' | 'http_html'
  extraction_method       text NOT NULL,                 -- 'native_adapter:greenhouse' | 'llm_assisted'
  supported_fields        text[] NOT NULL DEFAULT '{}',
  auth_requirement        text NOT NULL DEFAULT 'none',   -- 'none' | 'api_key_env:<VARNAME>'
  permission_basis        text NOT NULL,                  -- §7
  -- review / audit trail (mandatory)
  review_status           text NOT NULL DEFAULT 'pending',-- 'pending' | 'approved' | 'rejected'
  reviewed_at             timestamptz,
  reviewed_by             text,
  review_reason           text,
  -- operational lifecycle
  status                  text NOT NULL DEFAULT 'proposed',-- 'proposed' | 'approved' | 'active' | 'paused' | 'retired'
  -- reliability / learning (deterministic code only, §9)
  first_fetch_at          timestamptz,
  last_fetch_attempt_at   timestamptz,
  last_successful_fetch_at timestamptz,
  last_job_seen_at        timestamptz,
  consecutive_fetch_failures int NOT NULL DEFAULT 0,
  lifetime_jobs_ingested  int NOT NULL DEFAULT 0,
  lifetime_jobs_reached_active int NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- The curated employer allowlist (§2 decision). One row per employer; a row
-- may map to one or more `sources` once its ATS endpoint is wired.
CREATE TABLE allowlist_employers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name     text NOT NULL,
  official_domain    text NOT NULL,
  career_url         text NOT NULL,
  ats_provider       text,                 -- 'greenhouse' | 'lever' | 'ashby' | null (unknown yet)
  source_url         text,                 -- the specific ATS board / feed URL
  remote_evidence    text NOT NULL,        -- observable evidence they publish remote roles (link / note)
  geography_evidence text,                 -- observable evidence about where they hire
  review_status      text NOT NULL DEFAULT 'pending',
  reviewed_at        timestamptz,
  reviewed_by        text,
  review_reason      text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_discovery_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id      uuid REFERENCES sources(id),
  demand_pattern jsonb NOT NULL,           -- the gap that triggered discovery
  agent_task     text NOT NULL,            -- 'candidate_proposal' | 'unknown_extraction' | 'manual'
  proposal       jsonb NOT NULL,           -- raw agent output, retained for audit / confound analysis
  decision       text NOT NULL,            -- 'approved' | 'rejected' | 'deferred'
  decided_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE demand_pattern_sources (
  demand_pattern_key text NOT NULL,        -- canonical serialization of the §1.1 tuple
  source_id          uuid REFERENCES sources(id),
  PRIMARY KEY (demand_pattern_key, source_id)
);
```

RLS: all four tables are **service-role only**. No public or authenticated-user access. `opportunities` remains the only publicly readable supply table, unchanged.

### 3.3 Review queue — CLI / script / seed, with an audit trail (no UI in C3)

```
candidate source → review_status='pending' → human review → approved | rejected
```

Approval in C3–D2 happens via a protected admin script, a seed migration, or a direct DB operation — **always** writing `review_status`, `reviewed_at`, `reviewed_by`, `review_reason`. No admin UI is built speculatively. When discovery starts generating enough candidates that manual DB approval is operationally annoying, that annoyance is the trigger to build the queue UI — not before.

### 3.4 Employer eligibility bar (§2 decision)

An employer is eligible for the allowlist iff there is **observable evidence that it publishes remote roles**, preferably via an official career/ATS source. Prioritize employers that: regularly publish remote positions; have an official career/ATS endpoint; have enough role volume to justify integration; have a clear, stable company identity; have a reasonably stable source structure.

The allowlist asserts **"this is a permitted and relevant source of job supply."** It does **not** assert "RemoteMatch recommends this employer" — employer quality is a different product question, out of scope here.

### 3.5 `opportunities.source` becomes extensible (Gate C1, its own reviewed diff)

Phase A hard-codes `source` as the union `'curated' | 'remotive' | 'arbeitnow' | 'jobicy'` in `providers/types.ts`, in `catalog-read.ts`'s `OpportunityRow`, and implicitly in the `/^opp-([a-z]+)-(.+)$/` id regex. Resolving this is a C1 prerequisite:

- Widen `opportunities.source` to text with a check / FK against `sources.slug`.
- Replace the union with a runtime-validated `string` + a generated const list or a registry lookup.
- Audit every `source ===` / `source.startsWith` / id-parse site. The `opp-<source>-<sourceId>` canonical id used across swipes / applications / decision snapshots must keep working for existing rows — slugs stay `[a-z0-9-]`, existing slugs never change.

Touches the read path and provenance; ships as its own reviewed diff with every existing suite passing unchanged.

---

## 4. Discovery workflow

```
1. Demand model emits ranked gap table                          [deterministic, scheduled]
2. Gap above threshold AND no adequate registered source?        [deterministic]
3. Agent Task A: propose candidate sources                       [model, rate-limited, cached, gate D1+]
4. Deterministic validation of each candidate:                   [deterministic]
     - ATS token resolves and returns parseable JSON?
     - robots.txt / terms consistent with a §7 permission basis?
     - not already registered under another slug?
5. Candidate → source_discovery_events(decision='deferred'), enters the review queue
6. Human review: approve / reject / edit         <<< APPROVAL GATE — every source, always, Phases C–D
7. Approved → sources.status='approved'; wire endpoint_template; set permission_basis; write review trail
8. First acquisition run → Phase A machinery (fetch → normalize → dedup → lifecycle)
     - sources.status → 'active' on the first successful fetch yielding ≥1 catalog row
9. demand_pattern_sources row links the triggering pattern to the source
10. Future gaps matching ANY pattern the source can serve find it at step 2 and skip 3–7
```

Steps 1–2, 4, 8–10 are deterministic and mostly reuse Phase A. Step 3 is the only model call. Step 6 is human. Step 10 is the flywheel: discovery cost per pattern is paid once, and the source then serves patterns it was never discovered for (§3.1).

---

## 5. Scale check — instrument now, activate later

Handled like P0 → P1.

**C2 proceeds now, as measurement, not intelligence:**

```
demand pattern → matching active jobs → supply gap → user activity
```

C2 stores the gap table and produces an explicit **dataset-adequacy assessment**. It does not emit supply claims, does not run any agent, does not trigger discovery.

**Automated gap-triggered discovery (gate D3) is gated on an evidence bar:**

- sufficient verified *active* users (recency-weighted, §1.2)
- sufficient distinct active demand patterns
- sufficient observations per pattern
- sufficient *repeat* demand (patterns recurring across time windows, not one-offs)
- sufficient catalog coverage to make "gap" meaningful

**Numeric thresholds are derived from the observed distribution at C2/C4, not invented today.** Until the bar is met, discovery is manual-trigger only (D1) and every source is human-approved.

---

## 6. Layer 3 — direct employers: separate track

```
Additional supply:  RemoteMatch → discovers / fetches → third-party employer source
Employer Direct:    Employer → publishes / manages → RemoteMatch
```

Employer Direct is a marketplace/product capability, not another acquisition adapter. It introduces employer onboarding, employer authentication, posting management, employer UX, moderation, employer agreements, potential commercial relationships, and employer-side analytics. **None of that may contaminate the supply-discovery MVP.**

**Architecturally preserved, not implemented:** `sources.source_type` includes `'employer_direct'` as a reserved value so the catalog, provenance, dedup precedence (§10) and lifecycle can already represent it. Building the Employer Direct product is a separate future roadmap.

---

## 7. Source permission / terms framework

**A source may become `active` only with an explicit, recorded permission basis. "We could fetch it" is never sufficient.**

### 7.1 Allowed `permission_basis` values

| Basis | Meaning | Examples | Constraints |
|---|---|---|---|
| `public_ats_read` | The ATS vendor publishes a documented public job-board read API intended for this | Greenhouse job board API, Lever postings API, Ashby job board API | Respect documented rate limits; real User-Agent + contact URL (Phase A already does this); published listings only |
| `robots_allowed` | An employer career page whose `robots.txt` permits the read paths, no anti-bot, no ToS clause against automated reading of public listings | small company `/careers` pages | Re-check `robots.txt` each run; ≤1 req / few seconds; stop on 429/403 |
| `partner_agreement` | A written agreement with the source (future: Layer 3) | — | Agreement link stored |
| `manual_review` | A human reviewed the source's terms and approved it, with a note | edge cases | Note stored in `source_discovery_events` |

### 7.2 Hard exclusions (never added, regardless of gap pressure)

LinkedIn, Indeed, Glassdoor, ZipRecruiter, Google Jobs, and any source whose ToS prohibits automated access or which runs active bot detection; any source requiring us to accept clickwrap terms (a human must, via `partner_agreement` — the agent may never accept terms); any source behind authentication we don't own; anything requiring CAPTCHA-solving or detection evasion.

### 7.3 Provenance

Every `opportunities` row already carries `source` + `source_id` + `official_url`. The `sources` row adds *how* and *under what basis*; `source_discovery_events` adds *why the source exists*. Together these answer "where did this job come from and were we allowed to take it" for any row.

---

## 8. Acquisition adapters

### 8.1 Interface — unchanged in shape

```ts
interface JobProvider {
  readonly name: string;
  readonly sourceKey: string;      // was a union; becomes a registry slug (§3.5)
  fetchJobs(): Promise<RawJobPayload[]>;
}
```

New adapters are **parameterized by a registry row**, not hard-coded — e.g. one `GreenhouseAdapter` instantiated per approved Greenhouse source with its board token from `endpoint_template`. `catalog-sync.ts`'s fixed `new RemotiveProvider(), …` list becomes "load approved + active sources from the registry, instantiate the right adapter per `ats_platform` / `acquisition_method`."

### 8.2 MVP adapters (Gate C3)

| Adapter | Endpoint shape | Auth | Notes |
|---|---|---|---|
| Greenhouse | `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true` | none | Stable, documented; list + per-job detail |
| Lever | `api.lever.co/v0/postings/{company}?mode=json` | none | Stable, documented; single call, full postings |
| Ashby | `api.ashbyhq.com/posting-api/job-board/{token}` | none | Documented public job-board endpoint |

No proxies, no browser, no rate-limit fragility at our volume. Deliberately the easy 80%.

### 8.3 Adapter requirements

- Timeout + `Promise.allSettled` isolation exactly as Phase A (`runProviderFetches`) — one source failing is a no-op for its rows, never an absence increment.
- Emit `RawJobPayload`; let `normalizeOpportunity` + the catalog state machine do the rest.
- Where the ATS exposes an explicit "closed" flag, map it to the editorial-override `EXPIRED` + `isPermanentlyRemoved` path. Greenhouse and Lever simply drop closed postings from the list → that becomes a feed-absence, already handled by the counter.
- `consecutive_fetch_failures` tracked per `sources` row; crossing a threshold auto-`paused` + surfaced for review (§9.1).

### 8.4 Filtering to remote

ATS boards carry non-remote roles. Adapters pre-filter to remote-eligible listings before emitting, using the same location/tag signals `classifyRemoteEligibility` reads. Borderline cases pass through and are classified downstream as today.

---

## 9. Learning model

**All learning in Phases B–E is deterministic aggregation over data the pipeline already writes. No learned weights, no model.** The registry accrues facts; humans (and later, gated analytics) read them.

### 9.1 Tier 1 — source reliability (from day one of C3)

Per `sources` row, per acquisition run:

- `last_successful_fetch_at`, `consecutive_fetch_failures` → operational health; auto-pause + alert on threshold.
- `lifetime_jobs_ingested`, `lifetime_jobs_reached_active` → `discovery_to_active_rate`. 400 ingested, 3 active → misclassified or junk; flag.
- `last_job_seen_at` → nothing new in N weeks → stale; flag.

Full per-source measurement chain: fetch success → extraction success → active jobs → duplicate rate → availability-pass rate → persistence.

### 9.2 Tier 2 — supply-gap impact

Per pattern, track `effective_supply` over time, annotated when a source is linked. "Did linking source X close the gap for pattern P?" is answerable from the gap table's history — no model.

### 9.3 Tier 3 — outcome-informed source quality (Phase F only, gated)

*Do jobs from source X produce better user outcomes than from source Y?* Join `opportunities.source` → `applications` → `application_events` → `get_application_outcome()`.

**Subject to the exact P1 evidence ladder.** No "source X is better" claim or action below **N=30 outcomes/source** (exploratory); no product action below **N=100/source + two-window replication + a confound check**. Confounds to control for: role-family mix, seniority mix, recency, and whether the source's jobs are simply *fresher* (freshness is handled separately, §11). Until the bar is met, numbers are **reported, never acted on**.

### 9.4 Demand-pattern clustering (Phase E, gated)

Replacing the fixed facet tuple (§1.1) with learned demand clusters becomes meaningful only at volume. Gate: a minimum number of distinct active requirement-holders per candidate cluster. Until then, coarse tuples.

---

## 10. Deduplication

### 10.1 Reuse Phase A's layered dedup

`deduplicateOpportunities()` already does 4 layers — `source:source_id`, canonical URL hash, normalized company+title key, content fingerprint — across the merged output of all successful sources in a cycle, so cross-source dedup already works **within a cycle**.

### 10.2 Gaps discovery introduces, and the fixes (Gate C3)

- **Cross-cycle, cross-source dupes.** Job from Lever in cycle 1, then from an aggregator in cycle 2 with a different `source_id`. Phase A keys existing rows by `(source, source_id)` per source → the second copy inserts as a new row. **Fix:** before insert, probe existing rows by `canonical_url_hash` and `content_hash` across **all** sources; on match, update the existing row and record the extra source in an `opportunity_sources` side table instead of inserting. `official_url` is the strong key — ATS boards and aggregators both link to the same ATS apply URL.
- **Source-of-truth precedence.** `sources.kind`: `primary_api` > `ats_board` > `career_feed` > `aggregator`. The employer-proximate copy wins.
- **Employer identity.** `Acme` / `Acme Inc.` / `Acme, Inc` — normalize on the existing `createNormalizedJobKey` cleaner; extend its strip list only via a reviewed diff.

### 10.3 Not now

No fuzzy / embedding dedup in Phases B–E. The deterministic key set is inspectable with a reason-able false-merge rate. Semantic dedup is a Phase E candidate, gated, only if measured duplicate rate stays high after §10.2.

---

## 11. Freshness integration

**Discovery changes nothing about freshness.** Every job from a discovered source enters the identical lifecycle: `unknown` → immediate first link check → `active | expired`; feed-absence counter (3 successful omissions → `expired`); independent `revalidateStaleLinks()` cadence. `catalog-sync.ts` unchanged. A discovered source's fetch failing is a no-op for its rows.

Freshness (*is this job still open?*), discovery (*where do we find more jobs?*), P1 job-quality (*do observable attributes correlate with outcomes?*), and future source-quality (*which sources yield better outcomes?*) stay **four separate questions with four separate mechanisms — never collapsed into one score.**

Source-aware revalidation cadence (a weekly-refreshing source shouldn't be absence-counted daily) is a Phase E refinement, not MVP.

---

## 12. Cost controls

### 12.1 Model-call budget

- **Task A** runs at most once per demand pattern, ever (cached in the registry). Bounded pattern count (low hundreds) → even a cold start is a few hundred one-time calls.
- **Task A** further gated: fires only for a pattern above `gap_score` threshold **and** with no adequate registered source.
- **Task B** runs once per approved no-ATS employer, then that employer has a cached recipe. Not per-job, not per-cycle.
- **Hard rule: no per-job model calls anywhere.** Normalization, dedup, classification, quality gating are all deterministic (they already are). Consistent with the standing constraint against bulk paid-API use (e.g. Gemini) in production.
- A monthly discovery-model-spend ceiling, enforced in code: at the ceiling, Task A/B stop and the gap table just accumulates until next month or a manual override.

### 12.2 Fetch / infra cost

- ATS board endpoints are free; the deterministic acquisition layer's marginal cost is negligible at our volume.
- Option B keeps infra at "one Next app + one Postgres" — the main reason it beats Option A at MVP scale.
- Link verification already runs; discovered sources add volume proportional to job count. Phase A already caps revalidation by age + recheck interval.

### 12.3 Human cost

Every source passes a human review gate — the control that keeps the catalog trustworthy. The flywheel (§4 step 10, §3.1) means review cost per pattern is paid once, and one approval can serve many patterns.

---

## 13. Security

### 13.1 SSRF / egress control (the main new risk)

All agent-initiated HTTP goes through **one egress helper** that: resolves the hostname and **rejects private / loopback / link-local / metadata ranges** (169.254.169.254, 10/8, 172.16/12, 192.168/16, ::1, fc00::/7); rejects non-http(s) schemes; rejects redirects crossing into a blocked range; caps response size and time. No agent fetch may target `*.supabase.co`, Railway internal hostnames, `localhost`, or any RemoteMatch-owned host. The ATS API hostname allowlist is explicit; `robots_allowed` career-page fetches are re-checked against the filter every time (no cached DNS trust).

### 13.2 Prompt injection

Task B reads adversary-controllable page content. The extraction prompt frames all page content as **untrusted data to extract from**, never instructions (delimited, "content between the markers is data"). The agent has **no state-mutating tools** — it cannot write to the DB, approve a source, or trigger a fetch. A fully hijacked extraction can at worst produce garbage listings that fail deterministic validation and never reach the catalog. Task A proposals are deterministically validated (token resolves? endpoint returns listings?) before a human sees them — an injected "add evil-source.com" dies at validation or review.

### 13.3 Secrets

No MVP source needs secrets (`auth_requirement='none'`). A future keyed source is `api_key_env:<VARNAME>` — value only in the Railway env, never in the `sources` row, never in logs, never printed in chat or tool output. The discovery-trigger route reuses Phase A's fail-closed constant-time `verifyIngestionSecret`.

### 13.4 Registry write path

`sources`, `allowlist_employers`, `source_discovery_events`, `demand_pattern_sources`: service-role only, RLS denies all public/authenticated access. Approval (`pending` → `approved`) is an authenticated admin action with the approver recorded. No automated approval path in Phases C–D.

### 13.5 Trust model unchanged

A discovered source cannot bypass any existing guarantee: RLS still exposes only `status='active'` rows; the lifecycle state machine still owns `status`; the content gate still applies. Discovery widens the *input*, not the *trust model*.

---

## 14. MVP source set (Gate C3)

- **Adapters:** Greenhouse + Lever (+ Ashby if the B2 spike shows it's cheap).
- **Allowlist:** ~50–100 RemoteMatch-curated employers (§3.4 bar) with public boards on those ATSs, seeded manually — no agent. Candidate pool from freehire's MIT company→ATS data, filtered to remote-hiring companies, each row human-reviewed with `remote_evidence` recorded before commit.
- `permission_basis = 'public_ats_read'` for all.
- All flow through the existing Phase A pipeline and lifecycle. Expected effect: live supply roughly 2–3×.
- **No agent, no demand-triggered discovery.** This phase proves adapters + registry + dedup + lifecycle with real ATS data.

The demand model (§1) is built in parallel as **instrumentation only** (Gate C2).

---

## 15. Success metrics

Per the strategy note's §13. **Do not optimize jobs ingested/day.**

**Primary KPI:** *relevant, active jobs per meaningful demand pattern* — `effective_supply(pattern)` for every pattern with non-trivial demand, and the count of patterns below `target_supply`.

| Secondary metric | Definition | Watch for |
|---|---|---|
| Supply-gap reduction | Σ `gap_score` over time | should trend down as discovery runs |
| Discovery-to-active rate | catalog `active` ÷ ingested, per source | low → misclassification or junk source |
| Duplicate rate | dupes caught ÷ total ingested | rising → dedup keys need work (§10) |
| Availability-pass rate | still `active` after first link check + first revalidation | low → source lists dead jobs |
| Source coverage | # `active` sources; # ATS platforms | growth without gap reduction = wrong sources |
| Time: demand → new source | gap first observed → source `approved` | review-queue latency |
| Time: source `approved` → first `active` job | adapter / pipeline latency | |
| Source reliability | `consecutive_fetch_failures`, staleness flags | operational |
| (Phase F, gated) application / interview / offer rate by source | P0/P1 join, evidence ladder | the real long-term signal |

**Explicit non-goal:** total catalog size. A larger catalog of irrelevant jobs is a regression.

---

## 16. Implementation sequence and approval gates

Each gate is a separate, explicit go-ahead. No gate authorizes the next. Every code change ships as a reviewed diff (`git add -N` → full diff shared → review → commit). Nothing starts before B2 completes; **C1 implementation does not begin until the B2 spike confirms Option B**.

| Gate | Deliverable | Type | Exit criteria |
|---|---|---|---|
| **B1** | This spec, Review 1 | doc | **Approved.** Architecture, boundaries, principles, and the six decisions locked. |
| **B2** | Acquisition spike | spike + memo | Produce: freehire ATS-catalogue extraction; license verification; endpoint-coverage summary; Greenhouse/Lever/Ashby sample extraction; normalized-output comparison against `CanonicalOpportunity`; estimated porting effort; estimated maintenance burden. **Then** confirm Option B (or, if the spike disproves the single-deploy advantage, escalate for a fresh decision). |
| **C1** | Source registry migration (§3.2) + `allowlist_employers` + widen `opportunities.source` (§3.5) + audit every `source`-parsing site | migration + refactor | `tsc` clean; all existing suites pass unchanged (verification, monetization, seo-audit, outcome-lifecycle, live-supply, p1-job-quality); reviewed diff; deployed; RLS verified via a live check |
| **C2** | Demand model (§1) — instrumentation only | feature | Gap table populates from real data; recency + signal weights and `target_supply` constants recorded in an addendum from the observed distribution; **explicit dataset-adequacy assessment**; no downstream consumer; no supply claims |
| **C3** | 2–3 ATS adapters (§8.2) + ~50–100 curated employers (§14) + registry-driven sync loop + cross-source dedup (§10.2) | feature | Real ATS jobs through the Phase A lifecycle; dedup verified against real cross-source overlap; a dedicated suite mirroring `live-supply-suite.ts` discipline; live supply measurably up; reviewed diff |
| **C4** | Tier 1 source-reliability aggregation (§9.1) + auto-pause + review surfacing | feature | Registry rows accrue health facts; a source can be paused and resumed; verified with a deliberately-broken source; distribution data feeds the §5 threshold-setting |
| **D1** | Demand-driven Source Discovery Agent (Task A, §2.1), **manual trigger only**; SSRF egress helper (§13.1); CLI review flow (§3.3) | feature | A human triggers discovery for one gap, sees validated candidates, approves/rejects; nothing auto-activates; prompt-injection + SSRF tests pass |
| **D2** | Source learning (§3.1) | feature | Approved sources persist as pattern-agnostic knowledge; a second, different demand pattern demonstrably reuses an existing source with no rediscovery |
| **D3** | Gap-triggered discovery | feature | **Only after C2/C4 evidence meets the §5 bar.** Discovery fires from the gap table on schedule; monthly model-spend ceiling enforced; every source still human-approved |
| **D4** | Task B — unknown-structure extraction (§2.2) | feature | Only if a real approved employer has no known ATS; hijacked-extraction test proves it cannot reach the catalog |
| **E** | Source optimization (§9.2), source-aware freshness cadence (§11), demand-pattern clustering if volume supports it (§9.4) | features | each its own gate |
| **F** | Outcome-informed source quality (§9.3) — P0/P1 join, full evidence ladder, reported before acted on | feature | N≥30/source exploratory reporting; no action without N≥100/source + two-window replication + confound check |

**Frozen contracts, restated:** matching, scoring, `computeQualityScore()`, swipe mechanics, monetization/quota, SEO architecture, the auth invariant, and the P0/P1 outcome contracts are out of scope for every gate above unless a later evidence-based decision explicitly reopens one.

---

## 17. Resolved decisions and remaining unknowns

**Resolved (Review 1):** the six questions in the Decision Summary.

**Deliberately deferred, to be set from data — not open questions, but flagged so they aren't forgotten:**

1. Recency half-life and signal base-weights for `demand_weight` (§1.2) — set at C2 from observed return-visit behaviour.
2. `base`, `demand_factor`, `min_target`, `max_target` for `target_supply` (§1.4) — set at C2 from the observed `demand_weight` distribution.
3. The §5 evidence-bar thresholds for enabling D3 — derived at C2/C4 from the observed pattern/observation distribution.
4. `consecutive_fetch_failures` auto-pause threshold, and the "stale source" week count (§9.1) — set at C4.
5. Monthly discovery-model-spend ceiling (§12.1) — set before D1.

Each is recorded in the C2/C4 addenda with its rationale when set, not silently tuned afterward.
