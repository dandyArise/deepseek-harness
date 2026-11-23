/** Opt-in evidence-based development validation using existing loop extension points. @module */
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-working-directory'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { definition } from './projection.ts'
import './projection.ts'
import { claimsSuccess, unsupportedSuccess, verdict } from './evidence.ts'
import { fingerprint, loadProject } from './files.ts'
import type { ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { Evidence, Project, Fingerprint } from './evidence.ts'
import type { ValidationState } from './projection.ts'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap { 'work-validation': { kind: 'work-validation' } & ContextFormed }
}
export const name = 'work-validation'
export const inject = ['tools', 'fs', 'workingDirectory', 'sessionProjections']
/** Bounded correction and filesystem observation policy; disabled leaves existing behavior unchanged. */
export interface Config {
  /** Enable evidence collection and bounded final-answer correction. */
  enabled?: boolean
  /** Maximum corrections requested for unsupported success claims per turn. */
  maxCorrections?: number
  /** Maximum continuation steps after the first validation report. */
  maxValidationSteps?: number
  /** Maximum number of files inspected per project fingerprint. */
  maxFiles?: number
  /** Maximum total file bytes inspected per project fingerprint. */
  maxBytes?: number
}
export const Config: schema<Config> = schema.object({
  enabled: schema.boolean().default(false), maxCorrections: schema.number().default(2),
  maxValidationSteps: schema.number().default(4),
  maxFiles: schema.number().default(10000), maxBytes: schema.number().default(64 * 1024 * 1024),
})
const streamSchema = z.object({ text: z.string(), truncated: z.boolean(), spillPath: z.string().exactOptional() })
const foregroundSchema = z.object({
  kind: z.literal('foreground'), cwd: z.string(), exitCode: z.number().nullable(),
  aborted: z.boolean(), timedOut: z.boolean(), signal: z.string().nullable(),
  stdout: streamSchema, stderr: streamSchema,
})

// Optional plugin integration: its source kind exists only when that plugin is mounted.
function isRepeatNotice(source: { kind: string }): boolean {
  return source.kind === 'repeat-tool-reminder'
}

