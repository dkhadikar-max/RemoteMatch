-- Register RemoteOK before catalog-sync attempts to persist its feed rows.
-- The provider has been enabled in catalog-sync.ts, but the source registry
-- is also the FK target for opportunities.source. Without this row every
-- fetched RemoteOK posting is skipped as unregistered.
INSERT INTO public.supply_platforms (slug, display_name, source_type, kind)
VALUES ('remoteok', 'RemoteOK', 'provider', 'aggregator')
ON CONFLICT (slug) DO UPDATE
SET display_name = EXCLUDED.display_name,
    source_type = EXCLUDED.source_type,
    kind = EXCLUDED.kind;
