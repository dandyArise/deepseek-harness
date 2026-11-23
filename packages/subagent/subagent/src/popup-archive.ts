import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import type { SubagentArchiveState, SubagentArchiveUpdate } from './projection-types.ts'

type ArchiveDelta = { add: SessionId[] } | { restore: SessionId } | { auto: boolean } | { rename: SessionId; name: string }
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Records archived child session IDs, a restored child, or the automatic archive preference for the parent popup. */
    'subagent/popup-archive': ArchiveDelta
  }
}

const viewSchema = z.object({
  archived: z.array(z.custom<SessionId>(value => typeof value === 'string')),
  auto: z.boolean(),
  names: z.record(z.string(), z.string()).optional(),
})
const stateSchema = viewSchema.extend({
  inherited: z.custom<SessionLogOffset>(value => z.number().int().nonnegative().safeParse(value).success),
})

/** Fold parent-owned archive preferences and display names without changing child usage. */
export const subagentArchiveProjection = {
  key: 'subagentArchive',
  stateVersion: 1,
  stateSchema,
  init: (_header, inherited) => ({ archived: [], auto: false, inherited }),
  apply(state, event) {
    if (event.seq < state.inherited || event.type !== 'subagent/popup-archive') return state
    const delta = event.data
    if ('rename' in delta) return { ...state, names: { ...state.names, [delta.rename]: delta.name } }
    if ('auto' in delta) return { ...state, auto: delta.auto }
    if ('restore' in delta) return { ...state, archived: state.archived.filter(id => id !== delta.restore) }
    return { ...state, archived: [...new Set([...state.archived, ...delta.add])] }
  },
  wire: { viewSchema, view: ({ archived, auto, names }) => ({ archived, auto, ...names === undefined ? {} : { names } }) },
} satisfies ProjectionDefinition<'subagentArchive', z.infer<typeof stateSchema>>

function stateOf(ctx: Context, session: Session): SubagentArchiveState {
  const state = ctx.sessionProjections.snapshot(session, ['subagentArchive']).values.subagentArchive
  if (!state) throw new Error('Subagent archive projection unavailable')
  return state
}

/**
 * Only direct catalog members with a closed, successful turn are eligible for bulk archival.
 * @param ctx - session query and projection services.
 * @param parent - session owning the direct-child catalog and archive events.
 * @param update - archive, restore, rename or automatic-archive preference operation.
 * @param hasActiveRun - live activity check excluding running children from archival.
 * @returns the resulting parent archive snapshot.
 */
export async function updateSubagentArchive(ctx: Context, parent: Session, update: SubagentArchiveUpdate,
  hasActiveRun: (id: SessionId) => boolean): Promise<SubagentArchiveState> {
  const current = stateOf(ctx, parent)
  if (update.action === 'rename') {
    const name = update.name.trim()
    if (!name || name.length > 200) throw new Error('Agent display name must contain 1–200 characters')
    const children = ctx.sessionProjections.snapshot(parent, ['subagentCatalog']).values.subagentCatalog ?? []
    if (!children.some(child => child.id === update.childId && child.mode !== 'external' && child.mode !== 'unknown')) {
      throw new Error('Only a direct local child can be renamed')
    }
    if (current.names?.[update.childId] !== name) parent.append('subagent/popup-archive', { rename: update.childId, name })
  } else if (update.action === 'restore') {
    if (current.archived.includes(update.childId)) parent.append('subagent/popup-archive', { restore: update.childId })
  } else if (update.action === 'setAuto') {
    if (current.auto !== update.enabled) parent.append('subagent/popup-archive', { auto: update.enabled })
  } else {
    const children = ctx.sessionProjections.snapshot(parent, ['subagentCatalog']).values.subagentCatalog ?? []
    const query = ctx.get('sessionQuery')
    if (!query) throw new Error('Subagent archive needs session queries to verify completed turns')
    const completed: SessionId[] = []
    for (const child of children) {
      if (child.mode === 'external' || child.mode === 'unknown' || current.archived.includes(child.id) || hasActiveRun(child.id)) continue
      using observed = await query.observeSession(child.id)
      if (observed.projections?.values.subagentTiming?.lastTurnCompleted === true) completed.push(child.id)
    }
    const latest = stateOf(ctx, parent)
    const add = completed.filter(id => !hasActiveRun(id) && !latest.archived.includes(id))
    if (add.length) parent.append('subagent/popup-archive', { add })
  }
  return stateOf(ctx, parent)
}

/**
 * The manager supplies the direct parent and the actual terminal outcome. A resumed child becomes visible again.
 * @param ctx - live session and projection services.
 * @param parentId - direct parent owning the archive.
 * @param child - child whose lifecycle changed.
 * @param completed - successful terminal outcome; false restores a resumed child.
 */
export function applySubagentArchiveLifecycle(ctx: Context, parentId: SessionId, child: SessionId, completed: boolean): void {
  const parent = ctx.get('sessions')?.get(parentId)
  if (!parent) return
  const state = stateOf(ctx, parent)
  if (completed && state.auto && !state.archived.includes(child)) parent.append('subagent/popup-archive', { add: [child] })
  if (!completed && state.archived.includes(child)) parent.append('subagent/popup-archive', { restore: child })
}
