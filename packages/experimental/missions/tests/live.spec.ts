import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { z } from 'zod'
import { stateSchema } from '../src/state.ts'

it.skipIf(!process.env.MISSIONS_LIVE_KEY)('uses real Flash structured tools and recovers after restart without another worker call', async () => {
  const nonce = randomUUID()
  const driver = fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url))
  const started = performance.now()
  const { stdout, stderr } = await runLoaderSmoke({ label: 'missions live Flash', tempDirPrefix: 'dsh-missions-live-',
    binScript: driver, libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/composition.patch.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    env: { MISSION_PROBE_NONCE: nonce }, processTimeoutMs: 120000,
  })
  const result = z.object({ state: stateSchema, routes: z.array(z.string()),
    coldRoutes: z.array(z.string()), probeCalls: z.number(), persisted: z.boolean(), errors: z.array(z.string()) })
    .parse(JSON.parse(stdout.trim().split('\n').at(-1)!))
  if (result.state.tasks[0]?.status !== 'done') console.log(JSON.stringify({ task: result.state.tasks[0], errors: result.errors, stderr: stderr.replaceAll(process.env.MISSIONS_LIVE_KEY!, '[redacted]') }))
  expect(result.persisted).toBe(true)
  expect(result.probeCalls).toBe(1)
  expect(result.state.tasks[0]).toMatchObject({ status: 'done', delivery: 'retrieved', verification: 'unverified' })
  expect(result.state.tasks[0]?.output).toContain(nonce)
  expect(result.coldRoutes.every(route => route === 'mission-coordinator/coordinator')).toBe(true)
  console.log(JSON.stringify({ provider: 'AxForge', model: 'qwen3.8-flash-next', coordinator: 'scripted',
    worker: 'real', durationMs: Math.round(performance.now() - started), probeCalls: result.probeCalls,
    steps: result.state.tasks[0]?.steps, recoveredWithoutWorker: true }))
}, 135000)
