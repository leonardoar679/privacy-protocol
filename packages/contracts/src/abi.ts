// The ABIs and creation code of the contracts (spec v2.0 §10), as forge exports them (contracts/scripts/export-abi.mjs →
// contracts/abi). The wallet, the relayer and the swap engine import them from here, never by a relative path into
// contracts/ and never as a copy.
import type { Abi, Hex } from "viem";
import privacyCore from "../../../contracts/abi/PrivacyCore.json";
import assetVaultFactory from "../../../contracts/abi/AssetVaultFactory.json";
import nativeAssetVault from "../../../contracts/abi/NativeAssetVault.json";
import erc20AssetVault from "../../../contracts/abi/ERC20AssetVault.json";
import groth16Verifier from "../../../contracts/abi/Groth16Verifier.json";
import poseidon2Hasher from "../../../contracts/abi/Poseidon2Hasher.json";
import swapOrderEscrow from "../../../contracts/abi/periphery/SwapOrderEscrow.json";
import swapOrderFactory from "../../../contracts/abi/periphery/SwapOrderFactory.json";
import protectRouter from "../../../contracts/abi/periphery/ProtectRouter.json";
import shieldReceiverFactory from "../../../contracts/abi/periphery/ShieldReceiverFactory.json";
import shieldReceiver from "../../../contracts/abi/periphery/ShieldReceiver.json";

export const ABI = {
  privacyCore: privacyCore as Abi,
  assetVaultFactory: assetVaultFactory as Abi,
  nativeAssetVault: nativeAssetVault as Abi,
  erc20AssetVault: erc20AssetVault as Abi,
  groth16Verifier: groth16Verifier as Abi,
  poseidon2Hasher: poseidon2Hasher as Abi,
  swapOrderEscrow: swapOrderEscrow.abi as Abi,
  swapOrderFactory: swapOrderFactory.abi as Abi,
  protectRouter: protectRouter.abi as Abi,
  shieldReceiverFactory: shieldReceiverFactory.abi as Abi,
  shieldReceiver: shieldReceiver.abi as Abi,
} as const;

/** Creation code: the escrow's and the shield receiver's are part of their CREATE2 addresses (the wallet recomputes
 *  every escrow it funds and every receiver it names); the router's and the factories' deploy them on a devnet. */
export const BYTECODE = {
  swapOrderEscrow: swapOrderEscrow.bytecode as Hex,
  swapOrderFactory: swapOrderFactory.bytecode as Hex,
  protectRouter: protectRouter.bytecode as Hex,
  shieldReceiverFactory: shieldReceiverFactory.bytecode as Hex,
  shieldReceiver: shieldReceiver.bytecode as Hex,
} as const;
