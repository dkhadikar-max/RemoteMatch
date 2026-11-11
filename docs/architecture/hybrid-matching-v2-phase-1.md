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
