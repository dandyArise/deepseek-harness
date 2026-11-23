# Dandy Rust kernels — measured, opt-in

English | [中文](README.zh.md)

This private Rust crate has no filesystem or execution capabilities. It exports a
versioned WebAssembly ABI consumed by `@deepseek-ai/node-addon-system/kernels`.
The classic engine can use it for structural Zstandard frame indexing and the
pure pressure-threshold calculation. Session bytes, schema validation, locks,
decompression and transactional writes remain with their current owners.

## Build and compare

Run from the engine repository root (Rust stable with `wasm32-unknown-unknown`):

```powershell
cargo build --release --target wasm32-unknown-unknown --manifest-path native/system/rust-kernels/Cargo.toml
pnpm --dir native/system/packages/entry run build:js
node --test native/system/test/kernels.test.js
node --import tsx/esm native/system/rust-kernels/verify.mjs
```

Set `DANDY_RUST_KERNELS` to the absolute path of the resulting
`target/wasm32-unknown-unknown/release/dandy_kernels.wasm` **before launching the
engine** to opt in. Unset it to use the current implementation. An explicitly
selected invalid artifact fails rather than silently pretending to use Rust.
The default desktop launcher does not enable this experiment.

Only trusted administrator/user-controlled configuration may select the artifact.
The module has no imports. ABI version 1, exported memory and all required
functions are checked before caching an instance. Incomplete exports fail with
an explicit ABI error. Temporary input copies are
limited to 64 MiB; larger inputs use the established TS scanner. Truncated tails,
invalid headers, reserved bits and frame limits preserve the existing semantics.
No session migration or rewriting is performed.

## Measurements — 20 November 2026

Twenty alternating pairs after four warmups, same synthetic 1,000-frame corpus,
97,243 compressed bytes, Node on Windows. Each indexing sample averages 100 calls.
254 differential cases cover valid frames, truncated tails, corruption, limits
and budgets. The production zstd/compaction tests also pass with Rust selected.

| Operation, including bridge | TS median | Rust/WASM median | Decision |
|---|---:|---:|---|
| Frame index | 0.01347 ms | 0.01718 ms | Keep TS by default |
| Pressure threshold | 0.00000333 ms | 0.00037221 ms | Keep TS by default |

These are microbenchmarks, not startup, chat-readiness or total-memory results.
WASM copies input and reconstructs JS result objects. No RSS reduction is claimed.
Compression/decompression already uses native Zstandard through Node; duplicating
it here is not justified by these measurements. Full JSON parsing/restoration and
session querying have not been ported by this increment.
