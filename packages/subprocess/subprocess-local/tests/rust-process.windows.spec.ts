import { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import LocalSubprocessRuntime from '../src/index.ts'
import { createWindowsProcessInspector } from '../src/windows-inspector.ts'
import type { Readable } from 'node:stream'

const dll = resolve('native/system/rust-process/target/release/dandy_process.dll')
async function ready(stream: Readable): Promise<number[]> {
  return new Promise((yes, no) => {
    let text = ''
    const timer = setTimeout(() => { no(new Error('real tree did not become ready')) }, 10_000)
    stream.on('error', no)
    stream.on('data', (chunk) => {
      text += String(chunk)
      const pids = [...text.matchAll(/READY:(\d+)\r?\n/g)].map(match => Number(match[1]))
      if (pids.length >= 3) { clearTimeout(timer); yes(pids) }
    })
  })
}

describe.skipIf(process.platform !== 'win32' || !existsSync(dll))('Rust Windows cleanup through the real runtime', () => {
  for (const mode of ['terminal-stop', 'terminal-dispose', 'command-abort'] as const) {
    it(`${mode} leaves no fixture descendants`, async () => {
      const previous = process.env.DANDY_WINDOWS_PROCESS_DLL
      process.env.DANDY_WINDOWS_PROCESS_DLL = dll
      const root = await mkdtemp(join(tmpdir(), 'dandy-rust-runtime-'))
      const file = join(root, 'tree.cjs')
      await writeFile(file, 'const {spawn}=require(\'node:child_process\'); console.log(\'READY:\'+process.pid); if(+process.argv[2]>0) spawn(process.execPath,[__filename,String(+process.argv[2]-1)],{stdio:[\'ignore\',1,2],windowsHide:true}); setInterval(()=>{},1000);')
      const ctx = new Context()
      const fiber = await ctx.plugin(LocalSubprocessRuntime)
      try {
        const inspector = createWindowsProcessInspector()
        if (mode === 'command-abort') {
          const controller = new AbortController()
          const handle = ctx.subprocess.spawn({ argv: [process.execPath, file, '2'], cwd: root,
            stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 10, signal: controller.signal })
          const pids = await ready(handle.stdout!)
          const identities = inspector.snapshot().tree(pids[0]!)
          expect(pids.every(pid => identities.some(i => i.pid === pid)), JSON.stringify({ pids, identities })).toBe(true)
          controller.abort(new Error('fixture cancellation'))
          await handle.done.catch(() => {})
          expect(await handle.waitForExit(AbortSignal.timeout(5000))).toBe(true)
          expect(identities.filter(i => inspector.isAlive(i))).toEqual([])
        } else {
          const handle = await ctx.subprocess.spawnTerminal({ argv: [process.execPath, file, '2'], cwd: root,
            rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 10 })
          const pids = await ready(handle.output)
          const identities = inspector.snapshot().tree(handle.pid)
          expect(handle.pid).toBe(pids[0])
          expect(pids.every(pid => identities.some(i => i.pid === pid)), JSON.stringify({ pids, identities })).toBe(true)
          if (mode === 'terminal-dispose') await fiber.dispose()
          else { await handle.terminate(); await handle.terminate() }
          await handle.done
          expect(identities.filter(i => inspector.isAlive(i))).toEqual([])
        }
      } finally {
        await fiber.dispose()
        if (previous === undefined) delete process.env.DANDY_WINDOWS_PROCESS_DLL
        else process.env.DANDY_WINDOWS_PROCESS_DLL = previous
        await rm(root, { recursive: true, force: true })
      }
    }, 20_000)
  }
})
