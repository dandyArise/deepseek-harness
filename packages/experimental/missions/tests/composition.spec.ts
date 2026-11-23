import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { z } from 'zod'
import { stateSchema } from '../src/state.ts'

it('executes a separate model through the real Loader, enforces tools and recovers its result', async () => {
  const driver = fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url))
  const { stdout, stderr } = await runLoaderSmoke({
    label: 'missions Loader composition', tempDirPrefix: 'dsh-missions-loader-',
    binScript: driver, libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/composition.patch.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    processTimeoutMs: 60000,
  })
  expect(stderr).not.toContain('UNHANDLED')
  const result = z.object({ output: z.string(), state: stateSchema,
    routes: z.array(z.string()), denied: z.boolean(), persisted: z.boolean(),
    coldRoutes: z.array(z.string()), recovered: z.string() })
    .parse(JSON.parse(stdout.trim().split('\n').at(-1)!))
  expect(result.persisted).toBe(true)
  expect(result.denied).toBe(true)
  expect(result.state.tasks).toHaveLength(1)
  expect(result.state.tasks[0]).toMatchObject({ status: 'done', delivery: 'retrieved', verification: 'unverified', steps: 2 })
  expect(result.routes.filter(route => route === 'mission-worker/worker')).toHaveLength(2)
  expect(result.coldRoutes).toEqual(Array.from({ length: 3 }, () => 'mission-coordinator/coordinator'))
  expect(result.recovered).toBe(result.output)
  expect({ output: result.output, routes: result.routes, task: {
    ...result.state.tasks[0], childId: '<child-session>', startedAt: 0, endedAt: 0,
  } }).toMatchSnapshot()
}, 75000)
