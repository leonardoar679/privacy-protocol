//! The wallet's secrets (doc §60 `wallet/`): the keys derived from the master seed, the encrypted keystore and journal,
//! BIP-39 (its English list generated from the web wallet's), the chain keys (EVM / Bitcoin / Solana).
pub mod bip39;
pub mod bip39_wordlist;
pub mod chainkeys;
pub mod keys;
pub mod keystore;
