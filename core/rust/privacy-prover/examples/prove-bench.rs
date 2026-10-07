//! Proving benchmark on a real witness: where the time goes (zkey parse, the native witness from the
//! circuit inputs, QAP witness map, each multi-scalar multiplication) and the end-to-end proof. Run it
//! on the device you care about (docs/mobile.md "proving benchmarks"):
//!   cargo run --release -p privacy-prover --example prove-bench -- <zkey> <wtns> [runs]
//! Defaults: the dev zkey and the ok-transfer witness of circuits/build (core/rust/scripts/gen-prover-fixtures.mjs);
//! the native witness step runs when circuits/build/transaction_js/transaction.wasm is there.
use ark_bn254::{Fr, G1Projective, G2Projective};
use ark_ec::VariableBaseMSM;
use ark_ff::PrimeField;
use ark_groth16::r1cs_to_qap::R1CSToQAP;
use ark_poly::GeneralEvaluationDomain;
use privacy_prover::qap::CircomReduction;
use privacy_prover::{fr_from_bytes, inputs_from_json, prove, public_inputs, read_wtns, read_zkey, verify, WitnessCalculator};
use std::path::PathBuf;
use std::time::Instant;

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn main() {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let args: Vec<String> = std::env::args().skip(1).collect();
    let zkey_path = args.first().map(PathBuf::from).unwrap_or_else(|| repo.join("circuits/build/setup/transaction_final.zkey"));
    let wtns_path = args.get(1).map(PathBuf::from).unwrap_or_else(|| repo.join("circuits/build/prover-fixtures/ok-transfer.wtns"));
    let runs: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(3);

    let bytes = std::fs::read(&zkey_path).unwrap_or_else(|e| panic!("{}: {e}", zkey_path.display()));
    let t = Instant::now();
    let zkey = read_zkey(&bytes).expect("zkey");
    println!("zkey parse: {:.0} ms ({} constraints, {} signals, domain 2^{})", ms(t), zkey.matrices.num_constraints, zkey.n_vars, zkey.domain_size.trailing_zeros());
    let w = read_wtns(&std::fs::read(&wtns_path).unwrap_or_else(|e| panic!("{}: {e}", wtns_path.display()))).expect("wtns");
    let circuit_wasm = repo.join("circuits/build/transaction_js/transaction.wasm");
    if circuit_wasm.exists() {
        let t = Instant::now();
        let mut calc = WitnessCalculator::new(&std::fs::read(&circuit_wasm).unwrap()).expect("circuit wasm");
        let load = ms(t);
        let input: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(repo.join("circuits/test/fixtures/v1/ok-transfer.json")).unwrap()).unwrap();
        let inputs = inputs_from_json(&input).unwrap();
        let t = Instant::now();
        let native = calc.calculate(&inputs).expect("witness");
        println!("native witness (wasmi, {} signals): {:.0} ms (module {load:.0} ms){}", native.len(), ms(t), if wtns_path.ends_with("ok-transfer.wtns") { if native == w { ", == the snarkjs .wtns" } else { ", DIFFERS from the snarkjs .wtns" } } else { "" });
    }
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    println!("threads available: {threads} (rayon {})", if cfg!(target_arch = "wasm32") { "off" } else { "on" });

    let t = Instant::now();
    let h = CircomReduction::witness_map_from_matrices::<Fr, GeneralEvaluationDomain<Fr>>(&zkey.matrices, zkey.matrices.num_instance_variables, zkey.matrices.num_constraints, &w).unwrap();
    println!("QAP witness map (7 FFTs of 2^{}): {:.0} ms", zkey.domain_size.trailing_zeros(), ms(t));

    let big = |xs: &[Fr]| xs.iter().map(|x| x.into_bigint()).collect::<Vec<_>>();
    let wb = big(&w);
    let aux = big(&w[zkey.n_public + 1..]);
    let hb = big(&h);
    let t = Instant::now();
    let _ = G1Projective::msm_bigint(&zkey.pk.a_query, &wb);
    println!("MSM A  (G1 × {}): {:.0} ms", wb.len(), ms(t));
    let t = Instant::now();
    let _ = G1Projective::msm_bigint(&zkey.pk.b_g1_query, &wb);
    println!("MSM B1 (G1 × {}): {:.0} ms", wb.len(), ms(t));
    let t = Instant::now();
    let _ = G2Projective::msm_bigint(&zkey.pk.b_g2_query, &wb);
    println!("MSM B2 (G2 × {}): {:.0} ms", wb.len(), ms(t));
    let t = Instant::now();
    let _ = G1Projective::msm_bigint(&zkey.pk.l_query, &aux);
    println!("MSM L  (G1 × {}): {:.0} ms", aux.len(), ms(t));
    let t = Instant::now();
    let _ = G1Projective::msm_bigint(&zkey.pk.h_query, &hb);
    println!("MSM H  (G1 × {}): {:.0} ms", hb.len(), ms(t));

    let (r, s) = (fr_from_bytes(&[7u8; 32]), fr_from_bytes(&[9u8; 32]));
    let mut best = f64::MAX;
    for i in 0..runs {
        let t = Instant::now();
        let proof = prove(&zkey, &w, r + Fr::from(i as u64), s).expect("prove");
        let el = ms(t);
        best = best.min(el);
        assert!(verify(&zkey.pk.vk, &proof, public_inputs(&zkey, &w)));
        println!("prove #{i}: {el:.0} ms (verified)");
    }
    println!("best end-to-end proof: {best:.0} ms");
}
