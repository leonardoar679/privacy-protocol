// The app's prover (spec v3.0 §7.3): the worker client, loaded on first use so that nothing of the prover is in the first
// route (scripts/check-budget.mjs; Vite splits the client and the worker into their own chunks). Warmed as soon as a
// live withdrawal is possible; the withdraw flow drives it in Stage 9.
import { config } from "../config";
import type { ProverClient } from "../prover/client";

let client: Promise<ProverClient> | null = null;

export function prover(): Promise<ProverClient> {
  // a phone gets websnark's sub-workers 1,000 pages each (spec v3.0 §7.3) — four at 2,000 pages are 500 MB a phone's browser ends (C2-9)
  const phone = typeof navigator !== "undefined" && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  return (client ??= import("../prover/client").then(
    (m) => new m.ProverClient({ artifactBase: config().artifactBase, ...(phone ? { options: { wasmInitialMemory: 1000 } } : {}) }),
  ));
}

/** Starts fetching and verifying the artifacts and building websnark; a failure surfaces at the withdrawal, not here. */
export function warmProver(): void {
  void prover()
    .then((c) => c.warm())
    .catch(() => undefined);
}
