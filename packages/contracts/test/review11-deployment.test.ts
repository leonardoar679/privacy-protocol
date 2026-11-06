// The eleventh review round (2026-11-04), area G: the deployment check compares the core's protocol, circuit and hash identifiers with this
// build's and reads its hasher back (G11-1 — a core of another protocol, circuit or hash had passed, its identifiers compared with nothing,
// every deposit into it locked for good); it recognises the development key by its key, not one compilation of it (G11-4 — the same insecure
// key with a metadata trailer passed a production check); it reads both factories' wrapped native token (G11-6 — a shield factory built on
// none let anyone sweep an ETH receipt's WETH to the public fallback).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContractFunctionExecutionError, ContractFunctionZeroDataError, HttpRequestError, keccak256, stringToHex, type Address, type Hex } from "viem";
import devVerifier from "../../../contracts/abi/dev/TransactionVerifierDev.json";
import hasherRuntime from "../../../contracts/abi/runtime/Poseidon2Hasher.json";
import {
  CORE_IDS,
  DEV_KEY_WORDS,
  HASHER_CODEHASH,
  holdsDevKey,
  POSEIDON2_ONE_TWO_THREE,
  verifyDeployment,
  WRAPPED_NATIVE_OF,
  type DeploymentReader,
} from "../src/deployments";

const CORE = "0x00000000000000000000000000000000000000c0" as Address;
const FACTORY = "0x00000000000000000000000000000000000000fa" as Address;
const VERIFIER = "0x00000000000000000000000000000000000000ab" as Address;
const INNER = "0x00000000000000000000000000000000000000cd" as Address;
const HASHER = "0x00000000000000000000000000000000000000e5" as Address;
const ETH_VAULT = "0x00000000000000000000000000000000000000e7" as Address;
const SHIELD = "0x00000000000000000000000000000000000000f5" as Address;
const SWAP = "0x00000000000000000000000000000000000000f6" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const WETH9 = WRAPPED_NATIVE_OF[1];
const OTHER = "0x00000000000000000000000000000000000000aa" as Address;
const HASHER_CODE = hasherRuntime.deployedBytecode as Hex;
const DEV_CODE = devVerifier.deployedBytecode as Hex;
/** solc's default CBOR metadata trailer, as another toolchain appends it: another code hash, the same key */
const TRAILER = "a2646970667358221220" + "07".repeat(32) + "64736f6c634300081c0033";

interface Chain {
  ids?: Partial<Record<"PROTOCOL_ID" | "CIRCUIT_ID" | "HASH_ID", Hex>>;
  hasherCode?: Hex;
  hashAnswer?: bigint;
  innerCode?: Hex;
  chainId?: number;
  shieldWrapped?: Address;
  swapWrapped?: Address;
  getCode?: boolean;
  /** what the hasher's read, or the shield factory's WRAPPED_NATIVE read, throws */
  hashThrows?: unknown;
  wrappedThrows?: unknown;
}
function reader(o: Chain = {}): DeploymentReader {
  return {
    getChainId: async () => o.chainId ?? 1,
    readContract: async ({ address, functionName, args }) => {
      if (address === CORE)
        return (
          {
            PROTOCOL_ID: o.ids?.PROTOCOL_ID ?? CORE_IDS.protocolId,
            CIRCUIT_ID: o.ids?.CIRCUIT_ID ?? CORE_IDS.circuitId,
            HASH_ID: o.ids?.HASH_ID ?? CORE_IDS.hashId,
            VERIFIER,
            VAULT_FACTORY: FACTORY,
            LEVELS: 32n,
            HASHER,
          } as Record<string, unknown>
        )[functionName];
      if (address === VERIFIER && functionName === "INNER") return INNER;
      if (address === HASHER && functionName === "poseidon2") {
        if (o.hashThrows) throw o.hashThrows;
        expect(args, "asked on the rate's own case").toEqual([[1n, 2n, 3n]]);
        return o.hashAnswer ?? POSEIDON2_ONE_TWO_THREE;
      }
      if (address === FACTORY && functionName === "vaultOf") return String(args![0]) === ZERO ? ETH_VAULT : ZERO;
      if (functionName === "VAULT_VERSION") return 1n;
      if (address === SHIELD && functionName === "VAULT_FACTORY") return FACTORY;
      if (address === SHIELD && functionName === "WRAPPED_NATIVE") {
        if (o.wrappedThrows) throw o.wrappedThrows;
        return o.shieldWrapped ?? WETH9;
      }
      if (address === SWAP && functionName === "WRAPPED_NATIVE") return o.swapWrapped ?? WETH9;
      throw new Error(`unexpected read ${address}.${functionName}`);
    },
    ...(o.getCode === false
      ? {}
      : {
          getCode: async ({ address }) =>
            address === INNER ? (o.innerCode ?? ("0x6001600155" as Hex)) : address === HASHER ? (o.hasherCode ?? HASHER_CODE) : undefined,
        }),
  };
}
const claim = (o: { production?: boolean; chainId?: number; factories?: boolean } = {}) => ({
  chainId: o.chainId ?? 1,
  core: CORE,
  assets: { eth: null },
  ...(o.production ? { production: true } : {}),
  ...(o.factories ? { shieldFactory: SHIELD, swapFactory: SWAP } : {}),
});

