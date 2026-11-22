import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { rustPressureThreshold } from '../packages/entry/lib/kernels.js'

// A tiny valid WASM module lets the boundary be tested without a Rust compiler.
function fixture(omitted, version = 1) {
  const section = (id, bytes) => [id, bytes.length, ...bytes]
  const names = ['memory', 'kernel_version', 'allocate', 'release', 'pressure_threshold', 'scan_frames']
    .filter(name => name !== omitted)
  const exports = names.flatMap(name => [name.length, ...Buffer.from(name), name === 'memory' ? 2 : 0, 0])
  return Buffer.from([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [1, 96, 0, 1, 127]),
    ...section(3, [1, 0]),
    ...section(5, [1, 0, 1]),
    ...section(7, [names.length, ...exports]),
    ...section(10, [1, 4, 0, 65, version, 11]),
  ])
}

test('rejects incomplete or incompatible WASM exports before caching the artifact', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dandy-kernel-abi-'))
  const previous = process.env.DANDY_RUST_KERNELS
  try {
    delete process.env.DANDY_RUST_KERNELS
    assert.equal(rustPressureThreshold(8192, 2048, .8, 1024, false), undefined)
    for (const omitted of ['memory', 'kernel_version', 'allocate', 'release', 'pressure_threshold', 'scan_frames', undefined]) {
      const path = join(directory, `${omitted ?? 'version'}.wasm`)
      const bytes = fixture(omitted, omitted === undefined ? 2 : 1)
      assert.equal(WebAssembly.validate(bytes), true)
      writeFileSync(path, bytes)
      process.env.DANDY_RUST_KERNELS = path
      assert.throws(() => rustPressureThreshold(8192, 2048, .8, 1024, false), /Unsupported Dandy Rust kernel ABI/)
    }
  } finally {
    if (previous === undefined) delete process.env.DANDY_RUST_KERNELS
    else process.env.DANDY_RUST_KERNELS = previous
    rmSync(directory, { recursive: true, force: true })
  }
})
