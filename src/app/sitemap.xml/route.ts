import { getSitemapEntries } from '@/lib/seo/sitemap-data';
import { respondSitemapRoot } from '@/lib/seo/sitemap-chunks';

// /sitemap.xml: the plain <urlset> while every URL fits in one file below the per-file limits, otherwise a <sitemapindex> of
// /sitemaps/{n}.xml chunks (src/app/sitemaps/[chunk]/route.ts). This is a route handler, NOT a `sitemap.ts` metadata file: Next
// 14.2.35 builds both without complaint but the metadata file silently wins the URL (test/sitemap-chunk-suite.ts guards that).
// Always live — never a build-time snapshot, never an empty list on a failed read (a failure with no usable cache throws -> 500).
export const dynamic = 'force-dynamic';

export async function GET() {
  return respondSitemapRoot(getSitemapEntries);
}
