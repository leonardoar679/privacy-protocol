// npm run voucher-address -w @privacy-wallet/api (a V6 follow-up of 2026-10-16): prints the address API_VOUCH_KEY vouches
// as, from the environment the API would read it from, so the relayers' API_VOUCHER can name it before the API runs with
// the key (docs/deployment.md). The key is never printed; a malformed one is refused in the API's own words.
import { voucherAddress } from "../vouch";

const r = voucherAddress(process.env);
if (r.ok) process.stdout.write(`${r.address}\n`);
else {
  process.stderr.write(`${r.error}\n`);
  process.exitCode = 1;
}
