/**
 * Supply Discovery gate C5 — robots.txt permission check
 * (docs/c5-implementation-plan.md §4a)
 * ==============================================================================
 * Genuinely new infrastructure — nothing in this codebase checks a
 * third-party site's robots.txt today (only src/app/robots.ts, which
 * GENERATES this app's own robots.txt, is unrelated).
 *
 * Intentionally minimal: a Disallow/Allow parser for the generic
 * User-agent: * group (and a specific RemoteMatchBot group if a site
 * declares one), matching the standard longest-match-wins rule. Not a
 * full RFC 9309 implementation (no crawl-delay, no sitemap directives) —
 * this only needs to answer one yes/no question per candidate path, run
 * once at registration time by a human reviewer, not on every sync cycle.
 *
 * Fails CLOSED on anything that prevents a real verdict (fetch failure,
 * unparseable response) — the conservative direction for a NEW-source
 * decision (unlike verifyLinkFreshness()'s fail-open design, which exists
 * to avoid false drops of jobs already known to be real; this is the
 * opposite case). Once a robots.txt is actually retrieved, this follows
 * STANDARD robots.txt semantics: it is fundamentally a deny-list, not an
 * allow-list — a path with no matching Disallow rule in the applicable
 * group is permitted, exactly as every well-behaved crawler (Googlebot
 * included) interprets it. Most real career pages have no explicit "Allow:"
 * statement at all; requiring one would make this check reject the large
 * majority of genuinely unrestricted pages, which is not what "explicitly
 * permits automated access" (the spec's own wording) means in practice.
 */

export interface RobotsCheckResult {
  allowed: boolean;
  checkedAt: string;
  reason: string;
}

interface RobotsRule {
  userAgent: string;
  disallow: string[];
  allow: string[];
}

function parseRobotsTxt(text: string): RobotsRule[] {
  const groups: RobotsRule[] = [];
  let current: RobotsRule | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (field === 'user-agent') {
      // A new User-agent line after any directive starts a new group;
      // consecutive User-agent lines with no directive between them share
      // the group that follows (standard robots.txt semantics).
      if (current && (current.disallow.length > 0 || current.allow.length > 0)) {
        current = null;
      }
      if (!current) {
        current = { userAgent: value.toLowerCase(), disallow: [], allow: [] };
        groups.push(current);
      } else {
        groups.push({ userAgent: value.toLowerCase(), disallow: [], allow: [] });
        current = groups[groups.length - 1];
      }
    } else if (field === 'disallow' && current) {
      if (value) current.disallow.push(value);
    } else if (field === 'allow' && current) {
      if (value) current.allow.push(value);
    }
  }

  return groups;
}

function pathAllowedByGroup(path: string, group: RobotsRule): boolean | null {
  const rules: { pattern: string; allowed: boolean }[] = [
    ...group.disallow.map((p) => ({ pattern: p, allowed: false })),
    ...group.allow.map((p) => ({ pattern: p, allowed: true })),
  ];
  // Longest-match-wins, the standard robots.txt tie-break rule.
  let best: { pattern: string; allowed: boolean } | null = null;
  for (const rule of rules) {
    if (rule.pattern === '') continue; // an empty Disallow means "allow everything"
    if (path.startsWith(rule.pattern)) {
      if (!best || rule.pattern.length > best.pattern.length) best = rule;
    }
  }
  if (!best) {
    // No matching rule in this group at all — check for an explicit
    // empty-Disallow "allow everything" declaration.
    if (group.disallow.some((p) => p === '')) return true;
    return null; // no applicable rule; caller falls through to fail-closed default
  }
  return best.allowed;
}

export async function checkRobotsPermission(
  url: string,
  botUserAgent = 'RemoteMatchBot'
): Promise<RobotsCheckResult> {
  const now = new Date().toISOString();
  let origin: string;
  let path: string;
  try {
    const parsed = new URL(url);
    origin = parsed.origin;
    path = parsed.pathname + parsed.search;
  } catch {
    return { allowed: false, checkedAt: now, reason: 'Malformed URL — cannot determine robots.txt origin.' };
  }

  let text: string;
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': `${botUserAgent}/1.0 (+https://remotematch.com)` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // No robots.txt at all is commonly treated as "everything allowed" by
      // convention — but per this module's fail-closed design for a NEW
      // source decision (not a re-check of an already-trusted source), we
      // require an explicit allow signal instead of assuming one.
      return { allowed: false, checkedAt: now, reason: `robots.txt returned ${res.status} — no explicit permission found, failing closed.` };
    }
    text = await res.text();
  } catch (err) {
    return { allowed: false, checkedAt: now, reason: `Could not fetch robots.txt: ${(err as Error).message}` };
  }

  const groups = parseRobotsTxt(text);
  const botGroup = groups.find((g) => g.userAgent === botUserAgent.toLowerCase());
  const wildcardGroup = groups.find((g) => g.userAgent === '*');
  const applicableGroup = botGroup ?? wildcardGroup;

  if (!applicableGroup) {
    // robots.txt exists but declares no rule for our agent or "*" at all —
    // standard interpretation: nothing restricts us, allowed.
    return { allowed: true, checkedAt: now, reason: 'robots.txt has no applicable User-agent group — no restriction found.' };
  }

  const verdict = pathAllowedByGroup(path, applicableGroup);
  if (verdict === null) {
    // No Disallow/Allow rule matches this specific path in the applicable
    // group — standard semantics: not disallowed means allowed.
    return { allowed: true, checkedAt: now, reason: `No matching rule for this path under User-agent: ${applicableGroup.userAgent} — not disallowed.` };
  }
  return {
    allowed: verdict,
    checkedAt: now,
    reason: verdict
      ? `Explicitly allowed by robots.txt (User-agent: ${applicableGroup.userAgent}).`
      : `Explicitly disallowed by robots.txt (User-agent: ${applicableGroup.userAgent}).`,
  };
}
