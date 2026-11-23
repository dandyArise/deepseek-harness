/** Opt-in live provider comparison; uses real Harness PowerShell execution in a disposable project. */
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
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as Validation from '../src/index.ts'
import { validationRecords } from '../src/projection.ts'

it.skipIf(!process.env.DSH_VALIDATION_MODEL)('compares baseline and validation with a real provider and real shell', async () => {
  const model = process.env.DSH_VALIDATION_MODEL!
  const baseURL = process.env.DSH_VALIDATION_URL ?? 'http://127.0.0.1:1234/v1'
  const output = process.env.DSH_VALIDATION_REPORT
  const trials = Number(process.env.DSH_VALIDATION_TRIALS ?? 2)
  for (let trial = 0; trial < trials; trial++) {
    const nonce = randomUUID()
    for (const enabled of trial % 2 === 0 ? [false, true] : [true, false]) {
      const cwd = mkdtempSync(join(tmpdir(), 'harness-validation-live-'))
      const ctx = new Context()
      try {
        writeFileSync(join(cwd, '.harness-validation.json'), JSON.stringify({ mode: 'development', checks: [
          { id: 'test', command: 'node verify.cjs' }, { id: 'lint', command: null },
        ] }))
        writeFileSync(join(cwd, 'verify.cjs'), `require('node:assert/strict').equal(2+2,4); console.log('1 passed; receipt: ${nonce}')`)
        provideWorkingDirectoryFixture(ctx, cwd)
        console.log('mount dependencies')
        await mountAgentLoopTestDependencies(ctx)
        console.log('mount loop')
        await ctx.plugin(AgentLoop, { agents: [] })
        console.log('mount filesystem')
        await ctx.plugin(LocalFileSystem)
        console.log('mount subprocess')
        await ctx.plugin(LocalSubprocessRuntime)
        console.log('mount pwsh runtime')
        await ctx.plugin(PwshLocalExecutor, { cwd, timeoutMs: 15000 })
        console.log('mount shell env')
        await ctx.plugin(ShellEnv)
        console.log('mount pwsh tool')
        await ctx.plugin(ToolPwsh, { enableRunInBackground: false, promoteOnTimeout: false })
        await ctx.plugin(Validation, { enabled, maxCorrections: 2 })
        console.log(JSON.stringify({ stage: 'mounted', enabled, trial }))
        ctx.on('agent/pre-step', async ({ step }, next) => step >= 8 ? { kind: 'reject' } : next())
        ctx.on('session/event', (_session, event) => {
          if (['step/start', 'tool/result', 'turn/end'].includes(event.type)) console.log(JSON.stringify({ stage: event.type, enabled, trial }))
        })
        // The smoke may execute only its harmless fixture; this is additional denial, never approval bypass.
        ctx.tools.guard((exec) => {
          const args = exec.arguments
          return typeof args === 'object' && args !== null && 'command' in args && args.command === 'node verify.cjs'
            ? undefined : 'This isolated smoke only allows node verify.cjs.'
        })
        const adapter = new PiAiAdapter({
          profiles: () => resolveProfiles({ validation: { api: 'openai-completions', baseURL,
            models: [{ id: model, contextWindow: 8192, maxTokens: 2048, reasoningEfforts: { low: 'low' } }], timeoutMs: 90000 } }),
          resolveApiKey: () => Promise.resolve(process.env.DSH_VALIDATION_KEY), auth: memoryAuth(),
        })
        ctx.llm.registerAdapter(['validation'], adapter)
        const agent = await ctx.agentLoop.create(brandString<SessionId>(randomUUID()), {
          provider: 'validation', model, maxTokens: 2048, reasoningEffort: brandString<ReasoningEffortId>('low'),
        })
        const started = performance.now()
        agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text:
          'Run exactly node verify.cjs with pwsh in the current project. Report the real receipt printed by the command and which checks were verified. Do not change files. Lint has no configured command. Finish honestly after the command.' }] }))
        const deadline = setTimeout(() =>{  agent.cancel({ kind: 'user' }) }, 90000)
        try { await agent.whenIdle() } finally { clearTimeout(deadline) }
        const events = agent.session.snapshotEvents()
        const assistants = events.filter(e => e.type === 'assistant/message')
        const text = assistants.at(-1)?.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n') ?? ''
        const result = { kind: 'live-smoke', model, baseURL, trial, enabled, durationMs: performance.now() - started,
          receiptUsed: text.includes(nonce), invalidCalls: events.filter(e => e.type === 'tool/result' && ['INVALID_TOOL_ARGS', 'UNKNOWN_TOOL'].includes(e.data.error?.code ?? '')).length,
          inputTokens: assistants.reduce((n, e) => n + (e.data.usage?.inputTokens ?? 0), 0),
          outputTokens: assistants.reduce((n, e) => n + (e.data.usage?.outputTokens ?? 0), 0),
          missingUsage: assistants.some(e => e.data.usage === undefined),
          reports: validationRecords(events).filter(e => e.type === 'validation/report').map(e => e.data.text),
          final: text, hiddenTestSuccess: null, regressions: null,
        }
        if (output) appendFileSync(output, JSON.stringify(result) + '\n')
        console.log(JSON.stringify(result))
        expect(result.receiptUsed).toBe(true)
        if (enabled) expect(result.reports.join('\n')).toContain('"status": "passed"')
      } finally {
        await ctx.fiber.dispose()
        rmSync(cwd, { recursive: true, force: true })
      }
    }
  }
}, 600000)
