// The Classic app's configuration (spec v3.0 §7.7–§7.8): mainnet by default, nothing live by default, the switches off,
// a malformed value refused by name.
import { describe, expect, it } from "vitest";
import { configFromEnv, isLive, parseLive } from "../src/config";

describe("configFromEnv", () => {
  it("defaults: chain 1, no hosts, nothing live, the compliance switches off, the bases under /classic/", () => {
    const c = configFromEnv({});
    expect(c.chainId).toBe(1);
    expect(c.rpcUrls).toEqual([]);
    expect(c.relayerUrls).toEqual([]);
    expect(c.live).toEqual({});
    expect(c.complianceOracle).toBe(false);
    expect(c.geofence).toBe(false);
    expect(c.production).toBe(false);
    expect(c.dataBase).toBe("/classic/data");
    expect(c.artifactBase).toBe("/classic/artifacts");
    expect(isLive(c, "eth-1", "withdraw")).toBe(false);
  });
  it("reads the lists, the switches and the live map", () => {
    const c = configFromEnv({
      VITE_CLASSIC_CHAIN_ID: "1",
      VITE_CLASSIC_RPC_URLS: "https://rpc-a.example/v1, https://rpc-b.example",
      VITE_CLASSIC_RELAYER_URLS: "https://relayer.example",
      VITE_CLASSIC_LIVE: '{"eth-1":["withdraw","withdraw"],"eth-100":["deposit","withdraw"]}',
      VITE_CLASSIC_COMPLIANCE_ORACLE: "1",
      PROD: true,
      BASE_URL: "/classic/",
    });
    expect(c.rpcUrls).toEqual(["https://rpc-a.example/v1", "https://rpc-b.example"]);
    expect(c.relayerUrls).toEqual(["https://relayer.example"]);
    expect(c.live).toEqual({ "eth-1": ["withdraw"], "eth-100": ["deposit", "withdraw"] });
    expect(isLive(c, "eth-1", "withdraw")).toBe(true);
    expect(isLive(c, "eth-1", "deposit")).toBe(false);
    expect(c.complianceOracle).toBe(true);
    expect(c.geofence).toBe(false);
    expect(c.production).toBe(true);
  });
  it("refuses a malformed value by name", () => {
    expect(() => configFromEnv({ VITE_CLASSIC_CHAIN_ID: "mainnet" })).toThrow();
    expect(() => parseLive("not json")).toThrow(/VITE_CLASSIC_LIVE is not JSON/);
    expect(() => parseLive('["eth-1"]')).toThrow(/object/);
    expect(() => parseLive('{"eth-5":["withdraw"]}')).toThrow(/unknown pool/);
    expect(() => parseLive('{"eth-1":["burn"]}')).toThrow(/deposit and\/or withdraw/);
    expect(() => configFromEnv({ VITE_CLASSIC_GEOFENCE: "yes" })).toThrow();
  });
  it("a development chain's deployed block (Stage 10): read for a dev build, refused in a production build, null by default", () => {
    expect(configFromEnv({}).deployedBlock).toBeNull();
    expect(configFromEnv({ VITE_CLASSIC_DEPLOYED_BLOCK: "17" }).deployedBlock).toBe(17);
    expect(() => configFromEnv({ VITE_CLASSIC_DEPLOYED_BLOCK: "17", PROD: true })).toThrow(/development chains only/);
    expect(() => configFromEnv({ VITE_CLASSIC_DEPLOYED_BLOCK: "soon" })).toThrow();
    expect(configFromEnv({}).curatedRelayers).toBe(true);
    expect(configFromEnv({ VITE_CLASSIC_RELAYERS_CURATED: "0" }).curatedRelayers).toBe(false);
    expect(() => configFromEnv({ VITE_CLASSIC_RELAYERS_CURATED: "0", PROD: true })).toThrow(/development chains only/);
  });
});
