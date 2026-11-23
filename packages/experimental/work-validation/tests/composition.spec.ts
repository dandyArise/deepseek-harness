import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { z } from 'zod'

it('corrects an unsupported success claim through the production Loader profile', async () => {
  const driver = fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url))
  const { stdout, stderr } = await runLoaderSmoke({
    label: 'work validation Loader composition', tempDirPrefix: 'dsh-validation-loader-',
    binScript: driver, libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/composition.patch.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    processTimeoutMs: 60000,
  })
  expect(stderr).not.toContain('UNHANDLED')
  const lines = stdout.trim().split('\n')
  const result = z.object({ output: z.string(), reports: z.array(z.string()), persisted: z.boolean() }).parse(JSON.parse(lines.at(-1)!))
  expect(result.persisted).toBe(true)
  expect(result.output).toContain('Work is incomplete')
  expect({ output: result.output, reports: result.reports }).toMatchSnapshot()
}, 75000)