/** Register disposable hooks without adding any command execution or approval bypass.
 * @param ctx - plugin-owned context.
 * @param config - observation and continuation bounds.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.enabled) return
  const limits = { maxFiles: config.maxFiles ?? 10000, maxBytes: config.maxBytes ?? 64 * 1024 * 1024 }
  const maxCorrections = config.maxCorrections ?? 2
  const maxValidationSteps = config.maxValidationSteps ?? 4
  for (const value of [limits.maxFiles, limits.maxBytes, maxCorrections, maxValidationSteps]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('work-validation limits must be nonnegative safe integers')
  }
  const handle = await ctx.sessionProjections.register(definition)
  ctx.tools.guard((exec) => {
    const tool = ctx.tools.get(exec.name, exec.agent, exec.toolSet)
    if (!tool) return undefined // The registry owns UNKNOWN_TOOL and scoped visibility.
    try {
      assertSupportedJsonSchema(tool.parameters)
      const violations = validateJsonSchemaValue(tool.parameters, exec.arguments, '')
      return violations.length ? {
        reason: JSON.stringify({ code: 'INVALID_ARGS', tool: exec.name, violations, action: 'Correct the arguments and retry.' }),
        info: { name: 'ToolArgsError', code: 'INVALID_ARGS' },
      } : undefined
    } catch (error) {
      return { reason: `Cannot validate the registered schema for ${exec.name}: ${String(error)}`,
        info: { name: 'ToolSchemaError', code: 'UNSUPPORTED_TOOL_SCHEMA' } }
    }
  })
  async function reportRows(state: ValidationState, project: Project, cwd: string, current: Fingerprint, signal: AbortSignal) {
    const root = await ctx.fs.resolve(cwd, { signal })
    return Promise.all(project.checks.map(async (check) => {
      const evidence = state.evidence[check.id]
      const expected = await ctx.fs.resolve(check.cwd, { cwd, signal })
      const actual = evidence ? await ctx.fs.resolve(evidence.cwd, { signal }) : undefined
      const matching = ctx.fs.contains(root, expected) && evidence?.command === check.command
        && actual?.targetKey === expected.targetKey ? evidence : undefined
      return { id: check.id, required: check.required, command: check.command,
        status: check.command === null ? 'not-run' as const : verdict(matching, current) }
    }))
  }
  const pending = new Map<ToolExecutionToken, { checkIds: string[]; evidence: Evidence }>()
  ctx.on('tools/result', (exec, result) => {
    const record = pending.get(exec.token)
    pending.delete(exec.token)
    if (!record || !exec.agent) return
    const final = result.isError ? undefined : foregroundSchema.safeParse(result.value)
    if (!final?.success || final.data.cwd !== record.evidence.cwd) {
      record.evidence = { ...record.evidence, exitCode: null, interrupted: true }
    }
    else record.evidence = { ...record.evidence, exitCode: final.data.exitCode,
      interrupted: final.data.aborted || final.data.timedOut || final.data.signal !== null,
      stdout: final.data.stdout, stderr: final.data.stderr }
    appendPluginRecord(exec.agent.session, 'plugin:work-validation/execution', record)
    return undefined
  })
  ctx.effect(() => () => { pending.clear() })
  ctx.on('agent/pre-step', async ({ agent, turn, signal }, next) => {
    const decision = await next()
    const state = handle.readerFor(agent.session)()
    if (decision.kind !== 'enter') {
      // Preserve an upstream budget/policy rejection, but do not leave an old green report behind.
      if (state.baseline && !signal.aborted) {
        const cwd = await ctx.workingDirectory.ensure(agent, signal)
        const project = await loadProject(ctx.fs, cwd, signal)
        if (project.mode !== 'inspection') {
          const current = await fingerprint(ctx.fs, cwd, project, limits, signal)
          const changed = current.digest === null || current.digest !== state.baseline.digest
          if (project.mode === 'development' || changed || state.reports || claimsSuccess(state.finalText)) {
            const rows = await reportRows(state, project, cwd, current, signal)
            const text = 'Continuation rejected by the session budget or policy. Current verification evidence:\n'
              + JSON.stringify(rows, null, 2) + (current.error ? `\nObservation incomplete: ${current.error}` : '')
            appendPluginRecord(agent.session, 'plugin:work-validation/report', { turn, text, correction: false })
            agent.session.append('user/message', createUserMessage({ source: { kind: 'work-validation' },
              content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
          }
        }
      }
      return decision
    }
    if (state.reports > 0 && state.validationSteps >= maxValidationSteps) {
      const cwd = await ctx.workingDirectory.ensure(agent, signal)
      const project = await loadProject(ctx.fs, cwd, signal)
      const current = await fingerprint(ctx.fs, cwd, project, limits, signal)
      const rows = await reportRows(state, project, cwd, current, signal)
      const text = 'Validation continuation budget exhausted. Current verification evidence:\n' + JSON.stringify(rows, null, 2)
        + (current.error ? `\nObservation incomplete: ${current.error}` : '')
      appendPluginRecord(agent.session, 'plugin:work-validation/report', { turn, text, correction: false })
      agent.session.append('user/message', createUserMessage({ source: { kind: 'work-validation' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
      return { kind: 'reject' }
    }
    if (state.baseline) {
      if (!decision.messages.some(message => isRepeatNotice(message.source))) return decision
      const cwd = await ctx.workingDirectory.ensure(agent, signal)
      const project = await loadProject(ctx.fs, cwd, signal)
      if (project.mode === 'inspection') return decision
      const current = await fingerprint(ctx.fs, cwd, project, limits, signal)
      const rows = await reportRows(state, project, cwd, current, signal)
      return { ...decision, messages: [...decision.messages, createUserMessage({
        source: { kind: 'work-validation' }, content: [{ type: 'text', text:
          'Current verification after repeated tools: ' + JSON.stringify(rows)
          + '\nA saved file is not a test result. For requested verification, execute the configured command using the shell tool; '
          + 'another identical write cannot verify it. Respect instructions not to rerun checks. If unable to proceed, report the limitation.'
          + (current.error ? `\nObservation incomplete: ${current.error}` : '') }],
      })] }
    }
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const project = await loadProject(ctx.fs, cwd, signal)
    const initial = await fingerprint(ctx.fs, cwd, project, limits, signal)
    appendPluginRecord(agent.session, 'plugin:work-validation/baseline', { turn, cwd, fingerprint: initial })
    if (project.mode === 'inspection') return decision
    return { ...decision, messages: [...decision.messages, createUserMessage({
      source: { kind: 'work-validation' }, content: [{ type: 'text', text:
        'Checks: ' + JSON.stringify(project.checks)
        + '\nClaim only checks executed on current files. Missing commands are unverified. Explanation-only tasks need no checks.' }],
    })] }
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (!exec.agent || !['pwsh', 'bash'].includes(exec.name)) return next()
    const args = z.object({ command: z.string() }).safeParse(exec.arguments)
    if (!args.success) return next() // Existing schema validation returns the structured error.
    const agent = exec.agent
    const cwd = await ctx.workingDirectory.ensure(agent, exec.signal)
    const project = await loadProject(ctx.fs, cwd, exec.signal)
    const before = await fingerprint(ctx.fs, cwd, project, limits, exec.signal)
    const started = performance.now()
    const result = await next()
    const durationMs = performance.now() - started
    if (result.isError) return result
    const parsed = foregroundSchema.safeParse(result.value)
    if (!parsed.success) return result // Background jobs are not completed verification evidence.
    const value = parsed.data
    const after = await fingerprint(ctx.fs, cwd, project, limits, exec.signal)
    const checkIds: string[] = []
    const root = await ctx.fs.resolve(cwd, { signal: exec.signal })
    for (const check of project.checks) {
      const target = await ctx.fs.resolve(check.cwd, { cwd, signal: exec.signal })
      const actual = await ctx.fs.resolve(value.cwd, { signal: exec.signal })
      if (ctx.fs.contains(root, target) && check.command === args.data.command && target.targetKey === actual.targetKey) {
        checkIds.push(check.id)
      }
    }
    pending.set(exec.token, { checkIds, evidence: {
      callId: exec.callId, command: args.data.command, cwd: value.cwd, durationMs,
      exitCode: value.exitCode, interrupted: value.aborted || value.timedOut || value.signal !== null,
      before, after, stdout: value.stdout, stderr: value.stderr,
    } })
    return result
  })
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const state = handle.readerFor(agent.session)()
    const cwd = await ctx.workingDirectory.ensure(agent, signal)
    const project = await loadProject(ctx.fs, cwd, signal)
    if (project.mode === 'inspection') return
    const current = await fingerprint(ctx.fs, cwd, project, limits, signal)
    const changed = state.baseline?.digest !== current.digest || current.digest === null
    const positive = claimsSuccess(state.finalText)
    if (project.mode === 'auto' && !changed && !positive && state.reports === 0) return
    const rows = await reportRows(state, project, cwd, current, signal)
    const correction = state.corrections < maxCorrections && unsupportedSuccess(state.finalText, rows)
    const text = 'Verification evidence (authoritative):\n' + JSON.stringify(rows, null, 2)
      + (current.error ? `\nObservation incomplete: ${current.error}` : '')
      + (correction ? '\nCorrect unsupported success claims. Give an honest final answer; incomplete work is allowed.'
        : '\nNo further validation correction is requested. Missing, failed and stale checks remain unverified.')
    appendPluginRecord(agent.session, 'plugin:work-validation/report', { turn, text, correction })
    const message = createUserMessage({ source: { kind: 'work-validation' }, content: [{ type: 'text', text }] })
    if (correction) agent.steer(message)
    else agent.session.append('user/message', message, { surfaceOp: 'append' })
  })
}
