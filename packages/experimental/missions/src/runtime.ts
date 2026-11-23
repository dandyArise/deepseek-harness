/** Serialized mission admission and durable result recovery. */
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { Limits, MissionState, MissionTask, Role, TaskRequest } from './state.ts'

/** Execution inputs supplied to the existing subagent runtime. */
export interface TaskExecution {
  task: MissionTask
  limits: Limits
  signal: AbortSignal
}
/** Host-owned dependencies; reads come from a prepared session projection. */
export interface MissionHost {
  read(): MissionState
  save(state: MissionState): Promise<void>
  childId(): string
  execute(this: void, input: TaskExecution): Promise<{ output: string; completed: boolean }>
}

/** Mission failures retain stable codes through the existing tool pipeline. */
export class MissionError extends HarnessError {}

/** One root session's serial scheduler; no automatic replay of uncertain work. */
export class MissionRuntime {
  private tail: Promise<void> = Promise.resolve()
  private readonly active = new Map<string, AbortController>()

  constructor(private readonly host: MissionHost, private readonly limits: Limits, private readonly roles: readonly Role[]) {}

  private async transact<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  private async update(id: string, change: (task: MissionTask) => MissionTask): Promise<MissionTask> {
    return this.transact(async () => {
      const state = this.host.read()
      const task = state.tasks.find(t => t.request.id === id)
      if (!task) throw new MissionError('Unknown mission task', 'MISSION_NOT_FOUND')
      const updated = change(task)
      await this.host.save({ ...state, tasks: state.tasks.map(t => t === task ? updated : t) })
      return updated
    })
  }

  /** Reserve a step before admission. Retries within a step remain bounded by the task deadline.
   * @param childId - exact child session identity.
   * @returns whether the next step is permitted.
   */
  async admitStep(childId: string): Promise<boolean> {
    return this.transact(async () => {
      const state = this.host.read()
      const task = state.tasks.find(t => t.childId === childId)
      if (!task || !state.limits) return false
      const allowed = task.status === 'running' && this.active.has(task.request.id)
        && task.steps < state.limits.taskSteps
        && state.tasks.reduce((n, t) => n + t.steps, 0) < state.limits.maxSteps
      const updated: MissionTask = allowed ? { ...task, steps: task.steps + 1 }
        : { ...task, status: 'budget_exhausted', reason: 'Step budget exhausted or task no longer active.' }
      await this.host.save({ ...state, tasks: state.tasks.map(t => t === task ? updated : t) })
      return allowed
    })
  }

  /** Retrieve persisted results without invoking the model, including after restart.
   * @returns detached mission snapshot with uncertain executions marked interrupted.
   */
  async read(): Promise<MissionState> {
    return this.transact(async () => {
      const state = this.host.read()
      const tasks = state.tasks.map(task => task.status === 'running' && !this.active.has(task.request.id)
        ? { ...task, status: 'interrupted' as const, reason: 'Execution interrupted; inspect the child session before explicitly starting new work.' }
        : task)
      if (tasks.some((task, i) => task !== state.tasks[i])) await this.host.save({ ...state, tasks })
      return structuredClone({ ...state, tasks })
    })
  }

  /** Acknowledge retrieval separately from execution; repeat calls never regenerate.
   * @param id - existing task id.
   * @returns saved task with its result reference.
   */
  async retrieve(id: string): Promise<MissionTask> {
    await this.read()
    return this.update(id, task => task.delivery === 'pending' ? task : { ...task, delivery: 'retrieved' })
  }

  /** Execute a new id once. Reusing an id returns its outcome or rejects a changed contract.
   * @param request - validated task contract.
   * @param signal - caller cancellation, propagated to the child.
   * @returns persisted execution outcome, never an assertion that its content is verified.
   */
  async run(request: TaskRequest, signal: AbortSignal): Promise<MissionTask> {
    await this.read()
    const controller = new AbortController()
    const admitted = await this.transact(async () => {
      signal.throwIfAborted()
      const state = this.host.read()
      const existing = state.tasks.find(t => t.request.id === request.id)
      if (existing) {
        if (JSON.stringify(existing.request) !== JSON.stringify(request))
          throw new MissionError('Task id already belongs to another contract.', 'MISSION_ID_CONFLICT')
        return { task: existing, fresh: false, limits: state.limits ?? this.limits }
      }
      const limits = state.limits ?? this.limits
      if (state.tasks.length >= limits.maxTasks || state.tasks.reduce((n, t) => n + t.steps, 0) >= limits.maxSteps)
        throw new MissionError('Mission budget exhausted.', 'MISSION_BUDGET_EXHAUSTED')
      if (this.active.size) throw new MissionError('One worker is already running. Retrieve its result before starting another task.', 'MISSION_BUSY')
      const route = this.roles.find(role => role.name === request.role)
      if (!route) throw new MissionError('Select a configured mission role.', 'MISSION_ROLE_UNKNOWN')
      const task: MissionTask = { request, route, childId: this.host.childId(), status: 'running',
        delivery: 'pending', verification: 'unverified', steps: 0, startedAt: Date.now(), endedAt: null,
        output: '', truncated: false, reason: null }
      await this.host.save({ limits, tasks: [...state.tasks, task] })
      this.active.set(request.id, controller)
      return { task, fresh: true, limits }
    })
    if (!admitted.fresh) return structuredClone(admitted.task)
    const abort = () => { controller.abort(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, admitted.limits.taskSeconds * 1000)
    let output = ''
    let status: MissionTask['status'] = 'failed'
    let reason: string | null = null
    try {
      const result = await this.host.execute({ task: admitted.task, limits: admitted.limits, signal: controller.signal })
      output = result.output
      status = result.completed ? 'done' : 'failed'
      reason = result.completed ? null : 'Child execution did not complete; inspect its session.'
    } catch (error) {
      // Provider messages may contain sensitive request details. Keep diagnostics in the child log.
      reason = error instanceof MissionError ? error.message : 'Child execution failed; inspect its session.'
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
    try {
      return await this.update(request.id, task => ({ ...task,
        status: task.status === 'budget_exhausted' ? task.status : timedOut ? 'timed_out' : controller.signal.aborted ? 'stopped' : status,
        reason: task.reason ?? reason, endedAt: Date.now(),
        output: output.slice(0, admitted.limits.maxResultChars), truncated: output.length > admitted.limits.maxResultChars,
        delivery: 'available',
      }))
    } finally { this.active.delete(request.id) }
  }

  /** Cancel owned work when the plugin is disposed; execution owns settlement.
   */
  stop(): void { for (const controller of this.active.values()) controller.abort() }
}
