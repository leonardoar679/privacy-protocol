//! Native witness calculation: the circuit's own WASM (circom 2, `circuits/build/transaction_js/
//! transaction.wasm`) run by wasmi, a pure-Rust interpreter — no JIT, so it runs where JIT is not
//! allowed (iOS) — through the calculator interface every circom 2 circuit exports: `init`, input
//! signals addressed by the 64-bit FNV-1a hash of their names, and the witness read out of a shared
//! read/write buffer of 32-bit little-endian words. With the prover this is the whole native pipeline:
//! circuit inputs → witness → proof, the witness being exactly the one snarkjs computes
//! (tests/witness.rs compares every element for the four v1 fixtures).
//!
//! The circuit's assertions run inside: inputs that violate a constraint (a forged nullifier, value
//! not conserved, a foreign key) fail here with the circuit's own message, before any proving.
use ark_bn254::Fr;
use ark_ff::{BigInt, PrimeField, Zero};
use wasmi::{Caller, Engine, Linker, Module, Store, TypedFunc};

#[derive(Debug, PartialEq, Eq)]
pub enum WitnessError {
    /// compiling, instantiating or calling the module failed
    Wasm(String),
    /// the module is not a circom 2 witness calculator over BN254
    Interface(&'static str),
    /// the circuit raised an exception: 1 signal not found, 2 too many signals set, 3 signal already
    /// set, 4 assert failed (an input violates a constraint), 5 out of memory, 6 input array overrun
    Circuit { code: i32, reason: &'static str, messages: Vec<String> },
    UnknownSignal(String),
    WrongLength { signal: String, expected: usize, got: usize },
    MissingInputs { set: usize, expected: usize },
    BadValue(String),
    /// the witness's public inputs differ from the ones the inputs declare (at this public index): the
    /// witness program proved a different statement than the wallet built — never submit it
    StatementMismatch { index: usize, signal: &'static str },
    /// the inputs lack a public signal of the Transaction circuit
    MissingPublic(&'static str),
}

fn reason(code: i32) -> &'static str {
    match code {
        1 => "signal not found",
        2 => "too many signals set",
        3 => "signal already set",
        4 => "assert failed",
        5 => "not enough memory",
        6 => "input signal array access exceeds the size",
        _ => "unknown error",
    }
}

#[derive(Default)]
struct Host {
    exception: Option<i32>,
    messages: Vec<String>,
}

struct Exports {
    init: TypedFunc<i32, ()>,
    input_signal_size: TypedFunc<(i32, i32), i32>,
    set_input_signal: TypedFunc<(i32, i32, i32), ()>,
    read: TypedFunc<i32, i32>,
    write: TypedFunc<(i32, i32), ()>,
    witness_size: TypedFunc<(), i32>,
    input_size: TypedFunc<(), i32>,
    witness: TypedFunc<i32, ()>,
}

/// A loaded circuit, ready to compute witnesses (reuse it: compiling the module is the slow part).
pub struct WitnessCalculator {
    store: Store<Host>,
    f: Exports,
    /// number of signals in a witness
    pub witness_size: usize,
    /// number of input field elements the circuit expects
    pub input_size: usize,
}

/// 64-bit FNV-1a of a signal name, split into the (high, low) words the interface takes.
pub fn fnv(name: &str) -> (i32, i32) {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in name.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    ((h >> 32) as u32 as i32, h as u32 as i32)
}

/// The message the circuit left for printErrorMessage / writeBufferMessage, read char by char.
fn take_message(caller: &mut Caller<'_, Host>) -> Result<String, wasmi::Error> {
    let f = caller
        .get_export("getMessageChar")
        .and_then(|e| e.into_func())
        .ok_or_else(|| wasmi::Error::new("the circuit exports no getMessageChar"))?
        .typed::<(), i32>(&*caller)?;
    let mut out = String::new();
    for _ in 0..4096 {
        let c = f.call(&mut *caller, ())?;
        if c == 0 {
            break;
        }
        out.push(char::from(c as u8));
    }
    Ok(out)
}

fn wasm_err(e: wasmi::Error) -> WitnessError {
    WitnessError::Wasm(e.to_string())
}

impl WitnessCalculator {
    /// Compile and instantiate a circom 2 witness calculator; refuses another version, field or interface.
    pub fn new(wasm: &[u8]) -> Result<Self, WitnessError> {
        let engine = Engine::default();
        let module = Module::new(&engine, wasm).map_err(wasm_err)?;
        let mut store = Store::new(&engine, Host::default());
        let mut linker = <Linker<Host>>::new(&engine);
        linker
            .func_wrap("runtime", "exceptionHandler", |mut caller: Caller<'_, Host>, code: i32| -> Result<(), wasmi::Error> {
                caller.data_mut().exception = Some(code);
                Err(wasmi::Error::new(format!("circuit exception {code}: {}", reason(code))))
            })
            .map_err(|e| WitnessError::Wasm(e.to_string()))?;
        linker
            .func_wrap("runtime", "printErrorMessage", |mut caller: Caller<'_, Host>| -> Result<(), wasmi::Error> {
                let m = take_message(&mut caller)?;
                caller.data_mut().messages.push(m);
                Ok(())
            })
            .map_err(|e| WitnessError::Wasm(e.to_string()))?;
        linker
            .func_wrap("runtime", "writeBufferMessage", |mut caller: Caller<'_, Host>| -> Result<(), wasmi::Error> {
                take_message(&mut caller).map(|_| ()) // circuit log() output: consumed, not printed
            })
            .map_err(|e| WitnessError::Wasm(e.to_string()))?;
        linker.func_wrap("runtime", "showSharedRWMemory", |_: Caller<'_, Host>| {}).map_err(|e| WitnessError::Wasm(e.to_string()))?;
        let instance = linker.instantiate_and_start(&mut store, &module).map_err(wasm_err)?;

        macro_rules! export {
            ($name:literal) => {
                instance.get_typed_func(&store, $name).map_err(|_| WitnessError::Interface(concat!("missing or mistyped export ", $name)))?
            };
        }
        let get_version: TypedFunc<(), i32> = export!("getVersion");
        let get_n32: TypedFunc<(), i32> = export!("getFieldNumLen32");
        let get_raw_prime: TypedFunc<(), ()> = export!("getRawPrime");
        let f = Exports {
            init: export!("init"),
            input_signal_size: export!("getInputSignalSize"),
            set_input_signal: export!("setInputSignal"),
            read: export!("readSharedRWMemory"),
            write: export!("writeSharedRWMemory"),
            witness_size: export!("getWitnessSize"),
            input_size: export!("getInputSize"),
            witness: export!("getWitness"),
        };
        if get_version.call(&mut store, ()).map_err(wasm_err)? != 2 {
            return Err(WitnessError::Interface("not a circom 2 witness calculator"));
        }
        if get_n32.call(&mut store, ()).map_err(wasm_err)? != 8 {
            return Err(WitnessError::Interface("not a 256-bit field"));
        }
        let mut calc = Self { store, f, witness_size: 0, input_size: 0 };
        get_raw_prime.call(&mut calc.store, ()).map_err(wasm_err)?;
        if calc.read_words()? != Fr::MODULUS {
            return Err(WitnessError::Interface("the circuit's prime is not the BN254 scalar field"));
        }
        calc.witness_size = calc.f.witness_size.call(&mut calc.store, ()).map_err(wasm_err)? as usize;
        calc.input_size = calc.f.input_size.call(&mut calc.store, ()).map_err(wasm_err)? as usize;
        Ok(calc)
    }

    fn read_words(&mut self) -> Result<BigInt<4>, WitnessError> {
        let mut limbs = [0u64; 4];
        for j in 0..8 {
            let w = self.f.read.call(&mut self.store, j as i32).map_err(wasm_err)? as u32 as u64;
            limbs[j / 2] |= w << (32 * (j % 2));
        }
        Ok(BigInt::new(limbs))
    }

    fn write_fr(&mut self, x: &Fr) -> Result<(), WitnessError> {
        let limbs = x.into_bigint().0;
        for j in 0..8 {
            let w = (limbs[j / 2] >> (32 * (j % 2))) as u32;
            self.f.write.call(&mut self.store, (j as i32, w as i32)).map_err(wasm_err)?;
        }
        Ok(())
    }

    /// The error a failed call means: the circuit's exception when it raised one.
    fn call_err(&mut self, e: wasmi::Error) -> WitnessError {
        let host = self.store.data_mut();
        match host.exception.take() {
            Some(code) => WitnessError::Circuit { code, reason: reason(code), messages: std::mem::take(&mut host.messages) },
            None => WitnessError::Wasm(e.to_string()),
        }
    }

    /// The full witness (constant 1, public inputs, every internal signal) for these inputs:
    /// `(signal name, its values flattened in row-major order)`, every input signal exactly once.
    pub fn calculate(&mut self, inputs: &[(String, Vec<Fr>)]) -> Result<Vec<Fr>, WitnessError> {
        *self.store.data_mut() = Host::default();
        self.f.init.call(&mut self.store, 1).map_err(|e| self.call_err(e))?; // 1 = the circuit's sanity checks on
        let mut set = 0usize;
        for (name, values) in inputs {
            let (msb, lsb) = fnv(name);
            let size = self.f.input_signal_size.call(&mut self.store, (msb, lsb)).map_err(|e| self.call_err(e))?;
            if size <= 0 {
                // circom 2 answers 0 (older builds -1) for a name it does not have: no input signal is empty
                return Err(WitnessError::UnknownSignal(name.clone()));
            }
            if size as usize != values.len() {
                return Err(WitnessError::WrongLength { signal: name.clone(), expected: size as usize, got: values.len() });
            }
            for (i, v) in values.iter().enumerate() {
                self.write_fr(v)?;
                self.f.set_input_signal.call(&mut self.store, (msb, lsb, i as i32)).map_err(|e| self.call_err(e))?;
                set += 1;
            }
        }
        if set < self.input_size {
            return Err(WitnessError::MissingInputs { set, expected: self.input_size });
        }
        let mut w = Vec::with_capacity(self.witness_size);
        for i in 0..self.witness_size {
            self.f.witness.call(&mut self.store, i as i32).map_err(|e| self.call_err(e))?;
            let x = self.read_words()?;
            w.push(Fr::from_bigint(x).ok_or(WitnessError::Interface("a witness element is not below the prime"))?);
        }
        Ok(w)
    }
}

/// A field element from a JSON circuit input: a decimal or 0x-hex string (optionally negative,
/// reduced mod p like snarkjs does) or a non-negative integer.
pub fn fr_from_json(v: &serde_json::Value) -> Result<Fr, WitnessError> {
    let bad = || WitnessError::BadValue(v.to_string());
    match v {
        serde_json::Value::Number(n) => n.as_u64().map(Fr::from).ok_or_else(bad),
        serde_json::Value::String(s) => {
            let (neg, body) = match s.strip_prefix('-') {
                Some(rest) => (true, rest),
                None => (false, s.as_str()),
            };
            let (radix, digits) = match body.strip_prefix("0x").or_else(|| body.strip_prefix("0X")) {
                Some(h) => (16u32, h),
                None => (10u32, body),
            };
            if digits.is_empty() {
                return Err(bad());
            }
            let base = Fr::from(radix as u64);
            let mut acc = Fr::zero();
            for c in digits.chars() {
                acc = acc * base + Fr::from(c.to_digit(radix).ok_or_else(bad)? as u64);
            }
            Ok(if neg { -acc } else { acc })
        }
        _ => Err(bad()),
    }
}

fn flatten(v: &serde_json::Value, out: &mut Vec<Fr>) -> Result<(), WitnessError> {
    match v {
        serde_json::Value::Array(xs) => xs.iter().try_for_each(|x| flatten(x, out)),
        _ => {
            out.push(fr_from_json(v)?);
            Ok(())
        }
    }
}

/// The circuit inputs of a JSON object (what packages/protocol/src/txInputs.ts builds): every key
/// a signal, nested arrays flattened row-major.
pub fn inputs_from_json(v: &serde_json::Value) -> Result<Vec<(String, Vec<Fr>)>, WitnessError> {
    let obj = v.as_object().ok_or_else(|| WitnessError::BadValue("circuit inputs must be a JSON object".into()))?;
    obj.iter()
        .map(|(k, x)| {
            let mut vals = Vec::new();
            flatten(x, &mut vals)?;
            Ok((k.clone(), vals))
        })
        .collect()
}

/// The Transaction circuit's public signals in `PrivacyCore.encodePublicInputs` order, with their sizes
/// (packages/protocol/src/prover.ts PUBLIC_SIGNALS): 14 field elements.
pub const TRANSACTION_PUBLIC_SIGNALS: [(&str, usize); 9] = [
    ("root", 1),
    ("nullifier", 2),
    ("outputBody", 3),
    ("mode", 1),
    ("withdrawalVault", 1),
    ("withdrawalAmount", 1),
    ("withdrawalRecipient", 1),
    ("outDataHash", 3),
    ("txDomain", 1),
];

/// The public inputs the circuit inputs DECLARE, in order — what the wallet built and means to submit.
pub fn declared_public_inputs(inputs: &[(String, Vec<Fr>)]) -> Result<Vec<Fr>, WitnessError> {
    let mut out = Vec::with_capacity(14);
    for (name, size) in TRANSACTION_PUBLIC_SIGNALS {
        let values = &inputs.iter().find(|(n, _)| n == name).ok_or(WitnessError::MissingPublic(name))?.1;
        if values.len() != size {
            return Err(WitnessError::WrongLength { signal: name.to_string(), expected: size, got: values.len() });
        }
        out.extend_from_slice(values);
    }
    Ok(out)
}

/// Refuse a witness whose public inputs (elements 1..=14) are not exactly the declared ones. The witness
/// program holds the spending key while it runs; a tampered one could otherwise produce a valid proof of
/// a different statement (another withdrawal recipient, another output) that the chain would accept.
/// The web wallet makes the same check on snarkjs' output (packages/protocol/src/prover.ts proveInputs).
pub fn check_statement(inputs: &[(String, Vec<Fr>)], witness: &[Fr]) -> Result<(), WitnessError> {
    let declared = declared_public_inputs(inputs)?;
    if witness.len() <= declared.len() {
        return Err(WitnessError::Interface("the witness is shorter than the public inputs"));
    }
    let mut k = 0;
    for (name, size) in TRANSACTION_PUBLIC_SIGNALS {
        for _ in 0..size {
            if witness[1 + k] != declared[k] {
                return Err(WitnessError::StatementMismatch { index: k, signal: name });
            }
            k += 1;
        }
    }
    Ok(())
}
