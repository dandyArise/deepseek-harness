# Windows process cleanup in Rust

English | [中文](README.zh.md)

Optional Windows-only DLL used by subprocess-local for process identity/liveness
and forceful terminal tree cleanup. Enable with an absolute
`DANDY_WINDOWS_PROCESS_DLL` path. Without it, the existing implementation stays in
use. Invalid configured libraries or cleanup failures are explicit errors.

This does not replace ordinary command launching: its existing Windows Job
Object containment remains authoritative. Graceful terminal shutdown remains in
the existing runtime. Rust replaces the forced tree termination path, avoiding
the taskkill subprocess and checking creation identity on held process handles.
The DLL holds observed handles until cleanup finishes, checks subsequent process
tables for late children, and waits for asynchronous termination without
reissuing it. Timeout is five seconds; an error never means proven cleanup.

ConPTY may initially expose PID zero. The terminal handle now reads the current
PID and captures its initial identity at the first output, once only.

## Build and reproduce (repository root, Windows PowerShell)

```powershell
cargo +stable-x86_64-pc-windows-msvc build --release --locked --manifest-path native/system/rust-process/Cargo.toml
pnpm exec vitest run packages/subprocess/subprocess-local/tests/rust-process.windows.spec.ts packages/subprocess/subprocess-local/tests/windows-inspector.spec.ts
pnpm exec tsx native/system/rust-process/verify.ts process-comparison.json
$env:DANDY_WINDOWS_PROCESS_DLL = (Resolve-Path native/system/rust-process/target/release/dandy_process.dll).Path
```

The real tests require the DLL; otherwise they are skipped. They launch private
three-process fixtures, stop/dispose terminals and abort an ordinary command,
then check all observed process identities. The benchmark alternates 10 legacy
and 10 Rust trials, protects an unrelated sentinel, tests mismatched identities
and repeated termination. It records every sample and requires zero survivors.

## Measurements — 2026-11-20, local Windows, Node 24.22.3

Two final series of 20 trees passed, zero surviving observed descendants:

| Median | Legacy | Rust |
| --- | ---: | ---: |
| Forced cleanup, series 1 | 168.35 ms | 26.53 ms |
| Forced cleanup, series 2 | 163.79 ms | 17.69 ms |
| Node heap delta, series 2 | 88,320 bytes | 3,032 bytes |
| Node RSS delta, series 2 | 0 bytes | 0 bytes |

These are local microbenchmarks, not end-to-end terminal stop latency (which
includes graceful shutdown). Heap deltas are noisy allocations without forced
GC, exclude the external taskkill process and are not retained memory. No global
Harness memory reduction is established. Series 1 ran while build checks were
finishing. Both variants use identical fixtures, alternate order and verify exit.

16 targeted tests pass; broader subprocess-local run: 189 pass, 23 skip,
2 fail because Windows denies symlink creation (EPERM in existing spawn-runner
tests). Host/client build checks and artifacts pass; Rust Clippy passes.

Limits: observed descendant trees cannot guarantee containment of children that
escaped/reparented before observation. Ordinary commands retain their stronger
Job ownership. GUI clicks, abrupt host crash and every permission/security
configuration have not been tested here. No user processes or models were stopped.
