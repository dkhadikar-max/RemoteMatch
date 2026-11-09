import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';

const PORT = Number(process.env.PORT ?? 3001);
const API_BASE = (process.env.REMOTEMATCH_API_BASE_URL ?? 'https://remotematch.online').replace(/\/$/, '');
const MCP_PATH = '/mcp';
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = '256kb';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: MAX_BODY_BYTES }));

type ApiError = { success?: boolean; error?: string };
type SearchResult = {
  success: boolean;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  opportunities: Array<Record<string, unknown>>;
};
type JobResult = { success: boolean; opportunity?: Record<string, unknown>; error?: string };

const searchInput = {
  query: z.string().trim().max(160).optional().describe('Keywords, job title, company, or phrase.'),
  skills: z.array(z.string().trim().min(1).max(60)).max(10).optional().describe('Required or preferred skills; all supplied skills must match.'),
  country: z.string().trim().max(80).optional().describe('Candidate country, e.g. India, Germany, United States.'),
  remoteType: z.string().trim().max(60).optional().describe('Remote scope, e.g. Worldwide, India, US, EU/EEA.'),
  employmentType: z.string().trim().max(40).optional().describe('Employment type, e.g. Full-time, Contract, Freelance, Part-time.'),
  experience: z.string().trim().max(40).optional().describe('Experience tier, e.g. 2-3, 4-6, 7-10, 10+.'),
  minSalary: z.number().finite().min(0).max(1_000_000_000).optional().describe('Minimum disclosed salary in the selected salary currency.'),
  salaryCurrency: z.string().trim().max(8).optional().describe('Salary currency code, e.g. INR, USD, EUR.'),
  limit: z.number().int().min(1).max(25).optional().describe('Page size, maximum 25.'),
  offset: z.number().int().min(0).max(100_000).optional().describe('Zero-based pagination offset.')
};

function toolResult(data: unknown) {
  const serialized = JSON.stringify(data);
  return {
    content: [{ type: 'text' as const, text: serialized }],
    structuredContent: data as unknown as Record<string, unknown>,
  };
}

async function apiGet<T extends ApiError>(path: string, params?: URLSearchParams): Promise<T> {
  const url = new URL(path, API_BASE);
  if (params) params.forEach((value, key) => url.searchParams.set(key, value));

  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const body = await response.json().catch(() => null) as T | null;
  if (!response.ok || !body || body.success === false) {
    const message = body?.error || `RemoteMatch API returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  return body;
}

function createServer() {
  const server = new McpServer(
    { name: 'remotematch', version: '1.0.0' },
    { capabilities: { logging: {} } }
  );

  server.registerTool(
    'search_remote_jobs',
    {
      title: 'Search RemoteMatch jobs',
      description: 'Search current, active remote jobs in the RemoteMatch catalogue. Supports keywords, skills, candidate country, remote scope, employment type, experience, minimum salary, currency, and pagination. Results include a job detail link and the correct application handoff. Public read-only search; does not submit applications.',
      inputSchema: searchInput,
    },
    async (input) => {
      try {
        const params = new URLSearchParams();
        if (input.query) params.set('q', input.query);
        if (input.skills?.length) params.set('skills', input.skills.join(','));
        if (input.country) params.set('country', input.country);
        if (input.remoteType) params.set('remoteType', input.remoteType);
        if (input.employmentType) params.set('employmentType', input.employmentType);
        if (input.experience) params.set('experience', input.experience);
        if (input.minSalary !== undefined) params.set('minSalary', String(input.minSalary));
        if (input.salaryCurrency) params.set('salaryCurrency', input.salaryCurrency);
        if (input.limit !== undefined) params.set('limit', String(input.limit));
        if (input.offset !== undefined) params.set('offset', String(input.offset));

        const result = await apiGet<SearchResult>('/api/integrations/chatgpt/jobs', params);
        return toolResult(result);
      } catch (error) {
        return {
          content: [{ type: 'text', text: error instanceof Error ? error.message : 'Job search failed.' }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'get_remote_job',
    {
      title: 'Get RemoteMatch job details',
      description: 'Retrieve the full public details for one active RemoteMatch job using its canonical opportunity ID (the id returned by search_remote_jobs). Includes eligibility boundaries, compensation, skills, job link, and application handoff. Public read-only; does not submit applications.',
      inputSchema: {
        opportunityId: z.string().trim().min(1).max(512).describe('Canonical opportunity ID returned by search_remote_jobs.'),
      },
    },
    async ({ opportunityId }) => {
      try {
        const result = await apiGet<JobResult>(
          `/api/integrations/chatgpt/jobs/${encodeURIComponent(opportunityId)}`
        );
        return toolResult(result);
      } catch (error) {
        return {
          content: [{ type: 'text', text: error instanceof Error ? error.message : 'Could not retrieve this job.' }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// Basic per-process abuse guard. It is deliberately conservative; production
// multi-instance rate limiting should move to a shared store before public launch.
const windows = new Map<string, { startedAt: number; count: number }>();
function rateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  let entry = windows.get(key);
  if (!entry || now - entry.startedAt >= 60_000) {
    entry = { startedAt: now, count: 0 };
    windows.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > 120) {
    res.status(429).json({ error: 'Rate limit exceeded. Retry in one minute.' });
    return;
  }
  if (windows.size > 5_000) {
    for (const [ip, item] of windows) {
      if (now - item.startedAt >= 60_000) windows.delete(ip);
    }
  }
  next();
}

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'remotematch-chatgpt-mcp' });
});

app.get(MCP_PATH, (_req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ error: 'Use POST for the stateless MCP endpoint.' });
});

app.post(MCP_PATH, rateLimit, async (req, res) => {
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);

  // The public MCP endpoint is read-only and exposes only public catalogue data.
  // Do not add profile, employer, or application-write tools without OAuth and
  // a separate security review.
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[mcp] request failed', {
      requestId,
      error: error instanceof Error ? error.message : 'unknown error',
    });
    if (!res.headersSent) {
      res.status(500).json({ error: 'MCP request failed.' });
    }
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body too large.' });
    return;
  }
  console.error('[mcp] unhandled HTTP error', error);
  res.status(400).json({ error: 'Invalid request.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`RemoteMatch MCP listening on port ${PORT}`);
});
