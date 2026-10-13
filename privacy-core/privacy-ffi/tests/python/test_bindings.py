"""The UniFFI bindings of the Rust core and native prover, exercised from Python — the same generated
surface the Swift (iOS) and Kotlin (Android) wallets call, held to the vectors every other
implementation is pinned to: circuits/vectors/primitives.json (Poseidon2, keys, notes, nullifiers,
tree roots), packages/protocol/test/vectors/{envelope,wallet,chainkeys}.json (payload envelope,
privacy address, keystore / journal / phrase, chain keys), and — when the circuit is built — the
native proof the EVM verifier accepts (contracts/test/verifier/NativeProofFixtures.sol).

Run by privacy-core/scripts/ffi-bindings.mjs, which builds the library, generates the bindings and points
PRIVACY_FFI_BINDINGS at them. The prover tests need circuits/build (the dev zkey + transaction.wasm);
without it they are skipped, unless PRIVACY_PROVER_REQUIRE_ARTIFACTS is set.
"""
import json
import os
import re
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, os.environ.get("PRIVACY_FFI_BINDINGS", str(Path(__file__).resolve().parents[3] / "target" / "bindings" / "python")))
import privacy_ffi as ffi  # noqa: E402

REPO = Path(__file__).resolve().parents[4]
EXAMPLE_SEED = b"privacy-protocol/example-master-seed"


def vectors(rel):
    return json.loads((REPO / rel).read_text(encoding="utf-8"))


def be32(n):
    return int(n).to_bytes(32, "big")


def num(b):
    return int.from_bytes(b, "big")


def hash2(a, b):
    return num(ffi.poseidon2_hash(be32(a) + be32(b)))


class Primitives(unittest.TestCase):
    p = vectors("circuits/vectors/primitives.json")

    def test_poseidon2_matches_the_nargo_vectors(self):
        cases = {"hash([0])": [0], "hash([1])": [1], "hash([0,0])": [0, 0], "hash([1,2])": [1, 2], "hash([0,0,0])": [0, 0, 0], "hash([1,2,3])": [1, 2, 3], "hash([1,2,3,4])": [1, 2, 3, 4]}
        for name, xs in cases.items():
            self.assertEqual(num(ffi.poseidon2_hash(b"".join(be32(x) for x in xs))), int(self.p["poseidon2"][name]), name)
        with self.assertRaises(ffi.CoreError.Invalid):
            ffi.poseidon2_hash(b"\x00" * 31)
        with self.assertRaises(ffi.CoreError.Invalid):  # a word >= p is not a field element
            ffi.poseidon2_hash(b"\xff" * 32)

    def test_keys_note_commitment_nullifier(self):
        k = ffi.derive_wallet_keys(EXAMPLE_SEED)
        self.assertEqual(num(k.spend_key), int(self.p["keys"]["spendKey"]))
        self.assertEqual(num(k.view_key), int(self.p["keys"]["viewKey"]))
        self.assertEqual(num(k.note_key), int(self.p["keys"]["noteKey"]))
        s = self.p["sampleNote"]
        oc = ffi.owner_commitment(k.spend_key)
        self.assertEqual(num(oc), int(s["ownerCommitment"]))
        secret = ffi.derive_note_secret(k.note_key, 0)
        self.assertEqual(num(secret), int(s["noteSecret"]))
        note = ffi.Note(vault_id=be32(s["vaultId"]), amount=be32(s["amount"]), owner_commitment=oc, note_secret=secret)
        c = ffi.note_commitment(note, int(s["leafIndex"]))
        self.assertEqual(num(c), int(s["commitment"]))
        self.assertEqual(num(ffi.nullifier(c, k.spend_key)), int(s["nullifier"]))

    def test_tree_roots_paths_and_tx_domain(self):
        t = self.p["tree"]
        levels = int(t["levels"])
        zero = int(self.p["zeroLeaf"])
        self.assertEqual(num(ffi.merkle_root(b"", levels)), int(t["emptyRoot"]))
        deposit = [int(self.p["sampleNote"]["commitment"]), zero, zero, zero]
        self.assertEqual(num(ffi.merkle_root(b"".join(map(be32, deposit)), levels)), int(t["rootAfterDeposit"]))
        leaves = deposit + [int(x) for x in t["outputs"]] + [zero]
        packed = b"".join(map(be32, leaves))
        root = num(ffi.merkle_root(packed, levels))
        self.assertEqual(root, int(t["rootAfterTx"]))
        for i in (0, 5, 7):
            path = ffi.merkle_path(packed, i, levels)
            self.assertEqual(num(path.root), root)
            h = leaves[i]
            for sib, bit in zip(path.path_elements, path.path_indices):
                h = hash2(num(sib), h) if bit else hash2(h, num(sib))
            self.assertEqual(h, root, f"leaf {i} folds to the root")
        with self.assertRaises(ffi.CoreError.Invalid):
            ffi.merkle_path(packed, 8, levels)
        self.assertEqual(len(ffi.tx_domain(31337, bytes.fromhex("000000000000000000000000000000000000cafe"))), 32)
        self.assertNotEqual(ffi.tx_domain(1, b"\x01" * 20), ffi.tx_domain(31337, b"\x01" * 20))


