import type { MetadataRoute } from 'next';
import { SEO_CATEGORIES, SEO_GUIDE_ARTICLES, getActiveJobs } from '@/lib/seo/data';

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = 'https://remotematch.com';
  const activeJobs = getActiveJobs();

  // Determine latest content change date for directory and home
  const latestJobDate = activeJobs.reduce((latest, j) => {
    const d = new Date(j.updatedAt || j.publicationDate);
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
      const tagsLower = (j.tags || []).map((t) => t.toLowerCase());
      return cat.tags.some((t) => tagsLower.includes(t.toLowerCase())) || titleLower.includes(slugLower);
    });
    const catDate = catJobs.reduce((latest, j) => {
      const d = new Date(j.updatedAt || j.publicationDate);
      return d > latest ? d : latest;
    }, latestJobDate);

    return {
      url: `${baseUrl}/remote-jobs/${cat.slug}`,
      lastModified: catDate,
      changeFrequency: 'daily',
      priority: 0.85,
    };
  });

  // Only index actively available jobs (expired jobs strictly excluded)
  const jobRoutes: MetadataRoute.Sitemap = activeJobs.map((job) => ({
    url: `${baseUrl}/remote-jobs/view/${job.sourceId}`,
    lastModified: new Date(job.updatedAt || job.publicationDate),
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
