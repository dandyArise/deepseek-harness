import { describe, expect, it, vi } from 'vitest'
import { MissionRuntime } from '../src/runtime.ts'
import type { MissionHost } from '../src/runtime.ts'
import type { Limits, MissionState, TaskRequest } from '../src/state.ts'
import { stateSchema } from '../src/state.ts'

const limits: Limits = { maxTasks: 3, maxSteps: 3, taskSteps: 2, taskSeconds: 1, maxOutputTokens: 256, maxResultChars: 20 }
const request: TaskRequest = { id: 'compare', role: 'research', objective: 'Compare three products', acceptance: ['State sources and uncertainties'] }
function fixture(execute: MissionHost['execute'], saved?: MissionState) {
  let state: MissionState = saved ?? { limits: null, tasks: [] }
  const journal: MissionState[] = []
  const host: MissionHost = { read: () => state, childId: () => `child-${state.tasks.length}`,
    save: async (value) => { state = stateSchema.parse(structuredClone(value)); journal.push(state) }, execute: vi.fn(execute) }
  const create = () => new MissionRuntime(host, limits, [{ name: 'research', provider: 'local', model: 'model-a', tools: [] }])
  return { host, create, journal }
}
describe('mission admission and recovery', () => {
  it('routes work and recovers persisted results after restart without another execution', async () => {
    const f = fixture(async (input) => {
      expect(input.task.route.model).toBe('model-a')
      return { output: 'Sources unavailable; incomplete', completed: true }
    })
    const first = await f.create().run(request, new AbortController().signal)
    expect(first).toMatchObject({ status: 'done', verification: 'unverified', delivery: 'available', truncated: true })
    const restarted = f.create()
    expect(await restarted.retrieve(request.id)).toMatchObject({ output: first.output, delivery: 'retrieved' })
    expect(await restarted.run(request, new AbortController().signal)).toMatchObject({ output: first.output })
    expect(f.host.execute).toHaveBeenCalledTimes(1)
    await expect(restarted.run({ ...request, objective: 'Delete everything' }, new AbortController().signal)).rejects.toMatchObject({ code: 'MISSION_ID_CONFLICT' })
  })
  it('never dispatches if admission flush fails', async () => {
    const f = fixture(async () => ({ output: '', completed: true }))
    f.host.save = async () => { throw new Error('disk unavailable') }
    await expect(f.create().run(request, new AbortController().signal)).rejects.toThrow('disk unavailable')
    expect(f.host.execute).not.toHaveBeenCalled()
  })
  it('retains unknown crash outcomes instead of replaying effects', async () => {
    const f = fixture(async () => ({ output: '', completed: true }))
    await f.create().run(request, new AbortController().signal)
    const saved = structuredClone(f.host.read())
    saved.tasks[0]!.status = 'running'
    saved.tasks[0]!.delivery = 'pending'
    const cold = fixture(async () => { throw new Error('must not run') }, saved)
    expect((await cold.create().read()).tasks[0]?.status).toBe('interrupted')
    expect((await cold.create().run(request, new AbortController().signal)).status).toBe('interrupted')
    expect(cold.host.execute).not.toHaveBeenCalled()
  })
  it('bounds steps and retains consumption across runtime instances', async () => {
    const f = fixture(async ({ task }) => {
      expect(await run.admitStep(task.childId)).toBe(true)
      expect(await run.admitStep(task.childId)).toBe(true)
      expect(await run.admitStep(task.childId)).toBe(false)
      return { output: 'Partial work', completed: true }
    })
    const run: MissionRuntime = f.create()
    expect((await run.run(request, new AbortController().signal)).status).toBe('budget_exhausted')
    expect((await f.create().read()).tasks[0]?.steps).toBe(2)
  })
  it('denies concurrent new work but permits duplicate-id recovery', async () => {
    let finish!: () => void
    const barrier = new Promise<void>((resolve) => { finish = resolve })
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const f = fixture(async () => { started(); await barrier; return { output: 'ok', completed: true } })
    const run = f.create()
    const pending = run.run(request, new AbortController().signal)
    await entered
    await expect(run.run({ ...request, id: 'another' }, new AbortController().signal)).rejects.toMatchObject({ code: 'MISSION_BUSY' })
    expect((await run.run(request, new AbortController().signal)).status).toBe('running')
    finish()
    await pending
    expect(f.host.execute).toHaveBeenCalledTimes(1)
  })
  it('cancels at the deadline and reports timeout rather than success', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture(async ({ signal }) => {
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        return { output: 'partial', completed: true }
      })
      const pending = f.create().run(request, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(1001)
      expect((await pending).status).toBe('timed_out')
    } finally { vi.useRealTimers() }
  })
  it('rejects unconfigured roles and invalid durable records', async () => {
    const f = fixture(async () => ({ output: '', completed: true }))
    await expect(f.create().run({ ...request, role: 'unapproved-paid-api' }, new AbortController().signal)).rejects.toMatchObject({ code: 'MISSION_ROLE_UNKNOWN' })
    expect(stateSchema.safeParse({ tasks: [], limits: { ...limits, maxSteps: -1 } }).success).toBe(false)
    expect(f.host.execute).not.toHaveBeenCalled()
  })
  it('enforces the task ceiling and does not reset it when configuration changes', async () => {
    const f = fixture(async () => ({ output: 'ok', completed: true }))
    const run = f.create()
    for (const id of ['one', 'two', 'three']) await run.run({ ...request, id }, new AbortController().signal)
    const changedConfig = new MissionRuntime(f.host, { ...limits, maxTasks: 10 }, [
      { name: 'research', provider: 'local', model: 'model-a', tools: [] },
    ])
    await expect(changedConfig.run({ ...request, id: 'four' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'MISSION_BUDGET_EXHAUSTED' })
    expect(f.host.execute).toHaveBeenCalledTimes(3)
  })
  it('cancels only owned work on disposal and waits for execution to settle', async () => {
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const f = fixture(async ({ signal }) => {
      started()
      await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      return { output: 'partial', completed: true }
    })
    const run = f.create()
    const pending = run.run(request, new AbortController().signal)
    await entered
    run.stop()
    expect((await pending).status).toBe('stopped')
  })
})
