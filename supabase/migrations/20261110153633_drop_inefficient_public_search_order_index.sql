-- Replace the non-covering order index with an index that can evaluate country predicates without fetching every heap row.
DROP INDEX IF EXISTS public.idx_opportunities_public_search_order;
