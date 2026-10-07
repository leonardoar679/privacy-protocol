//! The native prover against the circuit's real artifacts: the dev proving key snarkjs uses
//! (circuits/build/setup/transaction_final.zkey), the published verification key
//! (circuits/setup/dev/verification_key.json), and the witnesses + snarkjs proofs of the four v1
//! fixtures (circuits/build/prover-fixtures, written by core/rust/scripts/gen-prover-fixtures.mjs).
//!
//! Both directions are checked: a native proof verifies under the published key (and a tampered
//! statement does not), a snarkjs proof verifies natively, the calldata encoding is snarkjs' own, and
//! the native proofs with the fixture blinding are exactly the ones the EVM verifier accepts
//! (contracts/test/verifier/NativeProofFixtures.sol, regenerated with UPDATE_NATIVE_PROOF_FIXTURE=1).
//!
//! The artifacts are build outputs (gitignored). When they are missing the tests say so and pass,
//! unless PRIVACY_PROVER_REQUIRE_ARTIFACTS is set — scripts/verify-all.mjs sets it whenever the
//! circuit is built, so the full verification never skips them silently.
use ark_bn254::{Bn254, Fq, Fq2, Fr, G1Affine, G2Affine};
use ark_ff::{BigInteger, PrimeField};
use ark_groth16::VerifyingKey;
use privacy_prover::export::dec_fr;
use privacy_prover::*;
use serde_json::Value;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::OnceLock;
use std::time::Instant;

const FIXTURES: [&str; 4] = ["ok-transfer", "ok-withdraw", "ok-two-inputs", "ok-relayer-fee"];
/// The fixture proofs' blinding scalars. Fixed so the committed Solidity fixture is reproducible;
/// a wallet passes fresh CSPRNG scalars for every proof.
const FIXTURE_R: [u8; 32] = [0x52; 32];
const FIXTURE_S: [u8; 32] = [0x53; 32];
const SOL_FIXTURE: &str = "contracts/test/verifier/NativeProofFixtures.sol";

fn repo(rel: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").join(rel)
}

struct Fixture {
    name: &'static str,
    witness: Vec<Fr>,
    snarkjs: Value,
}
struct Artifacts {
    zkey: Zkey,
    zkey_bytes: Vec<u8>,
    published_vk: VerifyingKey<Bn254>,
    fixtures: Vec<Fixture>,
    parse_ms: u128,
}

fn fq(v: &Value) -> Fq {
    Fq::from_str(v.as_str().expect("decimal string")).expect("base field element")
}
fn g1_json(p: &Value) -> G1Affine {
    G1Affine::new(fq(&p[0]), fq(&p[1]))
}
fn g2_json(p: &Value) -> G2Affine {
    G2Affine::new(Fq2::new(fq(&p[0][0]), fq(&p[0][1])), Fq2::new(fq(&p[1][0]), fq(&p[1][1])))
}
/// The verifying key exactly as snarkjs published it — independent of the zkey parser.
fn vk_from_json(v: &Value) -> VerifyingKey<Bn254> {
    VerifyingKey {
        alpha_g1: g1_json(&v["vk_alpha_1"]),
        beta_g2: g2_json(&v["vk_beta_2"]),
        gamma_g2: g2_json(&v["vk_gamma_2"]),
        delta_g2: g2_json(&v["vk_delta_2"]),
        gamma_abc_g1: v["IC"].as_array().unwrap().iter().map(g1_json).collect(),
    }
}

fn load() -> Option<Artifacts> {
    let zkey_path = repo("circuits/build/setup/transaction_final.zkey");
    let fixture_dir = repo("circuits/build/prover-fixtures");
    if !zkey_path.exists() || !fixture_dir.join("ok-transfer.wtns").exists() {
        return None;
    }
    let zkey_bytes = std::fs::read(&zkey_path).unwrap();
    let t0 = Instant::now();
    let zkey = read_zkey(&zkey_bytes).expect("the dev zkey parses");
    let parse_ms = t0.elapsed().as_millis();
    let published_vk = vk_from_json(&serde_json::from_str(&std::fs::read_to_string(repo("circuits/setup/dev/verification_key.json")).unwrap()).unwrap());
    let fixtures = FIXTURES
        .iter()
        .map(|&name| Fixture {
            name,
            witness: read_wtns(&std::fs::read(fixture_dir.join(format!("{name}.wtns"))).unwrap()).expect("the snarkjs witness parses"),
            snarkjs: serde_json::from_str(&std::fs::read_to_string(fixture_dir.join(format!("{name}.proof.json"))).unwrap()).unwrap(),
        })
        .collect();
    Some(Artifacts { zkey, zkey_bytes, published_vk, fixtures, parse_ms })
}

