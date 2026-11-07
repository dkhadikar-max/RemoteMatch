/**
 * RemoteMatch — sitemap XML serialisation (pure)
 * ==============================================================================
 * Next's metadata-route serialiser (`resolveSitemap`, next/dist/build/webpack/loaders/metadata/resolve-route-data) writes `<loc>`
 * verbatim — it does not escape `&`, `<`, `>` — and throws on an invalid `lastModified` Date. This module produces the SAME bytes as
 * that serialiser for ordinary input (test/sitemap-chunk-suite.ts compares them against Next's own function), and differs only
 * where Next's output would be invalid XML or would throw:
 *   - the five XML predefined entities are escaped in every text value (loc, lastmod, changefreq);
 *   - an invalid Date is omitted instead of throwing (one bad `posted_at` must not 500 the whole sitemap).
 * Everything here is deterministic and free of I/O.
 */

/** The subset of Next's MetadataRoute.Sitemap entry this app uses. */
export interface SitemapUrlEntry {
  url: string;
  lastModified?: string | Date;
  changeFrequency?: string;
  priority?: number;
}

export interface SitemapIndexEntry {
  url: string;
  lastModified?: string | Date;
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';
const URLSET_OPEN = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
const URLSET_CLOSE = '</urlset>\n';
const INDEX_OPEN = '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
const INDEX_CLOSE = '</sitemapindex>\n';

/** Escapes the five XML predefined entities. `&` first, so the others are not double-escaped. */
export function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** ISO-8601 text for a date value, or null when it is missing/invalid (so the element is omitted). */
function dateText(value: string | Date | undefined): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return String(value);
}

/** One `<url>` element, byte-identical to Next's serialiser for input that needs no escaping. */
export function serializeUrlEntry(entry: SitemapUrlEntry): string {
  let out = '<url>\n';
  out += `<loc>${escapeXml(entry.url)}</loc>\n`;
  const lastmod = dateText(entry.lastModified);
  if (lastmod !== null) out += `<lastmod>${escapeXml(lastmod)}</lastmod>\n`;
  if (entry.changeFrequency) out += `<changefreq>${escapeXml(entry.changeFrequency)}</changefreq>\n`;
  if (typeof entry.priority === 'number') out += `<priority>${entry.priority}</priority>\n`;
  out += '</url>\n';
  return out;
}

/** Bytes a urlset document adds around its entries (declaration + root open/close). */
export const URLSET_OVERHEAD_BYTES = Buffer.byteLength(XML_DECLARATION + URLSET_OPEN + URLSET_CLOSE, 'utf8');

export function serializeUrlset(entries: readonly SitemapUrlEntry[]): string {
  let out = XML_DECLARATION + URLSET_OPEN;
  for (const e of entries) out += serializeUrlEntry(e);
  return out + URLSET_CLOSE;
}

export function serializeSitemapIndex(items: readonly SitemapIndexEntry[]): string {
  let out = XML_DECLARATION + INDEX_OPEN;
  for (const it of items) {
    out += '<sitemap>\n';
    out += `<loc>${escapeXml(it.url)}</loc>\n`;
    const lastmod = dateText(it.lastModified);
    if (lastmod !== null) out += `<lastmod>${escapeXml(lastmod)}</lastmod>\n`;
    out += '</sitemap>\n';
  }
  return out + INDEX_CLOSE;
}
