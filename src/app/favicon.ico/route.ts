import { NextResponse } from 'next/server';

const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="16" fill="#123B3A"/>
  <path d="M13 46V18h8l11 14 11-14h8v28h-9V31L32 44 22 31v15z" fill="#F7B7A5"/>
  <circle cx="50" cy="14" r="5" fill="#69D1C5"/>
</svg>`;

export function GET() {
  return new NextResponse(icon, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
    },
  });
}
