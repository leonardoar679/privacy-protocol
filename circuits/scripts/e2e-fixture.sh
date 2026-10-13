#!/usr/bin/env bash
# Regenerate contracts/test/e2e/E2EFixture.sol for RealProofE2E.t.sol. The proof binds the native
# vault's address, which depends on the deployment, so this takes two passes:
#   1. forge dumps the deployment (vault address, chain id) to contracts/test/e2e/deployment.json
#   2. the wallet reference builds the witness for it, and snarkjs proves it with the dev key
# Prereqs: build/transaction_js + build/setup (scripts/dev-setup.sh); forge on PATH (or $FORGE).
# If forge's solc auto-fetch fails on this machine: FORGE_FLAGS="--use /path/to/solc-0.8.24".
set -euo pipefail
cd "$(dirname "$0")/.."
FORGE=${FORGE:-forge}

# The e2e test imports the fixture, so a stub must exist before the first compile.
[ -f ../contracts/test/e2e/E2EFixture.sol ] || node test/prove-e2e.mjs --stub
(cd ../contracts && E2E_DUMP=true "$FORGE" test --match-test test_E2E_DumpDeployment ${FORGE_FLAGS:-} > /dev/null)
(cd ../packages/protocol && npx tsx src/genE2EInputs.ts)
node test/prove-e2e.mjs
