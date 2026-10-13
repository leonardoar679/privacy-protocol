//! `cargo run -p uniffi-bindgen -- generate --library <privacy_ffi library> --language <swift|kotlin|python> --out-dir <dir>`
//! (privacy-core/scripts/ffi-bindings.mjs drives it). Same version as the uniffi the library was built with.
fn main() {
    uniffi::uniffi_bindgen_main()
}
