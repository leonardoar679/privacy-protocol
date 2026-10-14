// The API's /v1 routes (spec v2.0 §15) in front of a test's V5-shaped service mock: quotes, the operation's commit and
// restore (POST /v1/operations, with `params` for a restore), its resume, prepare and finalize by an `op_` id, the status
// and the risk view — the mock keeps its handlers and the paths it records; the wallet speaks /v1 only.
type Service = (path: string, body: any) => Promise<Response>;

const ok = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });

export function v1Adapter(service: Service): Service & { operations: Map<string, string> } {
  /** op_ id → order id */
  const operations = new Map<string, string>();
  const opOf = (orderId: string): string => {
    for (const [op, order] of operations) if (order === orderId.toLowerCase()) return op;
    const op = `op_${orderId.slice(2, 28).toLowerCase()}`;
    operations.set(op, orderId.toLowerCase());
    return op;
  };
  const withOperation = async (r: Response): Promise<Response> => {
    if (!r.ok) return r;
    const j = await r.json();
    return ok({ ...j, operationId: opOf(j.order.orderId) });
  };
  const adapter = async (path: string, body: any): Promise<Response> => {
    if (path === "/v1/quotes") return service("/quote", body);
    if (path === "/v1/operations") return withOperation(await service(body?.params ? "/order/resume" : "/order", body));
    if (path === "/v1/status") return service("/health", body);
    if (path.startsWith("/v1/risk/")) return service(path.slice("/v1".length), body);
    if (path.startsWith("/v1/track/")) return service(path.slice("/v1".length), body);
    const m = /^\/v1\/operations\/(op_[a-z0-9]+)\/(prepare|finalize|resume|reconcile)$/.exec(path);
    if (m) {
      const orderId = operations.get(m[1]);
      if (!orderId) return ok({ error: "unknown order", code: "unknown_order" }, 404);
      if (m[2] === "resume") return withOperation(await service("/order/resume", body));
      if (m[2] === "reconcile") return ok({ error: "no reconcile in this mock", code: "unknown_order" }, 404);
      return service(`/${m[2]}`, { ...(body ?? {}), orderId });
    }
    return ok({ error: "no such route", code: "invalid_request" }, 404);
  };
  return Object.assign(adapter, { operations });
}
