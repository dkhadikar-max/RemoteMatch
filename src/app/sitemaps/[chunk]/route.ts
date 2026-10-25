import { getSitemapEntries } from '@/lib/seo/sitemap-data';
import { respondSitemapChunk } from '@/lib/seo/sitemap-chunks';

// /sitemaps/{n}.xml: chunk n of the sitemap, served only while /sitemap.xml is a <sitemapindex>. 404 for a malformed name
// (`abc.xml`, `01.xml`, `0`), an out-of-range chunk, or while everything still fits in the single /sitemap.xml.
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ chunk: string }> }) {
  const { chunk } = await params;
  return respondSitemapChunk(getSitemapEntries, chunk);
}
