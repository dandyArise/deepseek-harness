/** Opt-in diagnostic comparison: real provider, real shell, independent generated hidden oracle. */
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { provideWorkingDirectoryFixture, mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '../../../llm/llm-pi-ai/src/config.ts'
import { memoryAuth } from '../../../llm/llm-pi-ai/tests/auth-double.ts'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { PwshLocalExecutor } from '@deepseek-ai/dsh-pwsh-local'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import * as Validation from '../src/index.ts'
import * as RepeatToolReminder from '../../../guard/repeat-tool-reminder/src/index.ts'
import { validationRecords } from '../src/projection.ts'
import { z } from 'zod'
import { unsupportedSuccess, type Verdict } from '../src/evidence.ts'
import { generateScenario, scenarios, scenarioFixtureSchema } from './scenarios.ts'
import { hiddenOracle } from './oracle.ts'

it.skipIf(!process.env.DSH_VALIDATION_BENCHMARK)('measures paired generated scenarios without asserting model success', async () => {
  const model = process.env.DSH_VALIDATION_MODEL
  const output = process.env.DSH_VALIDATION_REPORT
  if (!model || !output) throw new Error('Set DSH_VALIDATION_MODEL and DSH_VALIDATION_REPORT for the benchmark')
  const baseURL = process.env.DSH_VALIDATION_URL ?? 'http://127.0.0.1:1234/v1'
  const reasoningEffort = process.env.DSH_VALIDATION_EFFORT ?? 'low'
  const reasoningWire = process.env.DSH_VALIDATION_EFFORT_WIRE ?? reasoningEffort
  const trials = Number(process.env.DSH_VALIDATION_TRIALS ?? 2)
  if (!Number.isInteger(trials) || trials < 1 || trials > 10) throw new Error('trials must be 1..10')
  const runId = randomUUID()
  const selected = process.env.DSH_VALIDATION_SCENARIOS?.split(',') ?? [...scenarios]
  if (selected.some(s => !scenarios.includes(s as typeof scenarios[number]))) throw new Error('Unknown scenario')
  const replayFile = process.env.DSH_VALIDATION_FIXTURE_FILE
  const replay = replayFile ? readFileSync(replayFile, 'utf8').trim().split('\n').map(line =>
    z.object({ trial: z.number(), scenario: z.string(), fixture: scenarioFixtureSchema }).parse(JSON.parse(line))) : undefined
  let records = 0
  for (let trial = 0; trial < trials; trial++) for (const scenario of scenarios.filter(s => selected.includes(s))) {
    const fixture = replay ? replay.find(row => row.trial === trial && row.scenario === scenario)?.fixture : generateScenario(scenario)
    if (!fixture) throw new Error(`Missing replay fixture: trial ${trial}, ${scenario}`)
    const pairId = randomUUID()
    for (const enabled of trial % 2 === 0 ? [false, true] : [true, false]) {
      const cwd = mkdtempSync(join(tmpdir(), 'harness-validation-bench-'))
      const ctx = new Context()
      const originalFetch = globalThis.fetch
      const wireRequests: unknown[] = []
      if (process.env.DSH_VALIDATION_TRACE) {
        globalThis.fetch = async (input, init) => {
          const url = input instanceof Request ? input.url : String(input)
          if (url.startsWith(baseURL) && url.includes('/chat/completions')) {
            const body = typeof init?.body === 'string' ? init.body : input instanceof Request ? await input.clone().text() : ''
            if (body) wireRequests.push(JSON.parse(body))
          }
          return originalFetch(input, init)
        }
      }
      try {
        writeFileSync(join(cwd, '.harness-validation.json'), JSON.stringify({ mode: 'development', checks: fixture.checks }))
        writeFileSync(join(cwd, 'solution.cjs'), fixture.code)
        writeFileSync(join(cwd, 'verify.cjs'), fixture.verifier)
        const initial = hiddenOracle(cwd, fixture)
        const digest = () => createHash('sha256').update(readFileSync(join(cwd, 'solution.cjs'))).digest('hex')
        provideWorkingDirectoryFixture(ctx, cwd)
        await mountAgentLoopTestDependencies(ctx)
        await ctx.plugin(AgentLoop, { agents: [] })
        await ctx.plugin(LocalFileSystem)
        await ctx.plugin(LocalSubprocessRuntime)
        await ctx.plugin(PwshLocalExecutor, { cwd, timeoutMs: 15000 })
        await ctx.plugin(ShellEnv)
        await ctx.plugin(ToolPwsh, { enableRunInBackground: false, promoteOnTimeout: false })
        ctx.tools.register(defineTool({ name: 'write_solution', description: 'Replace solution.cjs with CommonJS code exporting f(x).',
          parameters: { code: { type: 'string', required: true } },
          output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => [{ type: 'text', text: 'solution.cjs saved' }] },
          async execute(args) { writeFileSync(join(cwd, 'solution.cjs'), args.code); return { saved: true } },
        }))
        await ctx.plugin(Validation, { enabled, maxCorrections: fixture.maxCorrections, maxValidationSteps: 4 })
        await ctx.plugin(RepeatToolReminder, { sameResultThreshold: 3 })
        ctx.on('agent/pre-step', async ({ step }, next) => step >= 8 ? { kind: 'reject' } : next())
        ctx.tools.guard(exec => exec.name === 'write_solution' || (exec.name === 'pwsh'
          && typeof exec.arguments === 'object' && exec.arguments !== null && 'command' in exec.arguments
          && exec.arguments.command === 'node verify.cjs') ? undefined : 'Only write_solution and node verify.cjs are allowed in this fixture.')
        let lastExecution: { digest: string; passed: boolean } | undefined
        ctx.on('tools/result', (exec, result) => {
          if (exec.name !== 'pwsh' || result.isError) return
          const value = result.value as { kind?: string; exitCode?: number; aborted?: boolean; timedOut?: boolean }
          if (value.kind === 'foreground') lastExecution = { digest: digest(), passed: value.exitCode === 0 && !value.aborted && !value.timedOut }
        })
        ctx.llm.registerAdapter(['validation'], new PiAiAdapter({
          profiles: () => resolveProfiles({ validation: { api: 'openai-completions', baseURL,
            models: [{ id: model, contextWindow: 8192, maxTokens: 2048,
              ...(reasoningEffort === 'default' ? {} : { reasoningEfforts: { [reasoningEffort]: reasoningWire } }) }], timeoutMs: 90000 } }),
          resolveApiKey: () => Promise.resolve(process.env.DSH_VALIDATION_KEY), auth: memoryAuth(),
        }))
        const agent = await ctx.agentLoop.create(brandString<SessionId>(randomUUID()), {
          provider: 'validation', model, maxTokens: 2048,
          ...(reasoningEffort === 'default' ? {} : { reasoningEffort: brandString<ReasoningEffortId>(reasoningEffort) }),
        })
        const started = performance.now()
        const stepTimes: { step: number; elapsedMs: number }[] = []
        const toolTimes: { name: string; durationMs: number }[] = []
        ctx.on('agent/pre-step', async ({ step }, next) => {
          stepTimes.push({ step, elapsedMs: performance.now() - started })
          return next()
        })
        ctx.on('tools/execute', async (exec, next) => {
          const begin = performance.now()
          try { return await next() }
          finally { toolTimes.push({ name: exec.name, durationMs: performance.now() - begin }) }
        })
        agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: fixture.prompt }] }))
        let timedOut = false
        const deadline = setTimeout(() => { timedOut = true; agent.cancel({ kind: 'user' }) }, 90000)
        try { await agent.whenIdle() } finally { clearTimeout(deadline) }
        const durationMs = performance.now() - started
        const events = agent.session.snapshotEvents()
        const assistants = events.filter(e => e.type === 'assistant/message')
        const final = assistants.at(-1)?.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? ''
        const status: Verdict = !lastExecution ? 'not-run' : lastExecution.digest !== digest() ? 'stale' : lastExecution.passed ? 'passed' : 'failed'
        const rows = fixture.checks.map(check => ({ id: check.id, required: check.required, status: check.command ? status : 'not-run' as const }))
        const hidden = hiddenOracle(cwd, fixture)
        const invalidCalls = events.filter(e => e.type === 'tool/result' && ['INVALID_ARGS', 'UNKNOWN_TOOL'].includes(e.data.error?.code ?? '')).length
        const result = { runId, pairId, kind: 'generated-live', model, protocol: 'openai-completions', trial, scenario, enabled,
          parameters: { contextWindow: 8192, maxTokens: 2048, reasoningEffort, reasoningWire,
            maxSteps: 8, timeoutMs: 90000, sameResultThreshold: 3 },
          fixture, durationMs, timedOut, invalidCalls, stepTimes, toolTimes,
          repeatReminders: events.filter(e => e.type === 'user/message' && e.data.source.kind === 'repeat-tool-reminder').length,
          calls: events.filter(e => e.type === 'tool/call').map(e => e.data),
          ...(process.env.DSH_VALIDATION_TRACE ? { wireRequests } : {}),
          toolErrors: events.filter(e => e.type === 'tool/result').flatMap(e => e.data.error ? [e.data.error] : []),
          inputTokens: !assistants.length || assistants.some(e => !e.data.usage)
            ? null : assistants.reduce((n, e) => n + (e.data.usage?.inputTokens ?? 0), 0),
          outputTokens: !assistants.length || assistants.some(e => !e.data.usage)
            ? null : assistants.reduce((n, e) => n + (e.data.usage?.outputTokens ?? 0), 0),
          generated: assistants.length > 0, endings: events.filter(e => e.type === 'turn/end').map(e => e.data),
          hiddenTestSuccess: hidden?.every(Boolean) ?? null, hiddenTestsPassed: hidden?.filter(Boolean).length ?? null,
          regressions: initial && hidden ? initial.filter((passed, i) => passed && !hidden[i]).length : null,
          unsupportedSuccessHeuristic: unsupportedSuccess(final, rows), independentStatuses: rows,
          reports: validationRecords(events).filter(e => e.type === 'validation/report').map(e => e.data.text),
          final, finalCode: readFileSync(join(cwd, 'solution.cjs'), 'utf8'),
        }
        appendFileSync(output, JSON.stringify(result) + '\n')
        expect(result.generated, 'Provider failed before any generation; do not treat this as a model comparison').toBe(true)
        if (enabled && !timedOut) expect(result.reports.length, 'A bounded ending must expose current verification status').toBeGreaterThan(0)
        records++
      } finally { globalThis.fetch = originalFetch; await ctx.fiber.dispose(); rmSync(cwd, { recursive: true, force: true }) }
    }
  }
  expect(records).toBe(trials * selected.length * 2)
}, 3600000)
