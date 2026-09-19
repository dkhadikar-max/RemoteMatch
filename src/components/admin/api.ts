/**
 * Turns a failed admin API response into a message that says WHY, so an
 * operator sees the real database/permission error instead of a bare
 * "Request failed (500)". The admin routes return `{ error, detail? }`.
 */
export async function describeFailure(res: Response): Promise<string> {
  let body: { error?: string; detail?: string } = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON body — fall through to the status-only message */
  }
  const base = body.error ?? 'Request failed';
  return `${base}${body.detail ? ` — ${body.detail}` : ''} (${res.status})`;
}
