/** Optional Windows Rust cleanup backend; never loaded by non-Windows hosts. */
import { isAbsolute } from 'node:path'
import { createLazyRequire } from '@deepseek-ai/dsh-lazy-require'
import type { ProcessIdentity } from './process-inspector.ts'
import type { WindowsProcessState } from './windows-inspector.ts'

type Koffi = typeof import('koffi')['default']
const requireKoffi = createLazyRequire<Koffi>('koffi', import.meta.url)
interface RustProcess {
  state(pid: number): WindowsProcessState | undefined
  terminate(identity: ProcessIdentity): void
}

/**
 * Explicit local opt-in; bad configuration fails closed, not through taskkill.
 * @returns the configured Rust backend, or undefined on other platforms or without opt-in.
 */
export function rustProcess(): RustProcess | undefined {
  const path = process.env.DANDY_WINDOWS_PROCESS_DLL
  if (process.platform !== 'win32' || !path) return undefined
  if (!isAbsolute(path)) throw new Error('DANDY_WINDOWS_PROCESS_DLL must be absolute')
  const library = requireKoffi().load(path)
  const abi = library.func('uint32 dandy_process_abi()') as () => number
  if (abi() !== 1) throw new Error('Unsupported Rust process ABI')
  const state = library.func('uint32 dandy_process_state(uint32, void *)') as (pid: number, out: Buffer) => number
  const terminate = library.func('uint32 dandy_terminate_tree(uint32, uint32, uint32)') as (pid: number, high: number, low: number) => number
  const api: RustProcess = {
    state(pid) {
      const output = Buffer.alloc(12)
      if (state(pid, output) !== 0) return undefined
      return { started: `${output.readUInt32LE(0)}:${output.readUInt32LE(4)}`, active: output.readUInt32LE(8) !== 0 }
    },
    terminate(identity) {
      const parts = identity.started.split(':').map(Number)
      const [high, low] = parts
      if (high === undefined || low === undefined || parts.length !== 2
        || parts.some(n => !Number.isInteger(n) || n < 0 || n > 0xffffffff)) {
        throw new Error('Invalid Windows process creation identity')
      }
      const error = terminate(identity.pid, high, low)
      if (error !== 0) throw new Error(`Rust process cleanup failed (Win32 ${error}); quiescence not proved`)
    },
  }
  return api
}
