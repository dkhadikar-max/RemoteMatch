import assert from 'node:assert/strict';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSitemapJobEntries } from '../src/lib/ingestion/catalog-read';

type Args = { p_after_source: string | null; p_after_source_id: string | null; p_page_size: number };
type Row = { source: string; source_id: string; title: string; posted_at: string; required_skills: string[] | null };

function fakeClient(handler: (args: Args) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>): SupabaseClient {
  return { rpc: async (_name: string, args: Args) => handler(args) } as unknown as SupabaseClient;
}

const row: Row = {
  source: 'greenhouse',
  source_id: 'greenhouse-test-1',
  title: 'Test engineer',
  posted_at: '2026-11-10T00:00:00.000Z',
  required_skills: ['TypeScript'],
};

async function main() {
  console.log('Sitemap reader adaptive timeout retry suite');

  {
    const calls: Args[] = [];
    const client = fakeClient(async (args) => {
      calls.push(args);
      if (args.p_page_size === 1000) return { data: null, error: { code: '57014', message: 'statement timeout' } };
      return { data: [row], error: null };
    });
    const entries = await getSitemapJobEntries(client);
    assert.deepEqual(calls.map((c) => c.p_page_size), [1000, 500]);
    assert.deepEqual(entries, [{
      sourceId: row.source_id,
      title: row.title,
      postedAt: row.posted_at,
      requiredSkills: ['TypeScript'],
    }]);
  }

  {
    const calls: Args[] = [];
    const firstPage: Row[] = Array.from({ length: 1000 }, (_, index) => ({
      ...row,
      source_id: `greenhouse-test-${String(index).padStart(4, '0')}`,
    }));
    const client = fakeClient(async (args) => {
      calls.push(args);
      if (args.p_after_source === null) return { data: firstPage, error: null };
      if (args.p_page_size === 1000) return { data: null, error: { code: '57014', message: 'statement timeout' } };
      return { data: [row], error: null };
    });
    const entries = await getSitemapJobEntries(client);
    assert.equal(entries.length, 3001);
    assert.deepEqual(calls.map((c) => c.p_page_size), [1000, 1000, 500]);
    assert.equal(calls[1].p_after_source, 'greenhouse');
    assert.equal(calls[1].p_after_source_id, 'greenhouse-test-0999');
    assert.equal(calls[2].p_after_source, calls[1].p_after_source,
      'retry must retain the source cursor of the failed page');
    assert.equal(calls[2].p_after_source_id, calls[1].p_after_source_id,
      'retry must retain the source_id cursor of the failed page');
  }

  {
    const calls: Args[] = [];
    const client = fakeClient(async (args) => {
      calls.push(args);
      if (args.p_page_size > 25) return { data: null, error: { code: '57014', message: 'statement timeout' } };
      return { data: [row], error: null };
    });
    await getSitemapJobEntries(client);
    assert.deepEqual(calls.map((c) => c.p_page_size), [1000, 500, 250, 125, 62, 31, 25]);
  }

  {
    let calls = 0;
    const client = fakeClient(async () => {
      calls += 1;
      return { data: null, error: { code: '42501', message: 'permission denied' } };
    });
    await assert.rejects(() => getSitemapJobEntries(client), /permission denied/);
    assert.equal(calls, 1, 'non-timeout errors must not be retried');
  }

  console.log('Sitemap reader adaptive timeout retry suite passed: 1,000->500 fallback, bounded reduction to 25, second-page cursor preservation, and non-timeout fail-fast.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
