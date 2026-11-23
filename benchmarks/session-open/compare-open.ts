/** Alternating fresh-process comparison; never opens user sessions. Run with tsx. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { writeSyntheticReleasedV0Session } from './synthetic-released-v0-session.ts'
import type { SessionOpenWorkerReport } from './session-open.worker.ts'

const [before, after, output] = process.argv.slice(2)
if (!before || !after || !output) throw new Error('usage: tsx compare-open.ts <before-lib.js> <after-lib.js> <report.json>')
const root = await mkdtemp(join(tmpdir(), 'dsh-open-comparison-'))
const worker = resolve('benchmarks/.dsh-build/session-open/session-open.worker.js')
function run(library: string, scenario = 'phase-steady', profile = false): SessionOpenWorkerReport {
  const result = spawnSync(process.execPath, [...(profile ? ['--cpu-prof', '--cpu-prof-interval=100', `--cpu-prof-dir=${resolve(output!, '..')}`] : []), '--expose-gc', worker, root, scenario], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, DSH_SESSION_OPEN_PERSISTENCE: pathToFileURL(resolve(library)).href,
      DSH_PROFILE_SESSION_OPEN: profile ? '1' : '0' },
  })
  if (result.status !== 0) throw new Error(result.stderr || String(result.error))
  if (profile) process.stderr.write(result.stderr)
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as SessionOpenWorkerReport
}
try {
  const fixture = await writeSyntheticReleasedV0Session(root, { turns: 200, textDeltas: 500 })
  run(before, 'agent-resume') // Publish current generation outside measurement.
  run(before, 'phase-steady', true)
  const samples: { variant: string; report: SessionOpenWorkerReport }[] = []
  for (let pair = 0; pair < 10; pair++) {
    for (const variant of pair % 2 === 0 ? ['before', 'after'] : ['after', 'before']) {
      samples.push({ variant, report: run(variant === 'before' ? before : after) })
    }
  }
  const summary = Object.fromEntries(['before', 'after'].map(variant => {
    const reports = samples.filter(s => s.variant === variant).map(s => s.report)
    const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!
    return [variant, {
      openMs: median(reports.map(r => r.phases!.openMs)),
      totalMs: median(reports.map(r => r.totalMs)),
      retainedHeapMb: median(reports.map(r => r.retained.heapUsedMb)),
      retainedRssMb: median(reports.map(r => r.retained.rssMb)),
      peakRssMb: median(reports.map(r => r.afterGc.peakRssMb)),
    }]
  }))
  await writeFile(output, JSON.stringify({ node: process.version, fixture: { ...fixture, path: undefined }, summary, samples }, null, 2))
  console.log(JSON.stringify(summary, null, 2))
} finally {
  // root is the exact private directory returned by mkdtemp, never a user path.
  await rm(root, { recursive: true, force: true })
}
