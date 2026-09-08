import type { MetadataRoute } from 'next';
import { SEO_CATEGORIES, SEO_GUIDE_ARTICLES, getActiveJobs } from '@/lib/seo/data';
import { createSupabasePublicClient } from '@/lib/supabase/server';

// Sitemap content is identical for every visitor (RLS's active-only filter
// is the only access control it needs) and must reflect the live catalog,
// not a build-time snapshot — force-dynamic makes that explicit rather than
// leaning on cookies() usage to infer it (see createSupabasePublicClient()'s
// doc comment for why this route uses that client instead of the
// cookie-bound one).
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = 'https://remotematch.com';
  const supabase = createSupabasePublicClient();
  const activeJobs = supabase ? await getActiveJobs(supabase) : [];

  // Determine latest content change date for directory and home. `postedAt`
  // is the closest available "last known change" fact on CanonicalOpportunity
  // — the old `updatedAt` field was RawJobPayload-specific and never
  // persisted (Live Supply Activation).
  const latestJobDate = activeJobs.reduce((latest, j) => {
    const d = new Date(j.postedAt);
    return d > latest ? d : latest;
  }, new Date('2026-03-01T00:00:00Z'));

  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: `${baseUrl}`,
      lastModified: latestJobDate,
      changeFrequency: 'daily',
      priority: 1.0,
    },
    {
      url: `${baseUrl}/remote-jobs`,
      lastModified: latestJobDate,
      changeFrequency: 'daily',
      priority: 0.9,
    },
    {
      url: `${baseUrl}/guide`,
      lastModified: new Date('2026-03-08T00:00:00Z'),
      changeFrequency: 'weekly',
      priority: 0.8,
    },
  ];

  const categoryRoutes: MetadataRoute.Sitemap = SEO_CATEGORIES.map((cat) => {
    // Find latest job in category
    const catJobs = activeJobs.filter((j) => {
      const slugLower = cat.slug.replace('-', ' ');
      const titleLower = j.title.toLowerCase();
      const skillsLower = (j.requiredSkills || []).map((t) => t.toLowerCase());
      return cat.tags.some((t) => skillsLower.includes(t.toLowerCase())) || titleLower.includes(slugLower);
    });
    const catDate = catJobs.reduce((latest, j) => {
      const d = new Date(j.postedAt);
      return d > latest ? d : latest;
    }, latestJobDate);

    return {
      url: `${baseUrl}/remote-jobs/${cat.slug}`,
      lastModified: catDate,
      changeFrequency: 'daily',
      priority: 0.85,
    };
  });

  // Only index actively available jobs (expired jobs strictly excluded —
  // guaranteed by getActiveJobs()'s RLS-backed read, not by filtering here)
  const jobRoutes: MetadataRoute.Sitemap = activeJobs.map((job) => ({
    url: `${baseUrl}/remote-jobs/view/${job.sourceId}`,
    lastModified: new Date(job.postedAt),
    changeFrequency: 'weekly',
    priority: 0.75,
  }));

  const guideRoutes: MetadataRoute.Sitemap = SEO_GUIDE_ARTICLES.map((article) => ({
    url: `${baseUrl}/guide/${article.slug}`,
    lastModified: new Date(article.publishedDate),
    changeFrequency: 'monthly',
    priority: 0.7,
  }));

  return [...staticRoutes, ...categoryRoutes, ...jobRoutes, ...guideRoutes];
}
