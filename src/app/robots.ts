import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: [
          '/',
          '/remote-jobs',
          '/remote-jobs/*',
          '/guide',
          '/guide/*',
          '/remotematch-indexnow-key.txt',
        ],
        disallow: [
          '/feed',
          '/match/*',
          '/onboarding',
          '/tracker',
          '/settings',
          '/staging',
          '/api/*',
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
