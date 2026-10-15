# API — the swap records and the routes the wallet asks (spec v2.0 §15)

Express 5 over the swap engine (`packages/swap-engine`, run in-process) and `node:sqlite`. It is the wallet's second
source for swaps and cross-chain swaps:

- it quotes, records and reconciles;
- it prepares the order a one-time key signs and finalizes it.

The wallet stays canonical. It computes the money with its own relayer terms, recomputes every escrow, reads the provider
call before signing, and its own chain reads win on any disagreement.

It holds **no** note, key, recovery phrase, witness, balance, user address, IP address, user agent or funding
transaction (`test/schema.test.ts` pins the tables; `test/flow.test.ts` reads the database after a full flow). A quote
row has no amount. An operation's destination and refund material live only until finalize. Every record leaves on
schedule (`src/db.ts` `RETENTION`):

- quotes, 1 h after they expire;
- a finished operation, after 7 days;
- an abandoned order, 2 days past its refund window;
- events after 7 days; provider health after 48 h;
- in memory, a reconcile's answer only while its 5-second throttle serves it.

## Routes

| Route                                                                                   | What                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/assets`, `GET /v1/networks`, `GET /v1/providers/health`, `GET /v1/status`      | the registries, the providers' health, the service's state                                                                                                                                                                                                                                 |
| `POST /v1/quotes`                                                                       | the quote set for a pair and an amount (no destination: the engine quotes a placeholder) with the §46 quote of the chosen route — the fees indicative, the wallet computes its own                                                                                                         |
| `POST /v1/operations`                                                                   | the commit: an `op_` id (base32 of 16 random bytes; an opaque capability, never listed, never the order id)                                                                                                                                                                                |
| `GET /v1/operations/:id`, `POST /v1/operations/:id/{reconcile,prepare,finalize,resume}` | the record; where the money is (the relayer's job, the chain, the provider; once per 5 s per id); the hard quote and the call to sign (`409 minimum_moved` below the approved minimum, `price_guard` against the competition); the signed execution handed over; a re-sign after a restart |
| `GET /v1/track/:provider`, `GET /v1/risk[/:provider]`                                   | the provider's settlement read; the risk records                                                                                                                                                                                                                                           |
| `/v1/guest/*`                                                                           | the walletless swap: quote, the deposit instruction (the browser checks it again), tracking                                                                                                                                                                                                |
| `/v1/gateway/*`                                                                         | the zkAPI quote gateway (503 with the reason while no upstream exists)                                                                                                                                                                                                                     |

## The edge and the logs

- **Headers and limits.** The server kit's headers on every answer (`packages/server-kit/src/http.ts`): `no-store`,
  `nosniff`, no referrer, `default-src 'none'; frame-ancestors 'none'`, and HSTS with `TLS=1`. CORS goes to
  `ALLOWED_ORIGINS` only; there is no `x-powered-by`. Bodies are capped at 64 KB, a POST that is not JSON answers `415`,
  and a token bucket per socket answers `429` — a forged X-Forwarded-For cannot multiply it (`test/security.test.ts`).
- **Logs.** One JSON line per event, with keys among {at, level, event, operationId, provider, state, errorClass,
  network}. A value without its field's shape is redacted, so an address, a hash, an amount or a Bitcoin or Solana
  string never appears (`test/logs.test.ts`).
- **Errors.** A caller's mistake answers `4xx` with a catalog code: every field of a body is checked before any
  provider is asked (`test/validation.test.ts`). A provider that failed, or answered what the engine
  will not build on (at prepare, at track, on the guest routes), answers `502 provider_unavailable` and is logged as
  `provider.failed` with the provider, never its message (`test/provider-failure.test.ts`). Anything else is the API's
  own error: `500`, logged as `http.error` with `internal`.

## Run

```
cd apps/api && cp .env.example .env      # PORT, DB_PATH, ALLOWED_ORIGINS, RELAYER_URL, RPC_URLS (+ the engine's: packages/swap-engine/.env.example)
npm start                                # http://127.0.0.1:8787/v1
npm test                                 # 33 tests: schema, routes, reconcile, retention, security, logs, a full flow, the reads, provider failures, validation
```

The local stack starts it on 8787 with `run/api.sqlite` (`scripts/local-stack/start-services.mjs service`).