fn artifacts() -> Option<&'static Artifacts> {
    static CELL: OnceLock<Option<Artifacts>> = OnceLock::new();
    let a = CELL.get_or_init(load).as_ref();
    if a.is_none() {
        let hint = "circuits/build/setup/transaction_final.zkey + circuits/build/prover-fixtures are missing: build the circuit and the dev setup, then run node core/rust/scripts/gen-prover-fixtures.mjs";
        if std::env::var_os("PRIVACY_PROVER_REQUIRE_ARTIFACTS").is_some() {
            panic!("{hint}");
        }
        eprintln!("SKIPPED (no artifacts): {hint}");
    }
    a
}

fn blinding() -> (Fr, Fr) {
    (fr_from_bytes(&FIXTURE_R), fr_from_bytes(&FIXTURE_S))
}

#[test]
fn zkey_parses_into_the_published_verifying_key() {
    let Some(a) = artifacts() else { return };
    assert_eq!(a.zkey.n_public, 14, "the Transaction circuit has 14 public inputs (PrivacyCore.encodePublicInputs)");
    assert_eq!(a.zkey.pk.vk, a.published_vk, "alpha, beta, gamma, delta and every IC point equal verification_key.json");
    assert!(a.zkey.domain_size.is_power_of_two());
    assert!(a.zkey.matrices.num_constraints + a.zkey.n_public + 1 <= a.zkey.domain_size);
    assert_eq!(a.zkey.pk.a_query.len(), a.zkey.n_vars);
    assert_eq!(a.zkey.pk.l_query.len(), a.zkey.n_vars - a.zkey.n_public - 1);
    assert_eq!(a.zkey.pk.h_query.len(), a.zkey.domain_size);
    eprintln!(
        "zkey: {} constraints, {} signals, domain 2^{}, parsed in {} ms",
        a.zkey.matrices.num_constraints,
        a.zkey.n_vars,
        a.zkey.domain_size.trailing_zeros(),
        a.parse_ms
    );
}

