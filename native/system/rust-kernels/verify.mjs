// Run from repository root: node --import tsx/esm native/system/rust-kernels/verify.mjs
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { scanZstdFrames } from '../../../packages/session/session-persistence-jsonl/src/zstd.ts'
import { rustPressureThreshold } from '../packages/entry/lib/kernels.js'

const artifact = resolve('native/system/rust-kernels/target/wasm32-unknown-unknown/release/dandy_kernels.wasm')
function run(bytes, limit, native) {
  if (native) process.env.DANDY_RUST_KERNELS = artifact
  else delete process.env.DANDY_RUST_KERNELS
  try { return { result: scanZstdFrames(bytes, limit) } }
  catch (error) { return { error: error.message } }
}
const frames = Array.from({ length: 1000 }, (_, seq) => zstdCompressSync(Buffer.from(JSON.stringify({
  seq, type: 'user/message', data: { content: [{ type: 'text', text: 'session history '.repeat(200) }] },
}) + '\n')))
const corpus = Buffer.concat(frames)
let checked = 0
for (const input of [Buffer.alloc(0), ...frames.slice(0, 4), corpus]) {
  for (const limit of [1, 2, Infinity, 0, -1, 1.5]) {
    assert.deepEqual(run(input, limit, true), run(input, limit, false)); checked++
  }
}
for (let end = 0; end < frames[0].length; end++) {
  const input = frames[0].subarray(0, end)
  assert.deepEqual(run(input, Infinity, true), run(input, Infinity, false)); checked++
}
for (let i = 0; i < frames[0].length; i++) {
  const input = Buffer.from(frames[0]); input[i] ^= 0xff
  assert.deepEqual(run(input, Infinity, true), run(input, Infinity, false)); checked++
}
process.env.DANDY_RUST_KERNELS = artifact
for (const window of [4096, 8192, 32768, 131072, 1048576]) {
  for (const reserved of [0, 512, 2048]) for (const fixed of [false, true]) {
    const headroom = 1024
    assert.equal(rustPressureThreshold(window, reserved, 0.8, headroom, fixed),
      Math.floor(Math.min(window * 0.8, window - reserved - (fixed ? headroom : Math.min(headroom, Math.floor((window - reserved) / 4))))))
    checked++
  }
}
const samples = { ts: [], rust: [] }
for (let trial = 0; trial < 24; trial++) {
  for (const native of trial % 2 ? [true, false] : [false, true]) {
    if (native) process.env.DANDY_RUST_KERNELS = artifact
    else delete process.env.DANDY_RUST_KERNELS
    const start = performance.now()
    for (let i = 0; i < 100; i++) scanZstdFrames(corpus)
    if (trial >= 4) samples[native ? 'rust' : 'ts'].push((performance.now() - start) / 100)
  }
}
const stats = values => {
  values.sort((a,b) => a-b)
  return { medianMs: values[Math.floor(values.length / 2)], p95Ms: values[Math.ceil(values.length * .95) - 1] }
}
console.log(JSON.stringify({ checked, frames: frames.length, compressedBytes: corpus.length,
  trials: 20, ts: stats(samples.ts), rust: stats(samples.rust),
  note: 'Structural indexing only; excludes disk I/O, decompression, restore and UI. WASM copies input; no RSS gain claimed.' }, null, 2))
const budgetSamples = { ts: [], rust: [] }
let checksum = 0
process.env.DANDY_RUST_KERNELS = artifact
for (let trial = 0; trial < 24; trial++) {
  for (const native of trial % 2 ? [true, false] : [false, true]) {
    const start = performance.now()
    for (let i = 0; i < 100000; i++) {
      const window = 8192 + (i % 16) * 1024
      checksum += native ? rustPressureThreshold(window, 2048, .8, 65536, false)
        : Math.floor(Math.min(window * .8, window - 2048 - Math.min(65536, Math.floor((window - 2048) / 4))))
    }
    if (trial >= 4) budgetSamples[native ? 'rust' : 'ts'].push((performance.now() - start) / 100000)
  }
}
console.log(JSON.stringify({ operation: 'pressure threshold including bridge', checksum,
  ts: stats(budgetSamples.ts), rust: stats(budgetSamples.rust) }, null, 2))
