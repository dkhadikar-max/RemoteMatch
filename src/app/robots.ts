import type { MetadataRoute } from 'next';

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
    sitemap: 'https://remotematch.com/sitemap.xml',
  };
}