class EnvelopeAndAddress(unittest.TestCase):
    v = vectors("packages/protocol/test/vectors/envelope.json")

    def test_pinned_envelopes_and_addresses(self):
        for case in self.v["cases"]:
            k = ffi.derive_wallet_keys(case["seed"].encode())
            view_pub = ffi.view_public_key(k.view_key)
            self.assertEqual(view_pub.hex(), case["viewPub"])
            plain = ffi.NotePlaintext(amount=be32(case["amount"]), note_secret=be32(case["noteSecret"]), vault_id=be32(case["vaultId"]))
            data = ffi.encrypt_note_data(view_pub, plain, bytes.fromhex(case["ephemeralSecret"].removeprefix("0x")), bytes.fromhex(case["nonce"].removeprefix("0x")))
            self.assertEqual(data.hex(), case["noteData"], "pinned envelope bytes")
            self.assertEqual(num(ffi.note_data_hash(data)), int(case["noteDataHash"]))
            self.assertEqual(ffi.decrypt_note_data(k.view_key, data), plain)
            for i in (0, 1, 33, 57, 168):
                t = bytearray(data)
                t[i] ^= 1
                self.assertIsNone(ffi.decrypt_note_data(k.view_key, bytes(t)), f"tampered byte {i}")
            self.assertIsNone(ffi.decrypt_note_data(ffi.derive_wallet_keys(b"someone else").view_key, data))
            oc = ffi.owner_commitment(k.spend_key)
            addr = ffi.privacy_address(oc, view_pub)
            self.assertEqual(addr, case["address"])
            back = ffi.parse_privacy_address(addr)
            self.assertEqual((back.owner_commitment, back.view_pub), (oc, view_pub))
            typo = addr[:40] + ("p" if addr[40] == "q" else "q") + addr[41:]
            with self.assertRaises(ffi.CoreError.Invalid):
                ffi.parse_privacy_address(typo)

    def test_note_discovery_over_a_payload_set(self):
        me = ffi.derive_wallet_keys(EXAMPLE_SEED)
        other = ffi.derive_wallet_keys(b"someone else")
        oc = ffi.owner_commitment(me.spend_key)
        mine = ffi.Note(vault_id=be32(171), amount=be32(5 * 10**17), owner_commitment=oc, note_secret=ffi.derive_note_secret(me.note_key, 3))
        plain = ffi.NotePlaintext(amount=mine.amount, note_secret=mine.note_secret, vault_id=mine.vault_id)
        eph, nonce = b"\x11" * 32, b"\x22" * 24
        items = [
            (4, ffi.note_commitment(mine, 4), ffi.encrypt_note_data(ffi.view_public_key(me.view_key), plain, eph, nonce)),
            (5, be32(5555), ffi.encrypt_note_data(ffi.view_public_key(other.view_key), plain, eph, nonce)),
            (6, be32(123456), ffi.encrypt_note_data(ffi.view_public_key(me.view_key), plain, b"\x33" * 32, nonce)),  # decrypts, lies about its leaf
            (7, be32(7), b"\x01" + bytes(range(168))),  # a dummy
        ]
        found = ffi.scan_note_payloads(me.view_key, oc, [i for i, _, _ in items], b"".join(c for _, c, _ in items), b"".join(d for _, _, d in items))
        self.assertEqual([(d.leaf_index, d.amount, d.note_secret, d.vault_id) for d in found], [(4, mine.amount, mine.note_secret, mine.vault_id)])
        with self.assertRaises(ffi.CoreError.Invalid):
            ffi.scan_note_payloads(me.view_key, oc, [1, 2], be32(1), b"\x00" * 169)


