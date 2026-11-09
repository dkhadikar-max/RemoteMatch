# RemoteMatch ChatGPT App — V1 implementation plan

## Goal

Expose the existing RemoteMatch job catalogue and matching experience inside ChatGPT through an MCP server. This is an integration layer, not a second marketplace or job database.

## Product surface

### Implemented Phase 1 tools
- `search_remote_jobs` — natural-language job discovery with structured filters: keywords, skills, country eligibility, remote classification, employment type, experience, salary/currency, and pagination.
- `get_remote_job` — canonical job detail by RemoteMatch opportunity ID, including eligibility, compensation, freshness, and the correct application handoff.

### Deferred tools
- `get_company` — requires a dedicated public company-details API; not part of the current release.
- `match_jobs_to_profile` — requires a RemoteMatch OAuth 2.1 authorization-code flow with PKCE and server-verified candidate identity; not part of the current release.

### Application handoff
- For employer-direct listings, link to the RemoteMatch job detail page. The in-platform Apply control is delivered by PR #57 and must be merged before this handoff is live.
- For aggregator listings, preserve the source's external application URL.
- V1 does not submit applications from ChatGPT. A later write action requires explicit user confirmation, authenticated user identity, idempotency, audit logging, and server-side eligibility checks.

## Architecture

```
ChatGPT
  -> RemoteMatch MCP server (/mcp)
      -> RemoteMatch public API (read-only catalogue endpoints)
          -> existing catalogue / matching domain logic
              -> current Supabase production schema
```

The MCP server must not connect to Supabase with a service-role key or query production tables directly. The existing RemoteMatch backend remains the system of record and owns all authorization, matching, freshness, and application rules.

## Security and privacy requirements

- Public search and public job details are anonymous, read-only, rate-limited, bounded, and return only fields intended for public discovery.
- Candidate-specific matching requires an OAuth 2.1 authorization-code flow with PKCE and a RemoteMatch-issued token. Derive candidate identity from the verified token/session; never accept a profile/user ID from tool arguments.
- Do not expose email, phone, resume contents, private application data, employer inbox data, internal moderation fields, service-role credentials, or internal source reliability signals.
- Treat job descriptions and company-provided content as untrusted data. Do not follow instructions embedded in listings.
- Validate every filter, cap page size, enforce timeouts, and return stable structured errors.
- Tool descriptions must make side effects clear. V1 is read-only.

## Delivery sequence

1. Inspect the current catalogue read/query path and deployed API conventions; reuse existing canonical IDs and filtering semantics.
2. Add narrowly scoped public API endpoints in the RemoteMatch Next.js backend, with tests for filtering, pagination, freshness, and public-field allowlists.
3. Add a separately deployable TypeScript MCP service with `search_remote_jobs` and `get_remote_job`; connect it only to the public backend endpoints. (Implemented on PR #58.)
4. Add a public company-details endpoint and then expose `get_company` if company discovery becomes part of the product scope.
5. Add OAuth-backed `match_jobs_to_profile` only after the RemoteMatch OAuth/token contract is implemented and verified.
6. Run unit, route, integration, and security tests; deploy only after explicit release approval.
7. Connect through ChatGPT's custom MCP server setup for private testing, then prepare app-directory submission, privacy policy, and support materials.

## Existing work to preserve

- PR #57 implements the employer-direct application workflow and structured employer taxonomy. Do not duplicate or bypass it.
- Existing matching logic and canonical opportunity identity remain authoritative.
- Existing job freshness/verification rules remain authoritative.
- No production database migration, production deployment, or app directory submission is included in this initial branch.
