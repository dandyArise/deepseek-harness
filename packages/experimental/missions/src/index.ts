/** Opt-in, session-backed multi-model mission tasks using existing subagents. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { appendPluginRecord, type SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import { defineTool, ToolArgsError, ToolContextUnavailableError } from '@deepseek-ai/dsh-tools'
import { definition, limitsSchema, requestSchema, roleSchema } from './state.ts'
import type { Limits, Role } from './state.ts'
import { MissionError, MissionRuntime } from './runtime.ts'

export const name = 'missions'
export const inject = ['tools', 'subagents', 'sessions', 'sessionProjections', 'agents']
/** Explicit opt-in and host-controlled role routes. */
export interface Config {
  /** Enable mission tool registration; disabled by default. */
  enabled?: boolean
  /** Host-approved model routes and tool permissions for mission roles. */
  roles?: Role[]
  /** Bounds on mission tasks, execution steps, time and result sizes. */
  limits?: Limits
}
export const Config: schema<Config> = schema.object({
  enabled: schema.boolean().default(false),
  roles: schema.array(schema.object({ name: schema.string().required(), provider: schema.string().required(),
    model: schema.string().required(), tools: schema.array(schema.string()).required() })).default([]),
  limits: schema.object({ maxTasks: schema.number().default(8), maxSteps: schema.number().default(32),
    taskSteps: schema.number().default(8), taskSeconds: schema.number().default(120),
    maxOutputTokens: schema.number().default(2048), maxResultChars: schema.number().default(16000) }),
})

/** Register bounded mission tools; ordinary sessions remain unchanged when disabled.
 * @param ctx - plugin-owned services and lifecycle.
 * @param config - explicitly allowed model routes and limits.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!config.enabled) return
  const limits = limitsSchema.parse(config.limits)
  const roles = roleSchema.array().min(1).parse(config.roles)
  if (new Set(roles.map(r => r.name)).size !== roles.length) throw new MissionError('Role names must be unique.', 'MISSION_CONFIG')
  const projection = await ctx.sessionProjections.register(definition)
  const runtimes = new Map<Agent, MissionRuntime>()
  // References exist only while this plugin owns their executions, not in durable records.
  const work = new Set<Promise<unknown>>()
  const rootOnly = (agent: Agent | undefined): Agent => {
    if (!agent) throw new ToolContextUnavailableError('Mission tools require a session.')
    if (ctx.subagents.rootOf(agent) !== agent) throw new MissionError('Only the coordinator can schedule mission tasks.', 'MISSION_COORDINATOR_REQUIRED')
    return agent
  }
  function runtime(root: Agent): MissionRuntime {
    let owner = runtimes.get(root)
    if (owner) return owner
    owner = new MissionRuntime({
      read: projection.readerFor(root.session),
      async save(state) {
        appendPluginRecord(root.session, 'plugin:missions/state', { version: 1, state })
        if (!await ctx.sessions.flush(root.session))
          throw new MissionError('Mission persistence is unconfirmed. Inspect the saved task before retrying.', 'MISSION_PERSISTENCE_UNCONFIRMED')
      },
      childId: () => `mission-${randomUUID()}`,
      async execute({ task, limits: taskLimits, signal }) {
        signal.throwIfAborted()
        const provider = ctx.subagents.getProvider('spawn')
        if (!provider?.prepareContinuable || !provider.capabilities.agentOptions || !provider.capabilities.depthLimit)
          throw new MissionError('Missions require the local spawn provider with model selection and depth enforcement.', 'MISSION_PROVIDER_REQUIRED')
        const activation = await ctx.subagents.startActivation({
          provider: 'spawn', parent: root, childId: brandString<SessionId>(task.childId),
          label: `${task.request.role}: ${task.request.objective.slice(0,120)}`,
          agentOptions: { provider: task.route.provider, model: task.route.model,
            reasoningEffort: undefined, maxTokens: taskLimits.maxOutputTokens },
          maxDepth: 1, signal, delivery: 'caller',
          prompt: [{ type: 'text', text: JSON.stringify({ objective: task.request.objective,
            acceptance: task.request.acceptance, instruction: 'Report sources, evidence and limits. Do not claim independent verification. Do not delegate.' }) }],
        })
        // A published activation owns cancellation through dispose, not the startup signal.
        let disposing: Promise<void> | undefined
        const stop = () => { disposing ??= activation.dispose(); void disposing.catch(() => undefined) }
        signal.addEventListener('abort', stop, { once: true })
        if (signal.aborted) stop()
        try {
          const result = await activation.result
          return { completed: result.stopReason === 'completed',
            output: result.output.filter(b => b.type === 'text').map(b => b.text).join('\n') }
        } finally {
          signal.removeEventListener('abort', stop)
          await (disposing ?? activation.dispose())
        }
      },
    }, limits, roles)
    runtimes.set(root, owner)
    return owner
  }
  function childTask(agent: Agent) {
    const root = ctx.subagents.rootOf(agent)
    const task = projection.stateOf(root.session).tasks.find(t => t.childId === agent.id)
    return task ? { root, task } : undefined
  }
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const owned = childTask(agent)
    if (!owned) return next()
    if (!await runtime(owned.root).admitStep(agent.id)) return { kind: 'reject' }
    return next()
  })
  ctx.tools.guard((exec) => {
    if (!exec.agent) return undefined
    const owned = childTask(exec.agent)
    if (!owned) return undefined
    if (owned.task.status !== 'running' || !owned.task.route.tools.includes(exec.name)) return {
      reason: 'This tool is not allowed for this mission task.',
      info: { name: 'MissionError', code: 'MISSION_TOOL_DENIED' },
    }
    return undefined // Existing approvals and sandbox rules still apply.
  })
  const resultOutput = {
    schema: { type: 'object' as const, additionalProperties: false, properties: { report: { type: 'string' as const, required: true as const } } },
    render: (_args: unknown, value: { report: string }) => [{ type: 'text' as const, text: value.report }],
  }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mission_task',
    description: `Run one bounded mission task using a configured role. Roles: ${roles.map(r => `${r.name} (${r.provider}/${r.model})`).join(', ')}. Reusing the same id retrieves the task without rerunning it. Execution completion is not independent verification.`,
    parameters: {
      id: { type: 'string', required: true, description: 'Stable task id; reuse to recover a result, never to rerun.' },
      role: { type: 'string', required: true }, objective: { type: 'string', required: true },
      acceptance: { type: 'array', items: { type: 'string' }, required: true },
    }, output: resultOutput, isConcurrencySafe: () => false,
    async execute(args, exec) {
      const parsed = requestSchema.safeParse(args)
      if (!parsed.success) throw new ToolArgsError(['Task requires a valid id, role, objective and nonempty acceptance criteria.'])
      const pending = runtime(rootOnly(exec.agent)).run(parsed.data, exec.signal)
      work.add(pending)
      try { return { report: JSON.stringify(await pending) } }
      finally { work.delete(pending) }
    },
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mission_results', description: 'Read durable mission states and results. Does not invoke models or rerun tasks. Optional id acknowledges retrieval of that result.',
    parameters: { id: { type: 'string' } }, output: resultOutput, isConcurrencySafe: () => true,
    async execute(args, exec) {
      const owner = runtime(rootOnly(exec.agent))
      return { report: JSON.stringify(args.id ? await owner.retrieve(args.id) : await owner.read()) }
    },
  })))
  ctx.effect(() => async () => {
    for (const owner of runtimes.values()) owner.stop()
    await Promise.allSettled([...work])
    runtimes.clear()
  })
}