class Recovery(unittest.TestCase):
    w = vectors("packages/protocol/test/vectors/wallet.json")

    def test_keystore_of_the_web_wallet_opens_and_is_reproduced(self):
        k = self.w["keystore"]
        seed = bytes.fromhex(k["seed"].removeprefix("0x"))
        pinned = json.dumps(k["keystore"])
        self.assertEqual(ffi.unlock_keystore(pinned, k["password"]), seed)
        self.assertIsNone(ffi.unlock_keystore(pinned, "wrong password"))
        n = int(k["kdf"]["N"])
        ours = ffi.create_keystore(seed, k["password"], n.bit_length() - 1, bytes.fromhex(k["salt"].removeprefix("0x")), bytes.fromhex(k["nonce"].removeprefix("0x")))
        self.assertEqual(json.loads(ours), k["keystore"], "byte-identical keystore")
        self.assertEqual(ffi.seed_to_phrase(seed), k["phrase"])
        self.assertEqual(ffi.phrase_to_seed(k["phrase"].upper()), seed)
        self.assertTrue(ffi.validate_phrase(k["phrase"]))
        self.assertFalse(ffi.validate_phrase(" ".join(["abandon"] * 12)))
        with self.assertRaises(ffi.CoreError.Invalid):
            ffi.create_keystore(seed, "pw", 4, b"\x00" * 16, b"\x00" * 24)  # unsafe scrypt cost

    def test_journal_and_bip39(self):
        j = self.w["journal"]
        seed = bytes.fromhex(j["seed"].removeprefix("0x"))
        key = ffi.journal_key(seed)
        self.assertEqual(key.hex(), j["key"])
        self.assertEqual(ffi.decrypt_journal(key, json.dumps(j["encrypted"])), j["plaintext"])
        self.assertEqual(json.loads(ffi.encrypt_journal(key, j["plaintext"], bytes.fromhex(j["nonce"].removeprefix("0x")))), j["encrypted"])
        self.assertIsNone(ffi.decrypt_journal(ffi.journal_key(b"\x00" * 32), json.dumps(j["encrypted"])))
        for case in self.w["bip39"]:
            self.assertEqual(ffi.mnemonic_to_seed(case["mnemonic"], "").hex(), case["seed"])
            self.assertEqual(ffi.mnemonic_to_seed(case["mnemonic"], "TREZOR").hex(), case["seedWithPassphrase"])


class ChainKeys(unittest.TestCase):
    v = vectors("packages/protocol/test/vectors/chainkeys.json")

    def test_fresh_addresses_per_chain_and_per_dapp(self):
        seed64 = ffi.mnemonic_to_seed(self.v["bip84"]["mnemonic"], "")
        btc = ffi.chain_address(ffi.Chain.BITCOIN, seed64, 0)
        self.assertEqual((btc.path, btc.address, btc.public_key.hex()), (self.v["bip84"]["receive0"]["path"], self.v["bip84"]["receive0"]["address"], self.v["bip84"]["receive0"]["publicKey"]))
        self.assertEqual(ffi.chain_address(ffi.Chain.EVM, seed64, 0).address, self.v["bip44_evm"]["account0"]["address"])
        sol = ffi.chain_address(ffi.Chain.SOLANA, seed64, 0)
        self.assertEqual((sol.path, sol.address), (self.v["solana"]["account0"]["path"], self.v["solana"]["account0"]["address"]))
        self.assertNotEqual(ffi.chain_address(ffi.Chain.SOLANA, seed64, 1).address, sol.address)
        site = ffi.dapp_address(seed64, "https://app.example")
        self.assertEqual(site.address, ffi.dapp_address(seed64, "https://APP.example").address)
        self.assertNotEqual(site.address, ffi.dapp_address(seed64, "https://other.example").address)
        self.assertEqual(site.chain, ffi.Chain.EVM)


