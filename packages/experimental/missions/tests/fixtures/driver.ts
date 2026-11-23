import { readFileSync, globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { MissionState } from '../../src/state.ts'
import { stateSchema } from '../../src/state.ts'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

let state: MissionState | undefined
const routes: string[] = []
let denied = false
let probeCalls = 0
const errors: string[] = []
const overlays = [fileURLToPath(new URL('./composition.patch.yml', import.meta.url)),
  ...(process.env.MISSION_PROBE_NONCE ? [fileURLToPath(new URL('./live.patch.yml', import.meta.url))] : [])]
const ctx = await bootProductionProfile({ binName: 'mission-composition', profile: 'headless',
  overlayPaths: overlays,
  prepare(host) {
    host.on('agent/error', ({ error }) => {
      const message = error instanceof Error ? error.message : 'Unknown agent error'
      errors.push(process.env.MISSIONS_LIVE_KEY ? message.replaceAll(process.env.MISSIONS_LIVE_KEY, '[redacted]') : message)
    })
    host.on('agent/pre-step', async ({ modelSelection }, next) => {
      routes.push(`${modelSelection.provider}/${modelSelection.model}`)
      return next()
    })
    host.on('session/event', (_session, event) => {
      const record = pluginRecordOf(event)
      if (record?.type === 'plugin:missions/state') state = z.object({ state: stateSchema }).parse(record.data).state
      if (event.type === 'tool/result' && JSON.stringify(event.data).includes('MISSION_TOOL_DENIED')) denied = true
      if (event.type === 'tool/call' && event.data.name === 'mission_probe') probeCalls++
    })
  },
})
try {
  const result = await runFixtureTurn(ctx, { task: 'Delegate a bounded comparison to the research role, then retrieve its result.' })
  await ctx.fiber.dispose()
  const persisted = globSync('.sessions/**/*.jsonl').some(path => readFileSync(path, 'utf8').includes('plugin:missions/state'))
  const coldRoutes: string[] = []
  const cold = await bootProductionProfile({ binName: 'mission-recovery', profile: 'headless',
    overlayPaths: [...overlays, fileURLToPath(new URL('./resume.patch.yml', import.meta.url))],
    prepare(host) {
      host.on('agent/pre-step', async ({ modelSelection }, next) => {
        coldRoutes.push(`${modelSelection.provider}/${modelSelection.model}`)
        return next()
      })
    },
  })
  let recovered = ''
  try {
    await cold.agents.resume({ resumeSessionId: brandString<SessionId>(result.sessionId) })
    recovered = (await runFixtureTurn(cold, { task: 'Recover the existing comparison. Do not redo it.' })).output
  } finally { await cold.fiber.dispose() }
  process.stdout.write(JSON.stringify({ output: result.output, state, routes, denied, persisted, coldRoutes, recovered, probeCalls, errors }) + '\n')
} finally { await ctx.fiber.dispose() }
