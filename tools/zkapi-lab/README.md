# zkAPI lab

Tools for plan V1.1 steps 01–03 (study, reproduce, assess zkAPI). Results: [`docs/zkapi/`](../../docs/zkapi/)
(`reproduction.md` is the executed log; `mainnet-verification.md` the pins).

```
npm install
node verify-mainnet.mjs mainnet      # 23 pin checks against chain + live manifest + a byte-exact rebuild
node verify-mainnet.mjs sepolia
node vendor-crates.mjs <vendorDir> <Cargo.lock> [...]   # offline cargo vendoring when cargo's HTTP stack cannot connect
node vendor-gomods.mjs  <dir> <go.sum>                  # file:// GOPROXY for the same reason (go verifies against go.sum)
```

`verify-mainnet.mjs` expects the `ethereum/zkapi` clone at `../../../zkapi` and a forge build of the
deployment's source commit at `../../../zkapi-deployed/demo/contracts/out` (override with `--zkapi`,
`--artifacts`). It is read-only: public JSON-RPC, no keys, no funds.

## Rust lab on this machine (offline cargo, standalone toolchain)
```
export PATH=/c/Users/Think/.rust-1.99/bin:/c/Users/Think/.mingw-gcc16/mingw64/bin:$PATH
export CARGO_HOME=/c/Users/Think/.rust-1.99/cargo-home          # keep cargo away from rustup's proxies
cd ../../../zkapi                                                 # has .cargo/config.toml -> ../zkapi-vendor
cargo build --release --locked --offline --workspace
cargo test  --release --locked --offline --workspace               # 34 socket-bound tests crash: see below
cargo test  --release --locked --offline --manifest-path protocol/rust/Cargo.toml --workspace --exclude zkapi-browser -- --test-threads=1
cargo run   --release --locked --offline --manifest-path protocol/rust/Cargo.toml -p zkapi-proof --example wasm_roundtrip -- "$(cygpath -w $PWD/scripts/prove-browser-fixture.mjs)" "$(cygpath -w $PWD/sdk)"
FOUNDRY_SOLC=C:/Users/Think/.svm/0.8.28/solc-0.8.28.exe FOUNDRY_OFFLINE=true forge build   # in protocol/contracts
```

## Go (zkapi-clientd, Unix-only source — cross-checked from Windows)
```
export PATH=/c/Users/Think/.go-1.27/go/bin:$PATH GOTOOLCHAIN=local GOFLAGS=-mod=mod GOSUMDB=off
export GOPATH=/c/Users/Think/.go-1.27/gopath GOCACHE=/c/Users/Think/.go-1.27/gocache GOPROXY=file:///E:/Code/Tornado/zkapi-gomods
cd ../../../zkapi/zkapi-clientd && go mod verify && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go vet ./... && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build ./...
```

## Diagnostics kept from the toolchain work
- `minidbg.py <exe> [args]` — a ctypes Win32 debugger: prints the first exception, registers, the loaded
  modules and the return-address candidates on the stack as `module+offset` (feed them to
  `llvm-symbolizer --relative-address`). Found the `llvm-dlltool` import-table bug and the LSP crash.
- `lsp_probe.py` — asks Winsock whether sockets are IFS handles and whether `SIO_BASE_HANDLE` works;
  on this machine both answers are "no", which is why tokio/mio programs (anvil, the zkAPI daemons)
  die under the installed `ASProxy64.dll` LSP.
- `nolsp.py <exe> [args]` — starts a process with the "block non-Microsoft binaries" mitigation policy
  (documented per-process API, no admin). It stops the LSP crash but Winsock then returns 10106 instead
  of falling back, so it is evidence, not a fix. The fix is removing the LSP (elevated
  `netsh winsock reset`, or the proxy app's own setting) — the user's call.
