import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { provideWorkingDirectoryFixture, mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as Validation from '../src/index.ts'
import * as RepeatToolReminder from '../../../guard/repeat-tool-reminder/src/index.ts'
import { validationRecords, definition } from '../src/projection.ts'

const contexts: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function harness(script: ConstructorParameters<typeof MockAdapter>[0], enabled = true, mode = 'development', maxValidationSteps = 4) {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-validation-'))
  dirs.push(cwd)
  writeFileSync(join(cwd, '.harness-validation.json'), JSON.stringify({ mode, checks: [{ id: 'test', command: 'npm test' }, { id: 'lint', command: null }] }))
  const ctx = new Context()
  contexts.push(ctx)
  provideWorkingDirectoryFixture(ctx, cwd)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(Validation, { enabled, maxCorrections: 2, maxValidationSteps })
  let executions = 0
  ctx.tools.register(defineTool({ name: 'pwsh', description: 'Test shell fixture',
    parameters: { command: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => [{ type: 'text', text: 'Shell result' }] },
    async execute() {
      executions++
      return { kind: 'foreground', cwd, exitCode: 0, aborted: false, timedOut: false, signal: null,
        stdout: { text: '4 passed', truncated: false }, stderr: { text: '', truncated: false } }
    },
  }))
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(brandString<SessionId>('validation-case'), { provider: 'mock', model: 'mock' })
  return { ctx, cwd, agent, adapter, executions: () => executions }
}
async function run(h: Awaited<ReturnType<typeof harness>>) {
  h.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Validate the project' }] }))
  await h.agent.whenIdle()
  return h.agent.session.snapshotEvents()
}
describe('validation in the real agent loop (scripted model and shell)', () => {
  it('provides current check commands after repetition without executing them or blocking useful calls', async () => {
    const h = await harness([
      ...Array.from({ length: 3 }, (_, i) => toolCallResponse(`repeat${i}`, 'pwsh', { command: 'echo saved' })),
      toolCallResponse('verify', 'pwsh', { command: 'npm test' }), textResponse('Tests passed; lint remains unverified.'),
    ])
    await h.ctx.plugin(RepeatToolReminder)
    const events = await run(h)
    const feedback = events.filter(e => e.type === 'user/message')
      .flatMap(e => e.data.content.filter(b => b.type === 'text').map(b => b.text))
    expect(feedback.some(text => text.includes('Current verification after repeated tools:')
      && text.includes('npm test') && text.includes('not-run'))).toBe(true)
    expect(h.executions()).toBe(4)
    expect(validationRecords(events).filter(e => e.type === 'validation/report').at(-1)?.data.text).toContain('"status": "passed"')
  })
  it('corrects invalid arguments before executing and reports a missing check honestly', async () => {
    const h = await harness([toolCallResponse('bad', 'pwsh', { command: 42 }), toolCallResponse('good', 'pwsh', { command: 'npm test' }),
      textResponse('All tests pass'), textResponse('Test passed; lint was not run because no command is configured.')])
    const events = await run(h)
    expect(h.executions()).toBe(1)
    expect(events.some(e => e.type === 'tool/result' && e.data.message.isError)).toBe(true)
    const reports = validationRecords(events).filter(e => e.type === 'validation/report')
    expect(reports[0]?.data.text).toContain('"status": "passed"')
    expect(reports[0]?.data.text).toContain('"status": "not-run"')
    expect(h.adapter.requests).toHaveLength(3)
    expect(events.filter(e => e.type === 'turn/end').at(-1)?.data.reason.kind).not.toBe('error')
  })
  it('bounds repeated unsupported success claims', async () => {
    const h = await harness(Array.from({ length: 4 }, () => textResponse('All tests pass')))
    const events = await run(h)
    expect(h.adapter.requests).toHaveLength(3)
    expect(validationRecords(events).filter(e => e.type === 'validation/report' && e.data.correction)).toHaveLength(2)
  })
  it('does not extend explanation-only turns in automatic mode', async () => {
    const h = await harness([textResponse('The function adds two numbers.')], true, 'auto')
    await run(h)
    expect(h.adapter.requests).toHaveLength(1)
  })
  it('publishes missing checks without making an honest answer regenerate', async () => {
    const h = await harness([textResponse('Work incomplete: tests could not run; lint has no command.')])
    const records = validationRecords(await run(h)).filter(e => e.type === 'validation/report')
    expect(h.adapter.requests).toHaveLength(1)
    expect(records).toHaveLength(1)
    expect(records[0]?.data.correction).toBe(false)
    expect(records[0]?.data.text).toContain('not-run')
  })
  it('retains the original behavior when disabled', async () => {
    const h = await harness([textResponse('All tests pass')], false)
    expect(validationRecords(await run(h))).toHaveLength(0)
    expect(h.adapter.requests).toHaveLength(1)
  })
  it('invalidates a green check after an external edit', async () => {
    let directory = ''
    const h = await harness([toolCallResponse('run', 'pwsh', { command: 'npm test' }), () => {
      writeFileSync(join(directory, 'changed.ts'), 'broken')
      return textResponse('All tests pass')
    }, textResponse('The previous test is stale; work is incomplete.')])
    directory = h.cwd
    const events = await run(h)
    expect(validationRecords(events).filter(e => e.type === 'validation/report')[0]?.data.text).toContain('"status": "stale"')
  })
  it('records failure if a downstream policy blocks a raw successful command', async () => {
    const h = await harness([toolCallResponse('run', 'pwsh', { command: 'npm test' }),
      textResponse('Work incomplete.'), textResponse('The verification was blocked.')])
    h.ctx.on('tools/post-execute', async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'blocked by policy' }] }))
    const events = await run(h)
    expect(validationRecords(events).filter(e => e.type === 'validation/report')[0]?.data.text).toContain('"status": "failed"')
  })
  it('unknown tool names never execute and the model can recover', async () => {
    const h = await harness([toolCallResponse('bad', 'no_such_tool', {}), toolCallResponse('good', 'pwsh', { command: 'npm test' }),
      textResponse('Incomplete: lint not configured.'), textResponse('Test passed. Lint remains unverified.')])
    const events = await run(h)
    expect(h.executions()).toBe(1)
    expect(events.some(e => e.type === 'tool/result' && e.data.error?.code === 'UNKNOWN_TOOL')).toBe(true)
  })
  it('stops extra tool loops at the step bound with freshly computed stale evidence', async () => {
    let directory = ''
    const h = await harness([toolCallResponse('run', 'pwsh', { command: 'npm test' }), textResponse('All checks pass'), () => {
      writeFileSync(join(directory, 'changed.ts'), 'changed after the report')
      return toolCallResponse('other', 'pwsh', { command: 'echo done' })
    }], true, 'development', 1)
    directory = h.cwd
    const events = await run(h)
    expect(h.adapter.requests).toHaveLength(3)
    const reports = validationRecords(events).filter(e => e.type === 'validation/report')
    expect(reports.at(-1)?.data.text).toContain('budget exhausted')
    expect(reports.at(-1)?.data.text).toContain('"status": "stale"')
  })
  it('replays evidence and correction bounds from serializable ignorable records', async () => {
    const h = await harness([toolCallResponse('run', 'pwsh', { command: 'npm test' }),
      textResponse('All checks pass'), textResponse('Test passed; lint was not run.')])
    const events = await run(h)
    let state = definition.init(h.agent.session.header, h.agent.session.inheritedEventCount)
    for (const event of events) state = definition.apply(state, event)
    expect(state.corrections).toBe(1)
    expect(state.evidence.test?.exitCode).toBe(0)
    expect(definition.stateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state)
    expect(events.filter(e => e.type.startsWith('plugin:work-validation/')).every(e => e.ignorable)).toBe(true)
  })
  it('does not count a successful unrelated command as a required check', async () => {
    const h = await harness([toolCallResponse('run', 'pwsh', { command: 'echo ok' }),
      textResponse('Work incomplete.'), textResponse('Tests were not executed.')])
    const reports = validationRecords(await run(h)).filter(e => e.type === 'validation/report')
    expect(reports[0]?.data.text).toContain('"status": "not-run"')
    expect(reports[0]?.data.text).not.toContain('"status": "passed"')
  })
  it('refuses proof for a configured directory outside the observed project', async () => {
    const h = await harness([toolCallResponse('run', 'pwsh', { command: 'npm test' }),
      textResponse('Work incomplete.'), textResponse('Tests remain unverified.')])
    writeFileSync(join(h.cwd, '.harness-validation.json'), JSON.stringify({ mode: 'development',
      checks: [{ id: 'test', command: 'npm test', cwd: '..' }] }))
    const reports = validationRecords(await run(h)).filter(e => e.type === 'validation/report')
    expect(reports[0]?.data.text).toContain('"status": "not-run"')
  })
  it.each([false, true])('compares invalid raw-tool execution with validation enabled=%s', async (enabled) => {
    const h = await harness([toolCallResponse('bad', 'raw_tool', { count: 'wrong' }),
      toolCallResponse('good', 'raw_tool', { count: 2 }), textResponse('Inspection complete.')], enabled, 'inspection')
    let executions = 0
    h.ctx.tools.register({ name: 'raw_tool', description: 'An integration without defineTool.',
      parameters: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false },
      output: { schema: { type: 'object', properties: {} }, render: () => [{ type: 'text', text: 'done' }] },
      async execute() { executions++; return {} },
    })
    const events = await run(h)
    expect(executions).toBe(enabled ? 1 : 2)
    expect(events.some(e => e.type === 'tool/result' && e.data.error?.code === 'INVALID_ARGS')).toBe(enabled)
  })
  it('publishes a final status when an upstream step budget rejects continuation', async () => {
    const h = await harness([toolCallResponse('run', 'pwsh', { command: 'npm test' })])
    h.ctx.on('agent/pre-step', async ({ step }, next) => step >= 2 ? { kind: 'reject' } : next())
    const records = validationRecords(await run(h)).filter(e => e.type === 'validation/report')
    expect(h.adapter.requests).toHaveLength(1)
    expect(records.at(-1)?.data.text).toContain('Continuation rejected')
    expect(records.at(-1)?.data.text).toContain('"status": "passed"')
    expect(records.at(-1)?.data.text).toContain('"status": "not-run"')
  })
})
