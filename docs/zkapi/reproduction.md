# zkAPI — local reproduction log (plan V1.1 §61, step 02)

What was actually executed on this machine against `ethereum/zkapi` at `045b444` (LF checkout at
`E:\Code\Tornado\zkapi`), with the exact result. Anything not run says so and why.

| Layer | Command (CI equivalent) | Result |
|-------|--------------------------|--------|
| Browser SDK (JS) | `npm ci && npm test` | **309/309** (needs an LF checkout — see `mainnet-verification.md`) |
| SDK asset integrity | `npm run verify:assets` | OK |
| Contracts (Foundry) | `protocol/contracts: forge test` (local solc 0.8.28, offline) | **29/29** |
| Deployment pins | `tools/zkapi-lab/verify-mainnet.mjs` | mainnet **23/23**, Sepolia **23/23** (byte-exact vault + verifier rebuilds) |
| Protocol Rust: `zkapi-types`, `zkapi-core`, `zkapi-proof` | `cargo test --release --manifest-path protocol/rust/Cargo.toml -p … -- --test-threads=1` | **37/37** (10 + 12 + 15; real Groth16 request/withdrawal round trips, context binding, note-rebinding rejections) |
| Shipped browser WASM vs native verifier | `cargo run --release -p zkapi-proof --example wasm_roundtrip -- scripts/prove-browser-fixture.mjs sdk` | **"Shipped WASM request and escape withdrawal proofs verified natively."** (65 s) — the published `sdk/wasm/zkapi_browser_bg.wasm` (sha256 `1fc6a862…b42d78`, producers section: rustc 1.97.1 2026-07-14, wasm-bindgen 0.2.117, walrus 0.26.1) produces proofs the arkworks verifier accepts under the checked-in keys. A byte-identical `.wasm` would need that exact rustc 1.97.1 (our 1.99.0 rebuild is in the row below) |
| Protocol Rust: `zkapi-client` | `cargo test -p zkapi-client` | **8/8** (after switching from `llvm-dlltool` to GNU binutils — see notes) → protocol workspace **45/45** |
| App Rust workspace: `zkapi-cli`, `zkapi-serverd`, `zkapi-indexerd` | `cargo build --release --workspace` | **builds** (`zkapi.exe`, `zkapi-challenged.exe`, `zkapi-indexerd.exe`; `ring` and bundled SQLite compiled with GCC 16) |
| App Rust workspace tests | `cargo test --release --workspace` (each test run in its own process, `--exact`) | **67 pass / 0 fail / 34 crash** — cli 3/3, testnet_auth 4/4, indexerd 8 (+4 crash: `http::*`, `poller::*`), serverd 52 (+30 crash: `processor::*`, `challenge_service::*`, `native_billing::*`, `oa_org::*`). Every crash is the machine's Winsock LSP (below): the test opens a loopback mock server and dies at `rip = 0` with `ASProxy64.dll` loaded; none is an assertion failure |
| `zkapi-browser` for wasm32 + `wasm-bindgen` 0.2.117 (prebuilt CLI, sha256 `54d52650…a936f` = published `.sha256sum`) | `zkapi/scripts/build-browser-client.sh` steps: `cargo build -p zkapi-browser --target wasm32-unknown-unknown --release`, `wasm-bindgen --target web --omit-default-module-path` | **rebuilt**: `zkapi_browser.js`, `zkapi_browser.d.ts`, `zkapi_browser_bg.wasm.d.ts` are **byte-identical** to the shipped SDK files; `_bg.wasm` differs (2,300,652 B, sha256 `a9116a25…` vs shipped 2,424,710 B — rustc 1.99.0 vs 1.97.1). With our `.wasm` swapped in: SDK suite **308/309** (the one failure is the shipped-asset hash pin, as it should be) and `wasm_roundtrip` verifies its proofs natively |
| Clippy / fmt | `cargo clippy --workspace -- -D warnings` (both workspaces), `cargo fmt --check` / `--all --check` | **clean** (clippy + rustfmt 1.99.0 installed from the verified tarballs; `CARGO_HOME` moved off `~/.cargo` so cargo does not pick rustup's broken proxies) |
| v2 acceptance pre-checks (provider-mock accounting, loopback transport) | `node --test scripts/v2-acceptance.test.mjs` | **3/3** |
| v2 acceptance scenario (anvil + server + indexer + challenger + wallet) | `npm run test:e2e:v2` | **NOT RUN — blocked by the machine, not by zkAPI**: `anvil` and all three daemons are tokio programs and crash under this machine's Winsock LSP before binding a port (details below). Everything else the wrapper needs is in place: Node 24, the four binaries, `forge build` of `protocol/contracts` (with `FOUNDRY_SOLC` pointing at the local solc 0.8.28, offline) |
| `zkapi-clientd` (Go 1.27.1, sha256-verified zip; modules via `vendor-gomods.mjs` → `file://` GOPROXY, **`go mod verify`: all modules verified** against `go.sum`) | `go vet ./...`, `go build ./...`, `go test -race ./...` | the daemon is Unix-only (`syscall.O_NOFOLLOW`, `Flock`, `Stat_t` in `internal/config`) — it does not compile for Windows. Cross-checked instead: **`GOOS=linux go vet ./...` clean**, **`go build` OK for linux/amd64 (14.7 MB) and darwin/arm64**, and all 5 test binaries (421 `Test*` functions) **compile** for linux/amd64 (`go test -c`). **Tests not executed** — they need Linux/macOS |

## Toolchain notes (this machine, 2026-10-06)
- **Rust** could not be installed with rustup (the installer segfaults, see the LSP note below); Rust
  1.99.0 was installed from the official standalone tarballs (`rustc`, `rust-std`, `cargo`,
  `rust-mingw`, `rust-std-wasm32`, each sha256-checked against `channel-rust-stable.toml`) into
  `C:\Users\Think\.rust-1.99` (host `x86_64-pc-windows-gnu`).
- **cargo cannot reach crates.io** here (libcurl "could not connect", same cause as below), so every
  crate of both lockfiles (328 registry packages) was fetched from `static.crates.io` with curl,
  sha256-verified against the lockfile checksums, and used as a cargo *directory source*
  (`tools/zkapi-lab/vendor-crates.mjs` → `E:\Code\Tornado\zkapi-vendor`, `zkapi/.cargo/config.toml`,
  `[net] offline = true`). `cargo build --locked` therefore resolves exactly the upstream lockfile.
- **C toolchain**: the machine has no Visual Studio, Windows SDK, MSYS2 or MinGW — only LLVM 22
  without a libc. `ring` (rustls) and bundled SQLite need a C compiler, and rustc's raw-dylib support on
  the GNU target needs GNU `dlltool`+`as` (pointing rustc at `llvm-dlltool` links but yields binaries
  whose kernel32 import table is partly unbound → `TlsGetValue` → access violation inside
  `std::rt::init`; found with a 120-line ctypes debugger, `tools/zkapi-lab/minidbg.py`). A per-user
  winlibs mingw-w64 GCC 16.2.0 / binutils (`winlibs-x86_64-posix-seh-gcc-16.2.0-mingw-w64ucrt-14.0.0-r2.zip`,
  sha256 `d5dbafc4…5276a` matching the published `.sha256`) was unpacked to `C:\Users\Think\.mingw-gcc16`
  and put first on `PATH`; with GNU `dlltool`/`as` in reach rustc's default raw-dylib path works, the
  `zkapi-client` test binary starts, and `ring` + `libsqlite3-sys` compile.
- **A Winsock Layered Service Provider is installed on this machine**: `netsh winsock show catalog`
  lists "ASProxy over [MSAFD Tcpip …]" → `C:\WINDOWS\system32\ASProxy64.dll` (a third-party proxy /
  VPN component). Windows loads it into every process that opens a socket. Under a debugger, `anvil`
  dies at `rip = 0` with that DLL loaded; `rustup` and forge's solc download segfault the same way; cargo's
  libcurl gets "could not connect". Node, npm and curl work. Blocking the DLL with the documented
  process-mitigation policy (`tools/zkapi-lab/nolsp.py`, `PROCESS_CREATION_MITIGATION_POLICY_BLOCK_NON_MICROSOFT_BINARIES_ALWAYS_ON`)
  removes the crash but Winsock then refuses sockets (`WSAEPROVIDERFAILEDINIT`, 10106) instead of
  falling back to the base provider, so there is no per-user workaround. Removing the LSP needs an
  elevated `netsh winsock reset` (or the proxy application's own "disable LSP / app guard" setting);
  that is the user's decision and was not done.
  Mechanism (probed with `tools/zkapi-lab/lsp_probe.py`): sockets created under this LSP are **non-IFS
  handles** (`SO_PROTOCOL_INFOW.dwServiceFlags1 = 0x66`, no `XP1_IFS_HANDLES`) and `SIO_BASE_HANDLE`
  fails with `WSAEFAULT` (10014); `SIO_BSD_HANDLE_SELECT/POLL` fail with 10045. tokio's I/O driver
  (mio) needs the base AFD handle for `IOCTL_AFD_POLL`, so **every tokio/mio program** — `anvil`,
  `zkapi-serverd`, `zkapi-indexerd`, `zkapi-challenged` — dies the same way (`rip = 0`, confirmed on a
  10-line tokio loopback probe), while plain blocking `std::net` sockets work (loopback echo OK).
  libuv (Node) tolerates non-IFS LSPs, which is why the JS layers all run.
  The LSP also filters **outbound** connections per executable: `go.exe` (`go mod download`) and a Rust
  `std::net` probe get `WSAEACCES` (10013) on `connect` to any public host, while `python.exe`, `node.exe`
  and `curl.exe` connect fine from the same shell with the same socket flags (`lsp_probe2`: all of
  `WSA_FLAG_OVERLAPPED`, `|NO_HANDLE_INHERIT`, none succeed from Python). That is why cargo's registry
  fetch and Go's module proxy had to be replaced by Node/curl downloads (`vendor-crates.mjs`,
  `vendor-gomods.mjs`) that the toolchains then verify against their own lockfiles.

## What this does and does not establish
- The cryptographic core of zkAPI v2 is reproducible here end to end: the circuits' native prover and
  verifier pass their own tests, the published browser WASM produces proofs the native verifier accepts,
  and the on-chain verifier bytes match the source commit (mainnet-verification.md).
- The server-side logic that matters for the §73 list (proof/context binding, nullifier reservation and
  finalization, frozen quotes, usage reconciliation, lease-key hygiene, challenge calldata) is exercised by
  the upstream unit tests that ran here (`security.md` maps each §73 item to the executed test names).
- Not established here: the live lifecycle (deposit → lease → signed settlement → stale escape →
  daemon challenge → mutual close) against a real server, indexer and chain, i.e. `test:e2e:v2`, and the
  34 socket-bound unit tests. They need a machine without the ASProxy Winsock LSP (or an elevated
  `netsh winsock reset`); nothing else is missing — the binaries, keys, contracts and wrapper checks are ready.
- The repeat recipe on a clean machine is the upstream one (`zkapi/docs/v2-acceptance.md`): `npm run test:e2e:v2`.
  On Windows the wrapper additionally needs `FOUNDRY_SOLC`/`FOUNDRY_OFFLINE` (or a working svm) for
  `forge build`, and `zkapi/scripts/v2-acceptance.mjs` reads the four binaries without an `.exe` suffix when it
  hashes them for the evidence file (line ~660), which would need a two-line shim.
