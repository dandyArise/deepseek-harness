import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import SessionStore, { SessionLogOffset, type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { expect, it } from 'vitest'
import SubagentRuntime, { type SubagentRunId } from '../src/index.ts'
import { subagentArchiveProjection, applySubagentArchiveLifecycle } from '../src/popup-archive.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'

it('validates archived IDs and inherited offsets when restoring a checkpoint', () => {
  const schema = subagentArchiveProjection.stateSchema
  expect(schema.safeParse({ archived: ['child'], auto: false, inherited: 0 }).success).toBe(true)
  for (const archived of [[1], [null], 'child']) {
    expect(schema.safeParse({ archived, auto: false, inherited: 0 }).success).toBe(false)
  }
  for (const inherited of [-1, 1.5, '0', Infinity, NaN]) {
    expect(schema.safeParse({ archived: [], auto: false, inherited }).success).toBe(false)
  }
})

it('automatically archives only successful local runs and preserves the archive and preference on replay', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    const id = (value: string) => brandString<SessionId>(value)
    const parent = ctx.sessions.create(id('auto-parent'))
    const info = (name: string, local = true) => ({
      id: id(name), parentSessionId: parent.id, local, provider: 'spawn',
      runId: brandString<SubagentRunId>(`run-${name}`),
    })
    const state = () => ctx.sessionProjections.snapshot(parent, ['subagentArchive']).values.subagentArchive
    ctx.emit('subagent/end', { ...info('opt-out'), stopReason: 'completed' })
    expect(state()).toEqual({ archived: [], auto: false })
    await ctx.subagents.updateArchive(parent, { action: 'setAuto', enabled: true })
    ctx.emit('subagent/start', info('running'))
    ctx.emit('subagent/end', { ...info('failed'), stopReason: 'error' })
    ctx.emit('subagent/end', { ...info('stopped'), stopReason: 'aborted' })
    ctx.emit('subagent/end', { ...info('external', false), stopReason: 'completed' })
    ctx.emit('subagent/end', { ...info('done'), stopReason: 'completed' })
    expect(state()).toEqual({ archived: [id('done')], auto: true })
    const events = parent.snapshotEvents()
    const replay = subagentArchiveProjection.wire.view(events.reduce<Parameters<typeof subagentArchiveProjection.apply>[0]>(
      (value, event) => subagentArchiveProjection.apply(value, event),
      subagentArchiveProjection.init(parent.header, SessionLogOffset(0)),
    ))
    expect(replay).toEqual(state())
    const seq = parent.seq
    ctx.emit('subagent/end', { ...info('done'), stopReason: 'completed' })
    expect(parent.seq).toBe(seq)
    ctx.emit('subagent/start', info('done'))
    expect(state()).toEqual({ archived: [], auto: true })
  } finally { await ctx.fiber.dispose() }
})

it('archives direct successful children, including an open inactive conversation, and replays the parent delta', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(TestSessionQuery)
    const id = (value: string) => brandString<SessionId>(value)
    const parent = ctx.sessions.create(id('parent'))
    const foreign = ctx.sessions.create(id('foreign'))
    for (const [name, status] of [['done', 'completed'], ['stopped', 'interrupted'], ['other', 'completed']] as const) {
      const child = ctx.sessions.create(id(name))
      const owner = name === 'other' ? foreign : parent
      owner.append('subagent/catalog', { version: 3, mode: 'continuable', childCreatedAt: 1, childId: child.id, label: name, name })
      child.append('subagent/descriptor', { version: 1, mode: 'continuable', provider: 'spawn', label: name })
      child.append('turn/start', { turn: 1 })
      child.append('turn/end', { turn: 1, reason: { kind: status } })
    }
    expect(ctx.sessions.get(id('done'))).toBeDefined()
    expect(await ctx.subagents.updateArchive(parent, { action: 'archiveCompleted' })).toEqual({ archived: [id('done')], auto: false })
    const length = parent.seq
    await ctx.subagents.updateArchive(parent, { action: 'archiveCompleted' })
    expect(parent.seq).toBe(length)
    await ctx.subagents.updateArchive(parent, { action: 'setAuto', enabled: true })
    expect(await ctx.subagents.updateArchive(parent, { action: 'restore', childId: id('done') })).toEqual({ archived: [], auto: true })
    applySubagentArchiveLifecycle(ctx, parent.id, id('done'), true)
    expect(ctx.sessionProjections.snapshot(parent, ['subagentArchive']).values.subagentArchive?.archived).toEqual([id('done')])
    applySubagentArchiveLifecycle(ctx, parent.id, id('done'), false)
    const events = parent.snapshotEvents()
    type ArchiveState = Parameters<typeof subagentArchiveProjection.apply>[0]
    const fold = (inherited: number) => subagentArchiveProjection.wire.view(events.reduce<ArchiveState>(
      (state, event) => subagentArchiveProjection.apply(state, event),
      subagentArchiveProjection.init(parent.header, SessionLogOffset(inherited)),
    ))
    expect(fold(0)).toEqual({ archived: [], auto: true })
    expect(fold(events.length)).toEqual({ archived: [], auto: false })
    await ctx.subagents.updateArchive(parent, { action: 'rename', childId: id('done'), name: '  Revue CSV  ' })
    await ctx.subagents.updateArchive(parent, { action: 'rename', childId: id('stopped'), name: 'En attente' })
    for (const update of [
      { action: 'rename', childId: id('other'), name: 'Foreign' },
      { action: 'rename', childId: id('done'), name: ' ' },
      { action: 'rename', childId: id('done'), name: 'x'.repeat(201) },
    ] as const) await expect(ctx.subagents.updateArchive(parent, update)).rejects.toThrow()
    const names = { done: 'Revue CSV', stopped: 'En attente' }
    expect(await ctx.subagents.updateArchive(parent, { action: 'archiveCompleted' })).toEqual({ archived: [id('done')], auto: true, names })
    const durable = parent.snapshotEvents().reduce<ArchiveState>(
      (state, event) => subagentArchiveProjection.apply(state, event),
      subagentArchiveProjection.init(parent.header, SessionLogOffset(0)),
    )
    expect(subagentArchiveProjection.wire.view(durable)).toEqual({ archived: [id('done')], auto: true, names })
    expect(await ctx.subagents.updateArchive(parent, { action: 'restore', childId: id('done') })).toEqual({ archived: [], auto: true, names })
  } finally { await ctx.fiber.dispose() }
})
