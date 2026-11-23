import { writeFileSync, readFileSync, globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { validationRecords } from '../../src/projection.ts'

writeFileSync('.harness-validation.json', JSON.stringify({ mode: 'development',
  checks: [{ id: 'test', command: null }], exclude: ['.sessions', '.dsh', '.agents'],
}))
const reports: string[] = []
const endings: unknown[] = []
const ctx = await bootProductionProfile({ binName: 'validation-composition', profile: 'headless',
  overlayPaths: [fileURLToPath(new URL('./composition.patch.yml', import.meta.url))],
  prepare(host) {
    host.on('session/event', (_session, event) => {
      const record = validationRecords([event])[0]
      if (record?.type === 'validation/report') reports.push(record.data.text)
      if (event.type === 'turn/end') endings.push(event.data)
    })
  },
})
try {
  const result = await runFixtureTurn(ctx, { task: 'Validate this project.' })
  await ctx.fiber.dispose()
  const persisted = globSync('.sessions/**/*.jsonl').some(path => readFileSync(path, 'utf8').includes('plugin:work-validation/report'))
  process.stdout.write(JSON.stringify({ output: result.output, reports, endings, persisted }) + '\n')
} finally {
  await ctx.fiber.dispose()
}
