# RemoteMatch ChatGPT MCP server

A separate, read-only Model Context Protocol server for RemoteMatch.

## Tools

- `search_remote_jobs`: search current catalogue listings with keywords, skills, country, remote scope, employment type, experience, salary, currency and pagination.
- `get_remote_job`: retrieve public details by canonical opportunity ID.

The service calls the RemoteMatch public integration API. It does not connect to Supabase and does not receive database credentials.

## Local run

```bash
npm install
REMOTEMATCH_API_BASE_URL=https://remotematch.online npm start
```

Run the MCP protocol smoke test (uses a local mock RemoteMatch API):

```bash
npm test
npm run typecheck
```

- MCP endpoint: `POST /mcp` (Streamable HTTP, stateless)
- Health endpoint: `GET /healthz`

## Railway deployment

Create a separate Railway service from this same repository and set its Root Directory to `/mcp-server`. Use the package's default `npm start` command. Set `REMOTEMATCH_API_BASE_URL=https://remotematch.online`; Railway injects `PORT`.

Do not add Supabase service-role keys or private RemoteMatch credentials to this service.

## Security boundary

This release exposes public job discovery only. Candidate-specific matching requires a RemoteMatch OAuth authorization-code flow with PKCE and server-verified user identity. Application submission is intentionally not exposed. Add shared-store rate limiting and OAuth before expanding the public launch.
