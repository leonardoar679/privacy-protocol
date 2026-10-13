// Domain separators (spec §3). Byte-identical to DomainSeparators.sol and circuits/lib/domains.circom:
// DOM(tag) = uint256(keccak256("privacy-protocol/v1/domain/<tag>")) mod p. The five Poseidon2 domains
// prefix a hash input; OUTPUT_BINDING and TX_DOMAIN are keccak prefixes (spec §11–12).
import { keccak_256 } from "@noble/hashes/sha3";
import { utf8ToBytes } from "@noble/hashes/utils";
import { FIELD } from "./field";

export const bytesToBigInt = (b: Uint8Array): bigint => {
  let x = 0n;
  for (const v of b) x = (x << 8n) | BigInt(v); // big-endian, matches uint256(bytes32)
  return x;
};

export const tagString = (tag: string): string => `privacy-protocol/v1/domain/${tag}`;
export const domainTag = (tag: string): bigint => bytesToBigInt(keccak_256(utf8ToBytes(tagString(tag)))) % FIELD;

export const NOTE_BODY = domainTag("NOTE_BODY");
export const NOTE_COMMITMENT = domainTag("NOTE_COMMITMENT");
export const OWNER_COMMITMENT = domainTag("OWNER_COMMITMENT");
export const NULLIFIER = domainTag("NULLIFIER");
export const PHANTOM_NULLIFIER = domainTag("PHANTOM_NULLIFIER");

/** keccak prefix for the output-payload binding (spec §12) */
export const OUTPUT_BINDING_TAG = utf8ToBytes(tagString("OUTPUT_BINDING"));
/** keccak256 of the TX_DOMAIN tag, first word of the txDomain preimage (spec §11) */
export const TX_DOMAIN_TAG = keccak_256(utf8ToBytes(tagString("TX_DOMAIN")));
