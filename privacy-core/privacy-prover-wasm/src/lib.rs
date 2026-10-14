//! Bench-only (V6 Stage 15; spec v2.0 §14.3): the native prover (`privacy-prover`) compiled to wasm32 — the circuit's
//! witness through the pure-Rust interpreter, arkworks' Groth16 single-threaded — so `benchmarks/proof/` can time it
//! against snarkjs on the same circuit inputs. The wallet adopts it only at 1.5× snarkjs's speed or better with
//! identical public signals; until then it is not shipped.
use ark_ff::{BigInteger, PrimeField};
use privacy_prover::{calldata_bytes, check_statement, fr_from_bytes, inputs_from_json, prove, public_inputs, read_zkey, WitnessCalculator};
use wasm_bindgen::prelude::*;

fn err<E: core::fmt::Debug>(e: E) -> JsError {
    JsError::new(&format!("{e:?}"))
}

fn scalar(b: &[u8]) -> Result<[u8; 32], JsError> {
    b.try_into().map_err(|_| JsError::new("a blinding scalar is 32 bytes"))
}

/// Proves `inputs_json` (the circuit inputs as snarkjs takes them) with the proving key and the circuit's own WASM,
/// from the caller's blinding scalars `r` and `s` (32 bytes each, from its CSPRNG). Returns the 256-byte calldata
/// proof followed by the public signals as 32-byte big-endian words.
#[wasm_bindgen]
pub fn prove_transaction(zkey: &[u8], circuit_wasm: &[u8], inputs_json: &str, r: &[u8], s: &[u8]) -> Result<Vec<u8>, JsError> {
    let zkey = read_zkey(zkey).map_err(err)?;
    let json: serde_json::Value = serde_json::from_str(inputs_json).map_err(err)?;
    let inputs = inputs_from_json(&json).map_err(err)?;
    let mut calc = WitnessCalculator::new(circuit_wasm).map_err(err)?;
    let witness = calc.calculate(&inputs).map_err(err)?;
    check_statement(&inputs, &witness).map_err(err)?;
    let proof = prove(&zkey, &witness, fr_from_bytes(&scalar(r)?), fr_from_bytes(&scalar(s)?)).map_err(err)?;
    let mut out = calldata_bytes(&proof).to_vec();
    for x in public_inputs(&zkey, &witness) {
        out.extend(x.into_bigint().to_bytes_be());
    }
    Ok(out)
}
