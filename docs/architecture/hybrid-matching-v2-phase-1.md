# Hybrid Matching V2 — Phase 1

## Scope

This branch introduces a conservative canonical skill vocabulary and a shadow-only hybrid candidate retriever. The existing production scorer, eligibility gate, fit-score weights, feed route and behavioral personalization remain unchanged.

## What is implemented

- Canonicalizes vetted spelling/abbreviation variants (for example Node.js/Node JS, Golang/Go, K8s/Kubernetes, JS/JavaScript and TS/TypeScript).
- Keeps related-but-distinct skills separate (for example Java/JavaScript, SQL/PostgreSQL and React/Frontend).
- Generates independently inspectable retrieval evidence from exact canonical skill overlap, target-role/title overlap and weighted BM25-like lexical relevance.
- Preserves the complete candidate set by default. A top-K limit or minimum score is opt-in only.
- Uses stable input-order tie breaking and returns original indexes for shadow parity comparisons.

## Explicit limitation

This is hybrid lexical/taxonomy retrieval, not embedding-based semantic retrieval. No embeddings, vector extension, external model calls or production schema changes are introduced. True semantic retrieval requires an evaluated embedding model, a vector index, a versioned job/profile embedding pipeline, stale-embedding handling, and offline/online relevance evaluation. It should be a separate phase after this branch's taxonomy and candidate-recall tests pass.

## Rollout contract

- Do not wire this retriever into the production feed yet.
- Compare its candidate evidence and ordered results against the frozen legacy engine on a representative profile/job corpus.
- Require no loss of legacy top-K candidates before enabling any candidate limit.
- Track Recall@50, NDCG@10, Precision@10, p50/p95 latency and application/interview outcomes.


## Offline relevance evaluation (required before rollout)

A reusable evaluator is available at `test/evaluate-hybrid-retrieval.ts`. It runs the frozen production baseline (`scoreOpportunitiesForFeed`) and the shadow retriever against the same profile and candidate set, then reports macro-averaged and per-case:

- Precision@10, Recall@50 and binary NDCG@10 for both systems and the hybrid-minus-legacy delta.
- Legacy top-10 candidate coverage inside the hybrid top 50 (a candidate-retention guard).
- Top-10 Jaccard parity and candidate/relevant-set sizes.

Run it with a reviewed, de-identified dataset:

```bash
npx tsx test/evaluate-hybrid-retrieval.ts test/fixtures/hybrid-retrieval-evaluation.json
```

The expected dataset shape is `{ version, description, cases }`; each case contains a stable `id`, a complete `profile`, the identical `opportunities` candidate set for both rankers, and non-empty `relevantOpportunityIds` judged by a human or a documented adjudication process. The empty `test/fixtures/hybrid-retrieval-evaluation.template.json` is a schema placeholder only; it is not a benchmark corpus.

Do not treat synthetic fixtures, unjudged application clicks, or the hybrid system's own predictions as relevance labels. Recommended minimum: 30 independent profile/query cases, at least 200 judged relevant pairs overall, and representation across target-role families, skill-density bands and geographic eligibility patterns. Report macro metrics and per-case regressions; bootstrap confidence intervals should be added when the corpus is large enough. A positive aggregate delta alone is not sufficient: inspect every legacy top-10 item absent from hybrid top 50 and require a documented reason for any loss.

### Current evaluation status

No reviewed relevance-judgment corpus is present in this repository or available from the isolated integration database. Therefore no defensible Recall@50, NDCG@10 or Precision@10 comparison can yet be claimed. The evaluator and dataset contract are now in place; metric generation is blocked on supplying the reviewed labels. This is an evidence gap, not a passing evaluation.

