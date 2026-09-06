/**
 * Validation rule for the optional linkedin_url/github_url profile fields
 * (display links only, not an auth mechanism). Documented here since it's
 * the "chosen validation rule" referenced by the account-linking test plan:
 *
 *   - Empty/whitespace-only input clears the field (returns null, no error).
 *   - A bare domain/path with no scheme ("linkedin.com/in/x") is treated as
 *     "sensible HTTPS handling": https:// is prepended automatically.
 *   - An explicit http:// URL is rejected — asks for https or a bare value
 *     instead of silently upgrading a scheme the user typed on purpose.
 *   - Anything that doesn't parse as a URL, or doesn't end up with an
 *     https: protocol, is rejected.
 *   - The domain is NOT required to be linkedin.com/github.com specifically
 *     — deliberately generic (covers regional subdomains, short links,
 *     etc.); this only enforces "a well-formed, secure URL", not "is
 *     actually a LinkedIn/GitHub URL".
 */
export interface ProfileUrlValidation {
  value: string | null;
  error?: string;
}

export function normalizeProfileUrl(input: string): ProfileUrlValidation {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { value: null };
  }

  if (/^http:\/\//i.test(trimmed)) {
    return { value: null, error: 'Please use an https:// link (or just the domain, e.g. linkedin.com/in/you).' };
  }

  const candidate = /^https:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { value: null, error: "That doesn't look like a valid URL." };
  }

  if (parsed.protocol !== 'https:') {
    return { value: null, error: 'Please use a secure (https://) link.' };
  }
  if (!parsed.hostname.includes('.')) {
    return { value: null, error: "That doesn't look like a valid URL." };
  }

  return { value: parsed.toString() };
}
