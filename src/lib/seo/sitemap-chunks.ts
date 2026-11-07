/**
 * RemoteMatch — sitemap splitting (pure)
 * ==============================================================================
 * One sitemap file may hold at most 50,000 URLs and 50 MB uncompressed (sitemaps.org/protocol.html). The catalog is growing by
 * ~4.5k URLs a day, so `/sitemap.xml` becomes a `<sitemapindex>` pointing at `/sitemaps/{n}.xml` chunks as soon as the URL list
 * would no longer fit in ONE file that stays below MAX_URLS_PER_FILE URLs and MAX_BYTES_PER_FILE bytes. Below that, `/sitemap.xml`
 * stays a plain `<urlset>` exactly as before and `/sitemaps/{n}.xml` answers 404.
 *
 * The URL list itself (eligibility, order) is NOT decided here — it is whatever buildSitemap() produced, in that order. Chunks are
 * consecutive slices of it, so the first chunk carries the static/hub URLs first. Chunk membership is positional: it moves when
 * URLs are inserted ahead of a boundary (the order is (source, source_id)); that trade-off is deliberate and documented in the PR.
 */
import { SITE_URL } from '@/lib/site';
import { serializeSitemapIndex, serializeUrlEntry, serializeUrlset, URLSET_OVERHEAD_BYTES, type SitemapIndexEntry, type SitemapUrlEntry } from '@/lib/seo/sitemap-xml';

/** Every sitemap file stays BELOW 45,000 URLs (the protocol allows 50,000). */
export const MAX_URLS_PER_FILE = 44_999;
/** Every sitemap file stays well under the 50 MB (52,428,800-byte) limit. */
export const MAX_BYTES_PER_FILE = 45 * 1024 * 1024;
/** Path prefix of the chunk files. */
export const CHUNK_PATH_PREFIX = '/sitemaps';

export const SITEMAP_RESPONSE_HEADERS = {
  'Content-Type': 'application/xml; charset=utf-8',
  // What Next's built-in sitemap route sent before: always revalidate (the data is cached in-process, see sitemap-data.ts).
  'Cache-Control': 'public, max-age=0, must-revalidate',
} as const;

export interface SplitOptions {
  maxUrls?: number;
  maxBytes?: number;
  siteUrl?: string;
}

/** Keeps the first occurrence of every URL (a URL may appear once per sitemap); order is preserved. */
export function dedupeByUrl<T extends { url: string }>(entries: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of entries) {
    if (seen.has(e.url)) continue;
    seen.add(e.url);
    out.push(e);
  }
  return out;
}

/** `0.xml`, `12.xml` -> number; anything else (`01.xml`, `abc.xml`, `0`, `-1.xml`, `1.5.xml`, `0.XML`) -> null. */
export function parseChunkParam(param: unknown): number | null {
  if (typeof param !== 'string') return null;
  const m = /^(0|[1-9][0-9]*)\.xml$/.exec(param);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

const planCache = new WeakMap<readonly SitemapUrlEntry[], [number, number][]>();

/**
 * Consecutive [start, end) ranges, each holding at most `maxUrls` entries and serialising to at most `maxBytes` bytes (document
 * overhead included). A single entry larger than the byte budget still gets a range of its own. Always at least one range.
 */
export function planChunks(entries: readonly SitemapUrlEntry[], maxUrls = MAX_URLS_PER_FILE, maxBytes = MAX_BYTES_PER_FILE): [number, number][] {
  const isDefault = maxUrls === MAX_URLS_PER_FILE && maxBytes === MAX_BYTES_PER_FILE;
  if (isDefault) { const hit = planCache.get(entries); if (hit) return hit; }
  const ranges: [number, number][] = [];
  let start = 0, bytes = URLSET_OVERHEAD_BYTES;
  for (let i = 0; i < entries.length; i++) {
    const size = Buffer.byteLength(serializeUrlEntry(entries[i]), 'utf8');
    const full = i - start >= maxUrls || (i > start && bytes + size > maxBytes);
    if (full) { ranges.push([start, i]); start = i; bytes = URLSET_OVERHEAD_BYTES; }
    bytes += size;
  }
  ranges.push([start, entries.length]);
  if (isDefault) planCache.set(entries, ranges);
  return ranges;
}

/** Newest valid `lastModified` among the entries, or undefined when none has one. */
export function newestLastModified(entries: readonly SitemapUrlEntry[]): Date | undefined {
  let best: Date | undefined;
  for (const e of entries) {
    if (e.lastModified === undefined || e.lastModified === '') continue;
    const d = e.lastModified instanceof Date ? e.lastModified : new Date(e.lastModified);
    if (Number.isNaN(d.getTime())) continue;
    if (!best || d > best) best = d;
  }
  return best;
}

export interface SitemapRoot {
  kind: 'urlset' | 'index';
  xml: string;
  /** number of sitemap files behind this URL (1 for a plain urlset) */
  fileCount: number;
}

/** The document served at `/sitemap.xml`: the plain urlset while it fits in one file, otherwise the index. */
export function renderSitemapRoot(entries: readonly SitemapUrlEntry[], opts: SplitOptions = {}): SitemapRoot {
  const ranges = planChunks(entries, opts.maxUrls, opts.maxBytes);
  if (ranges.length === 1) return { kind: 'urlset', xml: serializeUrlset(entries), fileCount: 1 };
  const base = opts.siteUrl ?? SITE_URL;
  const items: SitemapIndexEntry[] = ranges.map(([a, b], i) => ({ url: `${base}${CHUNK_PATH_PREFIX}/${i}.xml`, lastModified: newestLastModified(entries.slice(a, b)) }));
  return { kind: 'index', xml: serializeSitemapIndex(items), fileCount: ranges.length };
}

/** The document served at `/sitemaps/{param}`; null (-> 404) when the root is not an index, the param is malformed or out of range. */
export function renderSitemapChunk(entries: readonly SitemapUrlEntry[], param: unknown, opts: SplitOptions = {}): string | null {
  const n = parseChunkParam(param);
  if (n === null) return null;
  const ranges = planChunks(entries, opts.maxUrls, opts.maxBytes);
  if (ranges.length === 1 || n >= ranges.length) return null;
  const [a, b] = ranges[n];
  return serializeUrlset(entries.slice(a, b));
}

/** The HTTP response for `/sitemap.xml`. `load` is injected so the handlers can be exercised without a database. */
export async function respondSitemapRoot(load: () => Promise<readonly SitemapUrlEntry[]>, opts: SplitOptions = {}): Promise<Response> {
  const { xml } = renderSitemapRoot(await load(), opts);
  return new Response(xml, { headers: SITEMAP_RESPONSE_HEADERS });
}

/** The HTTP response for `/sitemaps/{param}`: 404 (plain text) whenever there is no such chunk. */
export async function respondSitemapChunk(load: () => Promise<readonly SitemapUrlEntry[]>, param: unknown, opts: SplitOptions = {}): Promise<Response> {
  const xml = renderSitemapChunk(await load(), param, opts);
  if (xml === null) return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return new Response(xml, { headers: SITEMAP_RESPONSE_HEADERS });
}
