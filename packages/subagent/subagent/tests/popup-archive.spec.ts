import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import SessionStore, { SessionLogOffset, type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { expect, it } from 'vitest'
import SubagentRuntime from '../src/index.ts'
import { subagentArchiveProjection, applySubagentArchiveLifecycle } from '../src/popup-archive.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'

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
  } finally { await ctx.fiber.dispose() }
})