describe("G11-1: the core is this build's protocol, circuit and hash, and its hasher is this build's Poseidon2", () => {
  it("this build's deployment has no problem", async () => {
    expect((await verifyDeployment(reader(), claim({ production: true, factories: true }))).problems).toEqual([]);
  });

  it("the identifiers are the contracts' own (CoreTypes.sol)", () => {
    const src = readFileSync(join(__dirname, "..", "..", "..", "contracts", "src", "core", "CoreTypes.sol"), "utf8");
    const id = (name: string) => {
      const m = new RegExp(`${name} =\\s*keccak256\\("([^"]+)"\\)`).exec(src);
      expect(m, name).not.toBeNull();
      return keccak256(stringToHex(m![1]));
    };
    expect(CORE_IDS).toEqual({ protocolId: id("PROTOCOL_ID"), circuitId: id("CIRCUIT_ID"), hashId: id("HASH_ID") });
  });

  it("another protocol's, circuit's or hash's core is a problem, each named", async () => {
    const other = keccak256(stringToHex("another"));
    const of = async (ids: Chain["ids"]) => (await verifyDeployment(reader({ ids }), claim())).problems;
    expect(await of({ PROTOCOL_ID: other })).toEqual([`the core's protocol identifier ${other} is not this build's`]);
    expect(await of({ CIRCUIT_ID: other })).toEqual([`the core's circuit identifier ${other} is not this build's circuit: no proof of this build can verify`]);
    expect(await of({ HASH_ID: other })).toEqual([`the core's hash identifier ${other} is not this build's`]);
  });

  it("a hasher of other code, without code, or hashing otherwise is a problem; without getCode the hash is still read back", async () => {
    expect(HASHER_CODEHASH).toBe(keccak256(HASHER_CODE));
    const of = async (o: Chain) => (await verifyDeployment(reader(o), claim())).problems;
    expect(await of({ hasherCode: (HASHER_CODE + "00") as Hex })).toEqual([`the core's hasher ${HASHER} is not this build's Poseidon2`]);
    expect(await of({ hasherCode: "0x" })).toEqual([`the core's hasher ${HASHER} has no code`]);
    expect(await of({ hashAnswer: 7n })).toEqual([`the core's hasher ${HASHER} does not hash as this build's Poseidon2`]);
    expect(await of({ getCode: false, hashAnswer: 7n }), "a reader without code still hears the hash").toEqual([
      `the core's hasher ${HASHER} does not hash as this build's Poseidon2`,
    ]);
    expect(await of({ getCode: false })).toEqual([]);
  });
});