#[test]
fn witnesses_carry_the_public_signals_snarkjs_proved() {
    let Some(a) = artifacts() else { return };
    for f in &a.fixtures {
        assert_eq!(f.witness.len(), a.zkey.n_vars, "{}: witness length", f.name);
        assert_eq!(f.witness[0], Fr::from(1u64));
        let public: Vec<String> = public_inputs(&a.zkey, &f.witness).iter().map(dec_fr).collect();
        let snark: Vec<String> = f.snarkjs["publicSignals"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert_eq!(public, snark, "{}: the witness's public inputs are the ones snarkjs proved", f.name);
    }
}

#[test]
fn native_proofs_verify_under_the_published_key_and_bind_every_public_input() {
    let Some(a) = artifacts() else { return };
    let (r, s) = blinding();
    for f in &a.fixtures {
        let t0 = Instant::now();
        let proof = prove(&a.zkey, &f.witness, r, s).expect("proves");
        let ms = t0.elapsed().as_millis();
        let public = public_inputs(&a.zkey, &f.witness);
        assert!(verify(&a.published_vk, &proof, public), "{}: the native proof verifies under verification_key.json", f.name);
        for k in 0..public.len() {
            let mut tampered = public.to_vec();
            tampered[k] += Fr::from(1u64);
            assert!(!verify(&a.published_vk, &proof, &tampered), "{}: public input {k} is bound", f.name);
        }
        // fresh blinding: a different proof of the same statement, equally valid
        let other = prove(&a.zkey, &f.witness, r + Fr::from(1u64), s + Fr::from(7u64)).unwrap();
        assert_ne!(other, proof);
        assert!(verify(&a.published_vk, &other, public));
        eprintln!("{}: native proof in {ms} ms (snarkjs {} ms)", f.name, f.snarkjs["snarkjsMs"]);
    }
    // a proof of one statement does not verify against another's public inputs
    let transfer = prove(&a.zkey, &a.fixtures[0].witness, r, s).unwrap();
    assert!(!verify(&a.published_vk, &transfer, public_inputs(&a.zkey, &a.fixtures[1].witness)));
}

#[test]
fn snarkjs_proofs_verify_natively_and_export_to_the_same_calldata() {
    let Some(a) = artifacts() else { return };
    for f in &a.fixtures {
        let json: ProofJson = serde_json::from_value(f.snarkjs["proof"].clone()).unwrap();
        let proof = from_snarkjs(&json).expect("a snarkjs proof imports");
        assert!(verify(&a.published_vk, &proof, public_inputs(&a.zkey, &f.witness)), "{}: snarkjs' proof verifies natively", f.name);
        assert_eq!(to_snarkjs(&proof), json, "{}: the JSON form round-trips", f.name);
        let ours = to_calldata(&proof);
        let hex_words = |v: &Value| -> Vec<String> { v.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect() };
        let dec = |h: &String| -> String { Fq::from_be_bytes_mod_order(&hex_to_bytes(h)).into_bigint().to_string() };
        let cd = &f.snarkjs["calldata"];
        assert_eq!(ours.a.to_vec(), hex_words(&cd["a"]).iter().map(dec).collect::<Vec<_>>(), "{}: a", f.name);
        assert_eq!(ours.b[0].to_vec(), hex_words(&cd["b"][0]).iter().map(dec).collect::<Vec<_>>(), "{}: b[0] (limbs swapped as exportSolidityCallData)", f.name);
        assert_eq!(ours.b[1].to_vec(), hex_words(&cd["b"][1]).iter().map(dec).collect::<Vec<_>>(), "{}: b[1]", f.name);
        assert_eq!(ours.c.to_vec(), hex_words(&cd["c"]).iter().map(dec).collect::<Vec<_>>(), "{}: c", f.name);
        // the 256-byte `proof` argument of transact is those eight words
        let bytes = calldata_bytes(&proof);
        let words: Vec<String> = bytes.chunks(32).map(|w| Fq::from_be_bytes_mod_order(w).into_bigint().to_string()).collect();
        assert_eq!(words, [ours.a.to_vec(), ours.b[0].to_vec(), ours.b[1].to_vec(), ours.c.to_vec()].concat());
    }
}

fn hex_to_bytes(h: &str) -> Vec<u8> {
    let h = h.trim_start_matches("0x");
    let h = if h.len() % 2 == 1 { format!("0{h}") } else { h.to_string() };
    (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap()).collect()
}

fn word_hex(x: &str) -> String {
    let v = Fq::from_str(x).unwrap().into_bigint().to_bytes_be();
    format!("0x{}", v.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// The Solidity fixture: transfer() and withdraw() with a, b (EVM limb order), c and the 14 inputs.
fn solidity_fixture(sets: &[(&str, &Calldata, Vec<String>)]) -> String {
    let arr = |xs: &[String]| format!("[uint256({}), {}]", xs[0], xs[1..].join(", "));
    let mut out = String::from(
        "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24;\n\n\
// GENERATED by core/rust/privacy-prover/tests/prover.rs (UPDATE_NATIVE_PROOF_FIXTURE=1) — DO NOT EDIT.\n\
// Groth16 proofs of circuits/test/fixtures/v1/{ok-transfer,ok-withdraw} made by the NATIVE Rust prover\n\
// (core/rust/privacy-prover) from snarkjs' witnesses, with fixed blinding scalars, under the INSECURE dev\n\
// setup. The same statements as DevProofFixtures (snarkjs), different proof bytes.\n\
library NativeProofFixtures {\n    struct Fixture {\n        uint256[2] a;\n        uint256[2][2] b;\n        uint256[2] c;\n        uint256[14] pub;\n    }\n",
    );
    for (fname, cd, public) in sets {
        let h = |xs: &[String]| xs.iter().map(|x| word_hex(x)).collect::<Vec<_>>();
        out += &format!(
            "\n    function {fname}() internal pure returns (Fixture memory f) {{\n        f.a = {};\n        f.b = [{}, {}];\n        f.c = {};\n        f.pub = {};\n    }}\n",
            arr(&h(&cd.a)),
            arr(&h(&cd.b[0])),
            arr(&h(&cd.b[1])),
            arr(&h(&cd.c)),
            arr(&h(public))
        );
    }
    out + "}\n"
}

#[test]
fn native_proofs_are_the_ones_the_evm_verifier_accepts() {
    let Some(a) = artifacts() else { return };
    let (r, s) = blinding();
    let mut sets = Vec::new();
    for (fname, idx) in [("transfer", 0usize), ("withdraw", 1usize)] {
        let f = &a.fixtures[idx];
        let proof = prove(&a.zkey, &f.witness, r, s).unwrap();
        assert_eq!(prove(&a.zkey, &f.witness, r, s).unwrap(), proof, "fixed blinding gives a deterministic proof");
        let public: Vec<String> = public_inputs(&a.zkey, &f.witness).iter().map(dec_fr).collect();
        sets.push((fname, to_calldata(&proof), public));
    }
    let refs: Vec<(&str, &Calldata, Vec<String>)> = sets.iter().map(|(n, c, p)| (*n, c, p.clone())).collect();
    let expected = solidity_fixture(&refs);
    let path = repo(SOL_FIXTURE);
    if std::env::var_os("UPDATE_NATIVE_PROOF_FIXTURE").is_some() {
        std::fs::write(&path, &expected).unwrap();
        eprintln!("wrote {SOL_FIXTURE}");
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default().replace("\r\n", "\n");
    assert_eq!(committed, expected, "{SOL_FIXTURE} is not what the native prover produces for this zkey: regenerate with UPDATE_NATIVE_PROOF_FIXTURE=1 (after a new dev setup) and run forge");
}

#[test]
fn refuses_malformed_witnesses_and_unblinded_proofs() {
    let Some(a) = artifacts() else { return };
    let (r, s) = blinding();
    let w = &a.fixtures[0].witness;
    assert_eq!(prove(&a.zkey, &w[..w.len() - 1], r, s).unwrap_err(), ProveError::WitnessLength { expected: a.zkey.n_vars, got: w.len() - 1 });
    let mut not_one = w.clone();
    not_one[0] = Fr::from(2u64);
    assert_eq!(prove(&a.zkey, &not_one, r, s).unwrap_err(), ProveError::NoConstantOne);
    assert_eq!(prove(&a.zkey, w, Fr::from(0u64), s).unwrap_err(), ProveError::ZeroBlinding);
    assert_eq!(prove(&a.zkey, w, r, Fr::from(0u64)).unwrap_err(), ProveError::ZeroBlinding);
    // a witness that does not satisfy the constraints still "proves" (Groth16 does not check), but the
    // proof is rejected: change one private signal deep in the witness
    let mut broken = w.clone();
    let k = broken.len() / 2;
    broken[k] += Fr::from(1u64);
    let bad = prove(&a.zkey, &broken, r, s).unwrap();
    assert!(!verify(&a.published_vk, &bad, public_inputs(&a.zkey, &broken)), "an unsatisfying witness never yields a valid proof");
}

#[test]
fn rejects_truncated_or_foreign_files() {
    let Some(a) = artifacts() else { return };
    assert!(matches!(read_zkey(b"zkex\x01\0\0\0"), Err(ZkeyError::BadMagic)));
    for cut in [3usize, 11, 200, 5_000, a.zkey_bytes.len() / 2, a.zkey_bytes.len() - 1] {
        assert!(read_zkey(&a.zkey_bytes[..cut]).is_err(), "a zkey cut at {cut} bytes is refused");
    }
    let wtns = std::fs::read(repo("circuits/build/prover-fixtures/ok-transfer.wtns")).unwrap();
    assert_eq!(read_wtns(b"wtnx").unwrap_err(), WtnsError::BadMagic);
    assert_eq!(read_wtns(&wtns[..wtns.len() - 5]).unwrap_err(), WtnsError::Truncated);
    let mut non_canonical = wtns.clone();
    let last = non_canonical.len() - 32; // the last witness element := p (not canonical)
    non_canonical[last..].copy_from_slice(&Fr::MODULUS.to_bytes_le());
    assert!(matches!(read_wtns(&non_canonical), Err(WtnsError::NonCanonical(_))));
}
