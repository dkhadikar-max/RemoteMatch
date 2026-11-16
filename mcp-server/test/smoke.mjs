import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const mockApi = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api/integrations/chatgpt/jobs') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      total: 1,
      limit: 10,
      offset: 0,
      hasMore: false,
      opportunities: [{ id: 'opp-test-123', title: 'Product Designer', company: 'Example Co', jobUrl: 'https://remotematch.online/remote-jobs/view/123' }],
    }));
    return;
  }
  if (url.pathname === '/api/integrations/chatgpt/jobs/opp-test-123') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      opportunity: { id: 'opp-test-123', title: 'Product Designer', company: 'Example Co' },
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: false, error: 'Not found' }));
});

await new Promise((resolve) => mockApi.listen(0, '127.0.0.1', resolve));
const apiAddress = mockApi.address();
assert.ok(apiAddress && typeof apiAddress === 'object');

const port = 34000 + Math.floor(Math.random() * 10000);
const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'server.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    REMOTEMATCH_API_BASE_URL: `http://127.0.0.1:${apiAddress.port}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let childOutput = '';
child.stdout.on('data', (chunk) => { childOutput += chunk.toString(); });
child.stderr.on('data', (chunk) => { childOutput += chunk.toString(); });

const healthUrl = `http://127.0.0.1:${port}/healthz`;
let ready = false;
try {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`MCP server exited early: ${childOutput}`);
    try {
      const response = await fetch(healthUrl);
      if (response.ok) { ready = true; break; }
    } catch {
      // Server is still starting.
    }
    await delay(250);
  }
  assert.equal(ready, true, `MCP server did not become healthy: ${childOutput}`);

  const client = new Client({ name: 'remotematch-mcp-smoke', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['get_remote_job', 'search_remote_jobs']);

  const search = await client.callTool({
    name: 'search_remote_jobs',
    arguments: { query: 'Product Designer', limit: 10 },
  });
  assert.equal(search.isError, undefined);
  assert.equal(search.structuredContent.total, 1);
  assert.equal(search.structuredContent.opportunities[0].id, 'opp-test-123');

  const details = await client.callTool({
    name: 'get_remote_job',
    arguments: { opportunityId: 'opp-test-123' },
  });
  assert.equal(details.isError, undefined);
  assert.equal(details.structuredContent.opportunity.title, 'Product Designer');

  await client.close();
  console.log('RemoteMatch MCP smoke test passed: initialize, tools/list, search_remote_jobs, get_remote_job.');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3_000).unref();
  });
  await new Promise((resolve) => mockApi.close(resolve));
}
