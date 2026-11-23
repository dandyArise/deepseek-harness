import { readFileSync } from 'node:fs'

interface Kernels {
  memory: WebAssembly.Memory
  kernel_version(): number
  allocate(length: number): number
  release(pointer: number, length: number): void
  pressure_threshold(window: number, reserved: number, ratio: number, headroom: number, fixed: number): number
  scan_frames(pointer: number, length: number, output: number, maxFrames: number): number
}

let cached: { path: string; kernels: Kernels } | undefined

function hasKernelExports(exports: WebAssembly.Exports): exports is WebAssembly.Exports & Kernels {
  return exports.memory instanceof WebAssembly.Memory
    && typeof exports.kernel_version === 'function'
    && typeof exports.allocate === 'function'
    && typeof exports.release === 'function'
    && typeof exports.pressure_threshold === 'function'
    && typeof exports.scan_frames === 'function'
}

/** Optional, explicitly selected local Rust artifact. No compiler runs on import. */
function load(): Kernels | undefined {
  const path = process.env.DANDY_RUST_KERNELS
  if (!path) return undefined
  if (cached?.path === path) return cached.kernels
  const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(path)))
  const kernels = instance.exports
  if (!hasKernelExports(kernels) || kernels.kernel_version() !== 1) {
    throw new Error('Unsupported Dandy Rust kernel ABI')
  }
  cached = { path, kernels }
  return kernels
}

/** Pure threshold calculation; undefined selects the existing TS implementation. */
export function rustPressureThreshold(window: number, reserved: number, ratio: number, headroom: number, fixed: boolean): number | undefined {
  return load()?.pressure_threshold(window, reserved, ratio, headroom, fixed ? 1 : 0)
}

/** Structural frame indexing only. Native Node Zstd still validates and decodes data. */
export function rustScanFrames(input: Uint8Array, maxFrames: number): {
  frames: { start: number; end: number }[]; tornStart?: number
} | undefined {
  // Bound temporary WASM copies; large artifacts retain the established reader.
  if (input.length > 64 * 1024 * 1024 || (Number.isFinite(maxFrames) && !Number.isInteger(maxFrames))) return undefined
  const kernels = load()
  if (!kernels) return undefined
  const pointer = kernels.allocate(input.length)
  const outputSize = (2 + 2 * (Math.floor(input.length / 8) + 1)) * 4
  let output: number | undefined
  try {
    output = kernels.allocate(outputSize)
    new Uint8Array(kernels.memory.buffer, pointer, input.length).set(input)
    const count = kernels.scan_frames(pointer, input.length, output,
      Number.isFinite(maxFrames) && maxFrames > 0 ? Math.min(Math.ceil(maxFrames), 0xffffffff) : 0xffffffff)
    const words = new DataView(kernels.memory.buffer, output, outputSize)
    if (count < 0) {
      const reason = count === -1 ? 'invalid frame magic' : count === -2 ? 'reserved frame-header bit' : 'reserved block type'
      throw new Error(`corrupt Zstandard session log: ${reason} at byte ${words.getUint32(4, true)}`)
    }
    const frames: { start: number; end: number }[] = []
    for (let i = 0; i < count; i++) frames.push({
      start: words.getUint32(8 + i * 8, true), end: words.getUint32(12 + i * 8, true),
    })
    const tornStart = words.getUint32(0, true)
    return { frames, ...tornStart === 0xffffffff ? {} : { tornStart } }
  } finally {
    if (output !== undefined) kernels.release(output, outputSize)
    kernels.release(pointer, input.length)
  }
}
