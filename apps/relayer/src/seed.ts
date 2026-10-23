// The relayer's own wallet seed (RELAYER_SEED; audit round 2, r50). The relayer publishes the privacy address this seed
// derives on GET /info, so a phrase — or the example's placeholder, or any string a person picks — can be tried offline
// against it cheaply (its keys are a keccak of the seed, nothing stretches them); a match gives the view key that opens every
// fee note it was paid (at a percentage fee, each note's amount tells the transfer it paid for) and the key that spends them.
// Only 32 random bytes are taken: 0x followed by 64 hex digits (`openssl rand -hex 32`). Anything else stops the start, the
// value never echoed.

const SEED = /^0x[0-9a-fA-F]{64}$/;

export function relayerSeed(raw: string | undefined): Uint8Array {
  if (raw === undefined) throw new Error("missing env RELAYER_SEED (0x followed by 64 hex digits: openssl rand -hex 32)");
  if (!SEED.test(raw.trim()))
    throw new Error(
      "RELAYER_SEED must be 0x followed by 64 hex digits — 32 random bytes (openssl rand -hex 32): a phrase can be tried offline against the privacy address this relayer publishes",
    );
  const hex = raw.trim().slice(2);
  return Uint8Array.from({ length: 32 }, (_, i) => parseInt(hex.slice(2 * i, 2 * i + 2), 16));
}
