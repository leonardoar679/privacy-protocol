"""Differential test (plan §84): the Python reference must reproduce the nargo Poseidon2 vectors and
every protocol vector in circuits/vectors/primitives.json (produced by the TypeScript reference and
also reproduced by the circuit and the contracts). Run: python test_vectors.py  (or pytest)."""

import json
import sys
from pathlib import Path

from poseidon2 import hash as H, permute
import primitives as pp

VEC = json.loads((Path(__file__).resolve().parents[2] / "circuits" / "vectors" / "primitives.json").read_text())
v = lambda s: int(s)
SEED = b"privacy-protocol/example-master-seed"

results: list[tuple[str, bool]] = []


def check(name: str, got, want) -> None:
    ok = got == want
    results.append((name, ok))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + ("" if ok else f"\n      got  {got}\n      want {want}"))


def test_poseidon2_nargo_vectors():
    p = VEC["poseidon2"]
    check("permute([0,0,0,0])[0]", permute([0, 0, 0, 0])[0], v(p["permute([0,0,0,0])[0]"]))
    s = permute([1, 2, 3, 4])
    check("permute([1,2,3,4])[0]", s[0], v(p["permute([1,2,3,4])[0]"]))
    check("permute([1,2,3,4])[3]", s[3], v(p["permute([1,2,3,4])[3]"]))
    check("hash([0])", H([0]), v(p["hash([0])"]))
    check("hash([1])", H([1]), v(p["hash([1])"]))
    check("hash([0,0])", H([0, 0]), v(p["hash([0,0])"]))
    check("hash([1,2])", H([1, 2]), v(p["hash([1,2])"]))
    check("hash([0,0,0])", H([0, 0, 0]), v(p["hash([0,0,0])"]))
    check("hash([1,2,3])", H([1, 2, 3]), v(p["hash([1,2,3])"]))
    check("hash([1,2,3,4])", H([1, 2, 3, 4]), v(p["hash([1,2,3,4])"]))


def test_domains_and_keys():
    for tag in ["NOTE_BODY", "NOTE_COMMITMENT", "OWNER_COMMITMENT", "NULLIFIER", "PHANTOM_NULLIFIER"]:
        check(f"domain {tag}", getattr(pp, tag), v(VEC["domains"][tag]))
    check("TX_DOMAIN tag keccak", "0x" + pp.TX_DOMAIN_TAG.hex(), VEC["domains"]["TX_DOMAIN_TAG_KECCAK"])
    keys = pp.derive_keys(SEED)
    for k in ["spendKey", "viewKey", "noteKey"]:
        check(f"key {k}", keys[k], v(VEC["keys"][k]))
    check("zeroLeaf", pp.ZERO_LEAF, v(VEC["zeroLeaf"]))


def test_note_nullifier_phantom():
    keys = pp.derive_keys(SEED)
    sn = VEC["sampleNote"]
    oc = pp.owner_commitment(keys["spendKey"])
    check("ownerCommitment", oc, v(sn["ownerCommitment"]))
    secret = pp.derive_note_secret(keys["noteKey"], 0)
    check("noteSecret", secret, v(sn["noteSecret"]))
    note = pp.Note(v(sn["vaultId"]), v(sn["amount"]), oc, secret)
    body = pp.note_body(note)
    check("body", body, v(sn["body"]))
    cm = pp.note_commitment(body, 0)
    check("commitment", cm, v(sn["commitment"]))
    nf = pp.nullifier(cm, keys["spendKey"])
    check("nullifier", nf, v(sn["nullifier"]))
    check("phantom", pp.phantom_nullifier(nf, 1, keys["spendKey"]), v(sn["phantom"]))


def test_tree_and_bindings():
    t = pp.MerkleTree(VEC["tree"]["levels"])
    check("emptyRoot", t.root, v(VEC["tree"]["emptyRoot"]))
    t.insert_leaf(v(VEC["sampleNote"]["commitment"]))
    check("rootAfterDeposit", t.root, v(VEC["tree"]["rootAfterDeposit"]))
    outs = [v(x) for x in VEC["tree"]["outputs"]]
    t.insert_group([outs[0], outs[1], outs[2], pp.ZERO_LEAF])
    check("rootAfterTx", t.root, v(VEC["tree"]["rootAfterTx"]))
    nd = bytes.fromhex(VEC["noteDataExample"]["hex"][2:])
    check("noteDataHash", pp.note_data_hash(nd), v(VEC["noteDataExample"]["hash"]))
    ex = VEC["txDomainExample"]
    check("txDomain", pp.tx_domain(v(ex["chainId"]), v(ex["core"])), v(ex["txDomain"]))


def test_owner_keys():
    ok = json.loads((Path(__file__).resolve().parents[2] / "packages" / "protocol" / "test" / "vectors" / "owner-keys.json").read_text())
    keys = pp.derive_keys(ok["seed"].encode())
    check("owner keys: spendKey", keys["spendKey"], v(ok["spendKey"]))
    check("owner keys: main owner commitment", pp.owner_commitment(keys["spendKey"]), v(ok["mainOwnerCommitment"]))
    for k in ok["byCounter"]:
        secret = pp.derive_note_secret(keys["noteKey"], k["counter"])
        check(f"noteSecret {k['counter']}", secret, v(k["noteSecret"]))
        key = pp.derive_owner_key(keys["spendKey"], secret)
        check(f"ownerKey {k['counter']}", key, v(k["ownerKey"]))
        check(f"ownerCommitment {k['counter']}", pp.owner_commitment(key), v(k["ownerCommitment"]))
    for k in ok["edgeSecrets"]:
        key = pp.derive_owner_key(keys["spendKey"], v(k["noteSecret"]))
        check(f"ownerKey of secret {k['noteSecret']}", key, v(k["ownerKey"]))
    s = ok["sampleSpend"]
    secret = pp.derive_note_secret(keys["noteKey"], s["counter"])
    key = pp.derive_owner_key(keys["spendKey"], secret)
    body = pp.note_body(pp.Note(v(s["vaultId"]), v(s["amount"]), pp.owner_commitment(key), secret))
    check("sample spend: body", body, v(s["body"]))
    cm = pp.note_commitment(body, s["leafIndex"])
    check("sample spend: commitment", cm, v(s["commitment"]))
    check("sample spend: nullifier", pp.nullifier(cm, key), v(s["nullifier"]))
    check("sample spend: phantom", pp.phantom_nullifier(pp.nullifier(cm, key), 1, key), v(s["phantom"]))


if __name__ == "__main__":
    for fn in [test_poseidon2_nargo_vectors, test_domains_and_keys, test_note_nullifier_phantom, test_tree_and_bindings, test_owner_keys]:
        fn()
    failed = [n for n, ok in results if not ok]
    print(f"\nPython reference: {len(results) - len(failed)}/{len(results)} vectors match")
    sys.exit(1 if failed else 0)
