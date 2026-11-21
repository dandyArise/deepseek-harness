/** Real Windows process-tree comparison. Only terminates private spawned fixtures. */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import { createWindowsProcessInspector } from '../../../packages/subprocess/subprocess-local/src/windows-inspector.ts'
import { rustProcess } from '../../../packages/subprocess/subprocess-local/src/rust-process.ts'

if (process.platform !== 'win32') throw new Error('Windows verification only')
const dll = resolve('native/system/rust-process/target/release/dandy_process.dll')
const root = await mkdtemp(join(tmpdir(), 'dandy-process-test-'))
const fixture = join(root, 'tree.cjs')
await writeFile(fixture, `const {spawn}=require('node:child_process'); console.log(process.pid); if(+process.argv[2]>0) spawn(process.execPath,[__filename,String(+process.argv[2]-1)],{stdio:['ignore',1,2],windowsHide:true}); setInterval(()=>{},1000);`)
const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' })
const launched: ReturnType<typeof spawn>[] = []
const samples: { variant: string; milliseconds: number; heapDelta: number; rssDelta: number }[] = []
try {
  for (let pair = 0; pair < 10; pair++) {
    for (const variant of pair % 2 ? ['rust', 'before'] : ['before', 'rust']) {
      if (variant === 'rust') process.env.DANDY_WINDOWS_PROCESS_DLL = dll
      else delete process.env.DANDY_WINDOWS_PROCESS_DLL
      const inspector = createWindowsProcessInspector()
      const child = spawn(process.execPath, [fixture, '2'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      launched.push(child)
      const pids = await new Promise<number[]>((yes, no) => {
        let output = ''
        const timer = setTimeout(() => no(new Error('fixture readiness timeout')), 5000)
        child.on('error', no)
        child.stdout!.on('data', data => {
          output += String(data)
          const ids = output.slice(0, output.lastIndexOf('\n')).trim().split('\n').map(Number)
          if (ids.length === 3 && ids.every(Number.isInteger)) { clearTimeout(timer); yes(ids) }
        })
      })
      const identities = inspector.snapshot().tree(child.pid!)
      assert(pids.every(pid => identities.some(i => i.pid === pid)), 'all fixture descendants must be tracked')
      const identity = identities.find(i => i.pid === child.pid)!
      if (variant === 'rust') {
        rustProcess()!.terminate({ ...identity, started: '0:1' })
        assert(identities.every(i => inspector.isAlive(i)), 'mismatched identity must not kill')
      }
      const memory = process.memoryUsage()
      const start = performance.now()
      inspector.signalProcess(identity, 'SIGKILL')
      const deadline = Date.now() + 5000
      while (identities.some(i => inspector.isAlive(i))) {
        assert(Date.now() < deadline, `${variant} orphan(s): ${JSON.stringify(identities.filter(i => inspector.isAlive(i)))}`)
        await new Promise(r => setTimeout(r, 1))
      }
      const milliseconds = performance.now() - start
      const after = process.memoryUsage()
      assert.doesNotThrow(() => process.kill(sentinel.pid!, 0), 'unrelated process must survive')
      if (variant === 'rust') inspector.signalProcess(identity, 'SIGKILL') // idempotent
      samples.push({ variant, milliseconds, heapDelta: after.heapUsed - memory.heapUsed, rssDelta: after.rss - memory.rss })
    }
  }
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!
  const summary = Object.fromEntries(['before', 'rust'].map(variant => {
    const rows = samples.filter(s => s.variant === variant)
    return [variant, { milliseconds: median(rows.map(s => s.milliseconds)), heapDeltaBytes: median(rows.map(s => s.heapDelta)), rssDeltaBytes: median(rows.map(s => s.rssDelta)) }]
  }))
  const report = { node: process.version, trees: samples.length, processesPerTree: 3, survivingDescendants: 0, summary, samples }
  await writeFile(resolve(process.argv[2] ?? 'process-comparison.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(summary, null, 2))
} finally {
  sentinel.kill()
  for (const child of launched) {
    if (child.exitCode === null && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  }
  await rm(root, { recursive: true, force: true })
}