ZKEY = REPO / "circuits/build/setup/transaction_final.zkey"
WASM = REPO / "circuits/build/transaction_js/transaction.wasm"
HAVE_ARTIFACTS = ZKEY.exists() and WASM.exists()
if not HAVE_ARTIFACTS and os.environ.get("PRIVACY_PROVER_REQUIRE_ARTIFACTS"):
    raise SystemExit(f"missing {ZKEY} or {WASM}: build the circuit and the dev setup")


def solidity_fixture_words():
    """The 22 words (a, b, c, 14 public inputs) per fixture function, in file order: transfer, withdraw."""
    text = (REPO / "contracts/test/verifier/NativeProofFixtures.sol").read_text(encoding="utf-8")
    words = [int(h, 16) for h in re.findall(r"0x[0-9a-f]{64}", text)]
    assert len(words) == 44, len(words)
    return {"ok-transfer": words[:22], "ok-withdraw": words[22:]}


@unittest.skipUnless(HAVE_ARTIFACTS, "circuits/build missing: build the circuit + dev setup (circuits/scripts)")
class NativeProving(unittest.TestCase):
    prover = None

    @classmethod
    def setUpClass(cls):
        t0 = time.perf_counter()
        cls.prover = ffi.Prover(ZKEY.read_bytes(), WASM.read_bytes())
        print(f"\n  Prover loaded in {1000 * (time.perf_counter() - t0):.0f} ms", file=sys.stderr)

    def inputs(self, name):
        return (REPO / f"circuits/test/fixtures/v1/{name}.json").read_text(encoding="utf-8")

    def test_inputs_to_the_proof_the_evm_verifier_accepts(self):
        self.assertEqual(self.prover.public_input_count(), 14)
        fixture = solidity_fixture_words()
        for name in ("ok-transfer", "ok-withdraw"):
            t0 = time.perf_counter()
            p = self.prover.prove(self.inputs(name), b"\x52" * 32, b"\x53" * 32)  # the fixture's blinding
            ms = 1000 * (time.perf_counter() - t0)
            self.assertEqual(len(p.proof), 256)
            got = [num(p.proof[i * 32:(i + 1) * 32]) for i in range(8)] + [num(x) for x in p.public_inputs]
            self.assertEqual(got, fixture[name], f"{name}: the bytes forge verifies on the on-chain verifier")
            self.assertTrue(self.prover.verify(p.proof, p.public_inputs))
            tampered = list(p.public_inputs)
            tampered[13] = be32(num(tampered[13]) + 1)
            self.assertFalse(self.prover.verify(p.proof, tampered), "the tx domain is bound")
            proof_json = json.loads(p.proof_json)
            self.assertEqual(proof_json["protocol"], "groth16")
            print(f"  {name}: inputs -> witness -> proof in {ms:.0f} ms through the bindings", file=sys.stderr)

    def test_fresh_blinding_gives_a_different_valid_proof(self):
        a = self.prover.prove(self.inputs("ok-two-inputs"), os.urandom(32), os.urandom(32))
        b = self.prover.prove(self.inputs("ok-two-inputs"), os.urandom(32), os.urandom(32))
        self.assertNotEqual(a.proof, b.proof)
        self.assertEqual(a.public_inputs, b.public_inputs)
        self.assertTrue(self.prover.verify(b.proof, b.public_inputs))

    def test_invalid_inputs_never_reach_the_prover(self):
        with self.assertRaises(ffi.CoreError.Witness) as e:
            self.prover.prove(self.inputs("attack-inflation"), b"\x01" * 32, b"\x02" * 32)
        self.assertIn("assert failed", str(e.exception))
        with self.assertRaises(ffi.CoreError.Invalid):
            self.prover.prove("{not json", b"\x01" * 32, b"\x02" * 32)
        with self.assertRaises(ffi.CoreError.Proving):
            self.prover.prove(self.inputs("ok-transfer"), b"\x00" * 32, b"\x02" * 32)  # zero blinding
        with self.assertRaises(ffi.CoreError.Invalid):
            self.prover.verify(b"\x00" * 255, [b"\x00" * 32] * 14)
        with self.assertRaises(ffi.CoreError.Invalid):
            ffi.Prover(b"zkex", WASM.read_bytes())


if __name__ == "__main__":
    unittest.main(verbosity=2)
