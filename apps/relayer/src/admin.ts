// The relayer's job lists are operator data (High-Value Protection spec §9, §17): a campaign's N escrows must not be
// listable by anyone who can reach the port. GET /swap and GET /jobs require RELAYER_ADMIN_TOKEN as a bearer token;
// without a configured token the lists are closed, and the per-job routes (GET /swap/:orderId, GET /status/:txHash,
// GET /jobs/by-nullifier/:n, each needing what only its sender knows) stay open. GET /jobs, every submission with its
// fee note's opening (output, amount, secret) and the time it came in, was open to anyone until a V6 follow-up of
// 2026-10-15, while the lookup by nullifier promised that nothing else of a job leaves the relayer.
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
