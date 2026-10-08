// The relayer's job list is operator data (High-Value Protection spec §9, §17): a campaign's N escrows must not be
// listable by anyone who can reach the port. GET /swap requires RELAYER_ADMIN_TOKEN as a bearer token; without a
// configured token the list is closed, and the per-job route (GET /swap/:orderId, which needs the order id) stays open.
export function adminAuthorized(authorization: string | string[] | undefined, token: string | undefined): { ok: true } | { ok: false; status: number; error: string; code: string } {
  if (!token) return { ok: false, status: 403, error: "the job list is closed: set RELAYER_ADMIN_TOKEN to open it to operators", code: "admin_closed" };
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  const given = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!given || !timingSafeEqualString(given, token)) return { ok: false, status: 401, error: "the job list needs the operator token (Authorization: Bearer …)", code: "admin_token" };
  return { ok: true };
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