describe("the two new reads sort their failures as every read of the check does (audit round 2, n41; the first critique of slice 5)", () => {
  const down = (functionName: string) =>
    new ContractFunctionExecutionError(new HttpRequestError({ url: "http://rpc.example", details: "fetch failed" }), { abi: [], functionName });
  const none = (functionName: string) => new ContractFunctionExecutionError(new ContractFunctionZeroDataError({ functionName }), { abi: [], functionName });

  it("a failed read is the read's own error, tried again — never a mismatch", async () => {
    const hash = down("poseidon2");
    await expect(verifyDeployment(reader({ hashThrows: hash }), claim())).rejects.toBe(hash);
    const wrapped = down("WRAPPED_NATIVE");
    await expect(verifyDeployment(reader({ wrappedThrows: wrapped }), claim({ factories: true }))).rejects.toBe(wrapped);
  });

  it("the chain's own answer — no data — is the named problem", async () => {
    expect((await verifyDeployment(reader({ hashThrows: none("poseidon2") }), claim())).problems).toEqual([
      `the core's hasher ${HASHER} does not hash as this build's Poseidon2`,
    ]);
    expect((await verifyDeployment(reader({ wrappedThrows: none("WRAPPED_NATIVE") }), claim({ factories: true }))).problems).toEqual([
      `the shield receiver factory ${SHIELD} takes no wrapped native token`,
    ]);
  });
});

describe("the check's pins are the build's own (the first critique of slice 5)", () => {
  it("the development key's words are TransactionVerifierDev.sol's deltax1, deltay1, IC0x and IC0y", () => {
    const src = readFileSync(join(__dirname, "..", "..", "..", "contracts", "src", "verifier", "dev", "TransactionVerifierDev.sol"), "utf8");
    const word = (name: string) => {
      const m = new RegExp(`uint256 constant ${name} = (\\d+);`).exec(src);
      expect(m, name).not.toBeNull();
      return `0x${BigInt(m![1]).toString(16).padStart(64, "0")}`;
    };
    expect(DEV_KEY_WORDS).toEqual(["deltax1", "deltay1", "IC0x", "IC0y"].map(word));
    // and Deploy.s.sol's own copy of two of them (the second critique of slice 5: a word every snarkjs verifier embeds in their place had
    // refused every ceremony key at the real deployment)
    const script = readFileSync(join(__dirname, "..", "..", "..", "contracts", "script", "Deploy.s.sol"), "utf8");
    const scripted = (name: string) => {
      const m = new RegExp(`uint256 internal constant ${name} = (\\d+);`).exec(script);
      expect(m, name).not.toBeNull();
      return `0x${BigInt(m![1]).toString(16).padStart(64, "0")}`;
    };
    expect([scripted("DEV_DELTA_X1"), scripted("DEV_IC0_X")]).toEqual([DEV_KEY_WORDS[0], DEV_KEY_WORDS[2]]);
  });

  it("the hasher's code hash is the one forge computes for this build (contracts/test/periphery/vectors/hasher.json)", () => {
    const v = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "contracts", "test", "periphery", "vectors", "hasher.json"), "utf8"));
    expect(HASHER_CODEHASH).toBe(v.poseidon2HasherRuntimeCodeHash);
  });
});

