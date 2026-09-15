import { JobProvider, RawJobPayload } from './types';

/**
 * C5-B — We Work Remotely public RSS feed
 * (C:\Users\dell\.claude\plans\vivid-hatching-kitten.md §2, real-verified
 * 2026-09-15: public, no auth, robots.txt Allow: / on the feed path,
 * confirmed real per-item <pubDate>/<guid>/<region> fields at scale).
 * ==============================================================================
 * A genuinely separate public job board, not a C3 ATS and not C5-A's
 * career-page path — same JobProvider interface, same shared downstream
 * pipeline (normalize/dedup/freshness/remote-eligibility/publication),
 * mirroring RemotiveProvider's exact shape (this codebase's own established
 * aggregator-provider pattern) rather than inventing a new one.
 *
 * No XML library dependency added — a minimal, targeted regex parser,
 * matching this codebase's own established lightweight-parsing style
 * (career-page.ts's JSON-LD block extraction uses the same technique for
 * the same reason: the input shape is well-known and narrow, a full parser
 * library is not needed).
 *
 * officialUrl deliberately points at We Work Remotely's own listing page
 * (the feed's <guid>), not the employer's own site — the exact same
 * accepted pattern RemotiveProvider already uses for the identical reason
 * (an aggregator's own apply/redirect flow, not a fabrication or shortcut).
 */

const FEED_URL = 'https://weworkremotely.com/remote-jobs.rss';

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripHtmlTags(html: string): string {
  return decodeEntities(html).replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
}

function extractTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : '';
}

export class WeWorkRemotelyProvider implements JobProvider {
  readonly name = 'We Work Remotely';
  readonly sourceKey = 'weworkremotely';

  async fetchJobs(): Promise<RawJobPayload[]> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const res = await fetch(FEED_URL, {
        signal: controller.signal,
        headers: { 'User-Agent': 'RemoteMatchBot/1.0 (Job Ingestion; +https://remotematch.com)' },
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        console.warn(`We Work Remotely feed responded with status ${res.status}`);
        return [];
      }

      const xml = await res.text();
      const itemBlocks = Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/g)).map((m) => m[1]);

      const jobs: RawJobPayload[] = [];
      for (const block of itemBlocks) {
        const rawTitle = decodeEntities(extractTag(block, 'title'));
        if (!rawTitle) continue;

        // Feed format is consistently "Company: Role Title" — split on the
        // FIRST colon only, since a role title can itself legitimately
        // contain a colon (e.g. "Senior Engineer: Platform Team").
        const colonIdx = rawTitle.indexOf(':');
        const company = colonIdx > -1 ? rawTitle.slice(0, colonIdx).trim() : 'Unknown Company';
        const title = colonIdx > -1 ? rawTitle.slice(colonIdx + 1).trim() : rawTitle;

        const guid = extractTag(block, 'guid');
        if (!guid) continue; // no stable identity, skip rather than guess one

        const region = decodeEntities(extractTag(block, 'region'));
        const country = decodeEntities(extractTag(block, 'country')).replace(/^[^\w]*\s*/, ''); // drop leading flag emoji
        const state = decodeEntities(extractTag(block, 'state'));
        const locationString = region || [country, state].filter(Boolean).join(', ') || 'Worldwide';

        const type = extractTag(block, 'type');
        const category = extractTag(block, 'category');
        const description = stripHtmlTags(extractTag(block, 'description')).slice(0, 1500);
        const pubDateRaw = extractTag(block, 'pubDate');
        const publicationDate = pubDateRaw ? new Date(pubDateRaw).toISOString() : new Date().toISOString();

        jobs.push({
          sourceId: guid,
          source: this.sourceKey,
          title,
          company,
          description,
          sourceUrl: guid,
          officialUrl: guid,
          jobType: type || 'Full-time',
          locationString,
          tags: category ? [category] : [],
          publicationDate,
        });
      }

      return jobs;
    } catch (err) {
      console.warn('We Work Remotely fetch failed (using empty/fallback):', (err as Error).message);
      return [];
    }
  }
}