describe("G11-4: the development key is recognised by its key, however it was compiled", () => {
  it("another key of the same template is not the development key (the first critique of slice 5)", async () => {
    // the dev verifier's code with its four key words replaced — another ceremony's key, the same template
    let other = DEV_CODE.toLowerCase();
    for (const w of DEV_KEY_WORDS) other = other.split(w.slice(2).toLowerCase()).join(keccak256(w).slice(2));
    expect(holdsDevKey(other as Hex)).toBe(false);
    expect((await verifyDeployment(reader({ innerCode: other as Hex }), claim({ production: true }))).problems).toEqual([]);
  });

  it("its four words are in its code, byte-aligned; another compilation of it is the same key", () => {
    expect(DEV_KEY_WORDS).toHaveLength(4);
    for (const w of DEV_KEY_WORDS) expect(DEV_CODE.toLowerCase()).toContain(w.slice(2).toLowerCase());
    expect(holdsDevKey(DEV_CODE)).toBe(true);
    expect(holdsDevKey((DEV_CODE + TRAILER) as Hex)).toBe(true);
    expect(holdsDevKey(HASHER_CODE), "code without the key").toBe(false);
    expect(holdsDevKey(`0x0${DEV_KEY_WORDS[0].slice(2)}0` as Hex), "a word half a byte off is not that word").toBe(false);
  });

  it("a production build refuses the key with a metadata trailer; a devnet takes it", async () => {
    const recompiled = (DEV_CODE + TRAILER) as Hex;
    expect(keccak256(recompiled)).not.toBe(keccak256(DEV_CODE));
    expect((await verifyDeployment(reader({ innerCode: recompiled }), claim({ production: true }))).problems).toEqual([
      "the proof verifier is the development key, which accepts any proof: not a deployment to use",
    ]);
    expect((await verifyDeployment(reader({ innerCode: recompiled }), claim())).problems).toEqual([]);
  });
});

describe("G11-6: both factories take the chain's wrapped native token", () => {
  it("none, or another than the chain's, is a problem for either factory; a chain without a known one takes any but none, save the devnet", async () => {
    const of = async (o: Chain, chainId = 1) => (await verifyDeployment(reader({ ...o, chainId }), claim({ factories: true, chainId }))).problems;
    expect(await of({ shieldWrapped: ZERO })).toEqual([`the shield receiver factory ${SHIELD} takes no wrapped native token`]);
    expect(await of({ swapWrapped: OTHER })).toEqual([`the swap factory ${SWAP} takes ${OTHER} as the wrapped native token, not this chain's ${WETH9}`]);
    expect(await of({ shieldWrapped: OTHER, swapWrapped: OTHER }, 8453), "a chain this build names none for: its own").toEqual([]);
    expect(await of({ swapWrapped: ZERO }, 8453)).toEqual([`the swap factory ${SWAP} takes no wrapped native token`]);
    expect(await of({ shieldWrapped: ZERO, swapWrapped: ZERO }, 31337), "the devnet, as the deploy scripts make it").toEqual([]);
    // Sepolia's own (the third critique of slice 5: no test read the Sepolia pin)
    const SEPOLIA_WETH = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
    expect(await of({ shieldWrapped: SEPOLIA_WETH, swapWrapped: SEPOLIA_WETH }, 11155111), "Sepolia: its WETH").toEqual([]);
    expect(await of({ shieldWrapped: SEPOLIA_WETH, swapWrapped: WETH9 }, 11155111)).toEqual([
      `the swap factory ${SWAP} takes ${WETH9} as the wrapped native token, not this chain's ${SEPOLIA_WETH}`,
    ]);
  });

  it("the wallet's pins are the deploy scripts' and the local stack's, and the addresses named on chain (the third critique of slice 5)", () => {
    // the addresses themselves: WETH9 and Sepolia's "Wrapped Ether"
    expect(WRAPPED_NATIVE_OF).toEqual({ 1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 11155111: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14" });
    const read = (...path: string[]) => readFileSync(join(__dirname, "..", "..", "..", ...path), "utf8");
    for (const script of ["DeploySwapPeriphery.s.sol", "DeployShieldReceiver.s.sol"]) {
      const s = read("contracts", "script", script);
      const of = (chain: number) => new RegExp(`if \\(block\\.chainid == ${chain}\\) return (0x[0-9a-fA-F]{40});`).exec(s)?.[1];
      expect([of(1), of(11155111)], script).toEqual([WRAPPED_NATIVE_OF[1], WRAPPED_NATIVE_OF[11155111]]);
    }
    expect(/weth9: "(0x[0-9a-fA-F]{40})"/.exec(read("scripts", "local-stack", "deploy.mjs"))?.[1], "the local stack's devnet as chain 1").toBe(
      WRAPPED_NATIVE_OF[1],
    );
  });
});
