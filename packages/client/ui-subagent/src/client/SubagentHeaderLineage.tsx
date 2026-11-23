import { useMemo, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  type SessionProjectionMap, type SessionSummary,
  type SessionProjectionSnapshot,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SubagentAddress, SubagentArchiveUpdate } from '@deepseek-ai/dsh-subagent/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  IconChevronRightOutlineRegular, IconRefreshOutlineRegular, IconUsersOutlineRegular,
  IconCheckOutlineRegular, MenuSurface, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-token-meter/client'
import type {} from '@deepseek-ai/dsh-agent-team/client'
import type {} from './slots.ts'
import css from './SubagentHeaderLineage.module.css'

function subscribeSidebar(listener: () => void) {
  document.addEventListener('session-agents-sidebar-change', listener)
  return () => { document.removeEventListener('session-agents-sidebar-change', listener) }
}

type SubagentCatalogSnapshot = Omit<SessionProjectionSnapshot, 'values' | 'state'> & {
  state: 'idle' | 'loading' | 'ready' | 'migration-required' | 'error'
  entries: (SessionProjectionMap['subagentCatalog'][number] & { activity: 'running' | 'inactive'; failed?: boolean })[]
}
type Catalogs = Readonly<Record<SessionId, SubagentCatalogSnapshot>>

/** Business actions supplied by the slot registration. */
export type SubagentCatalogInjected = {
  renameAgent?: (address: SubagentAddress, title: string) => Promise<void>
  updateArchive?: (update: SubagentArchiveUpdate) => Promise<void>
  openAgents?: () => void
  agentAction?: (address: SubagentAddress, action: 'stop' | 'result' | 'instruction' | 'retry') => Promise<string>
  openChild: (address: SubagentAddress) => void
  openChildAside: (address: SubagentAddress) => void
  refreshProjection: (parentSessionId: SessionId) => void
  /** Read this catalog and its direct children after explicit activation or retry. */
  prepareCatalog: (parentSessionId: SessionId) => Promise<void>
}

/** Root catalog actions and availability of its optional footer. */
export type SubagentCatalogActionInjected = SubagentCatalogInjected & {
  hooks: {
    /** Whether the catalog footer currently has a registered contributor. */
    footerAvailable: HostObservable<boolean>
  }
}

/** Full props for the session-header lineage renderer. */
export type SubagentHeaderLineageProps =
  PropsRuntime<'conversation.session.header.lineage'> & InjectFace<SubagentCatalogInjected> & PropsLocale<typeof NS>

interface CatalogRowsProps {
  parentSessionId: SessionId
  currentSessionId: SessionId | undefined
  catalog: SubagentCatalogSnapshot
  catalogs: Catalogs
  summaries: Readonly<Record<SessionId, SessionSummary>>
  expanded: ReadonlySet<SessionId>
  level: number
  openChild: (address: SubagentAddress) => void
  openChildAside: (address: SubagentAddress) => void
  refreshProjection: (parentSessionId: SessionId) => void
  toggleBranch: (childSessionId: SessionId) => void
  closeCatalog: () => void
}

function treeItems(root: HTMLDivElement | null): HTMLElement[] {
  return root === null
    ? []
    : Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]:not([aria-disabled="true"])'))
}

/** Compact token count shared in shape with the conversation stats strip. */
function formatTokens(value: number, t: TranslateNS<typeof NS>): string {
  const scaled = (next: number): string => next >= 100
    ? String(Math.round(next))
    : String(Math.round(next * 10) / 10)
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return t('tokens.thousand', { value: scaled(value / 1_000) })
  return t('tokens.million', { value: scaled(value / 1_000_000) })
}

/** Sum the four disjoint durable provider-usage buckets. */
function tokenTotal(
  usage: SessionProjectionMap['tokenUsage'] | undefined,
): number | undefined {
  return usage === undefined
    ? undefined
    : usage.uncachedInputTokens + usage.outputTokens
      + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** Exact whole-second active-turn duration for one catalog row. */
function activityDuration(
  summary: SessionSummary | undefined,
  activity: 'running' | 'inactive',
  now: number,
): number | undefined {
  if (summary === undefined) return undefined
  const timing: SessionProjectionMap['subagentTiming'] | undefined
    = summary.projectionValues?.subagentTiming
  if (timing === undefined) return undefined
  if (timing.active === undefined) return timing.settledMs
  const end = activity === 'running'
    ? now
    : timing.active.through
  return timing.settledMs + Math.max(0, end - timing.active.since)
}

interface DurationParts {
  seconds: number
  minutes: number
  hours: number
  days: number
  totalMinutes: number
  totalHours: number
}

function splitDuration(ms: number): DurationParts {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1_000)
  const totalMinutes = Math.floor(totalSeconds / 60)
  const totalHours = Math.floor(totalMinutes / 60)
  return {
    seconds: totalSeconds % 60,
    minutes: totalMinutes % 60,
    hours: totalHours % 24,
    days: Math.floor(totalHours / 24),
    totalMinutes,
    totalHours,
  }
}

/** Format a duration with decreasing visual precision at larger scales. */
function formatDuration(ms: number, t: TranslateNS<typeof NS>): string {
  const { seconds, minutes, hours, days, totalMinutes, totalHours } = splitDuration(ms)
  if (days >= 365) {
    const years = Math.floor(days / 365)
    const months = Math.floor((days % 365) / 30)
    return months === 0
      ? t('duration.years', { years })
      : t('duration.yearsMonths', { years, months })
  }
  if (days >= 30) {
    const months = Math.floor(days / 30)
    const remainingDays = days % 30
    return remainingDays === 0
      ? t('duration.months', { months })
      : t('duration.monthsDays', { months, days: remainingDays })
  }
  if (days > 0) {
    return hours === 0
      ? t('duration.days', { days })
      : t('duration.daysHours', { days, hours })
  }
  if (totalHours > 0) {
    return t('duration.hours', {
      hours: totalHours,
      minutes: String(minutes).padStart(2, '0'),
      seconds: String(seconds).padStart(2, '0'),
    })
  }
  if (totalMinutes > 0) {
    return t('duration.minutes', {
      minutes: totalMinutes,
      seconds: String(seconds).padStart(2, '0'),
    })
  }
  return t('duration.seconds', { seconds })
}

/** Preserve exact whole seconds for hover and accessible naming. */
function formatExactDuration(ms: number, t: TranslateNS<typeof NS>): string {
  const { seconds, minutes, hours, days } = splitDuration(ms)
  return days === 0
    ? formatDuration(ms, t)
    : t('duration.exactDays', {
      days,
      hours: String(hours).padStart(2, '0'),
      minutes: String(minutes).padStart(2, '0'),
      seconds: String(seconds).padStart(2, '0'),
    })
}

function SubagentSwitcherIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5.99951 12.7L8.95546 14.9478C9.40011 15.2859 9.62244 15.455 9.87526 15.488C9.95774 15.4988 10.0413 15.4988 10.1238 15.488C10.3766 15.455 10.5989 15.2859 11.0436 14.9478L13.9995 12.7"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M13.9995 7.7417L11.0436 5.49387C10.5989 5.15574 10.3766 4.98668 10.1238 4.95362C10.0413 4.94283 9.95775 4.94283 9.87527 4.95362C9.62245 4.98668 9.40012 5.15574 8.95547 5.49387L5.99952 7.7417"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  )
}

/** Render catalog loading without inventing child membership. */
function CatalogLoadingRows({ t }: { t: TranslateNS<typeof NS> }) {
  return <div className={css.notice}>{t('loading.label')}</div>
}

/** Only confirmed child membership exposes a branch disclosure. */
function canExpandCatalog(entry: SubagentCatalogSnapshot['entries'][number], catalogs: Catalogs, summaries: CatalogRowsProps['summaries']): boolean {
  return entry.mode !== 'external' && (catalogs[entry.id]?.entries.length ?? 0) > 0
    && summaries[entry.id]?.formatStatus !== 'migration-required'
    && catalogs[entry.id]?.state !== 'migration-required'
}

/** The agent name unique among the row's siblings, or the Session ID for entries recorded without one. */
function entryName(entry: SubagentCatalogSnapshot['entries'][number]): string {
  return entry.mode === 'continuable' || entry.mode === 'external' ? entry.name ?? entry.id : entry.id
}

/** Only a local child's last closed, normally completed turn receives the completed marker. */
function completedEntry(entry: SubagentCatalogSnapshot['entries'][number], summary: SessionSummary | undefined): boolean {
  return entry.mode !== 'external' && entry.activity === 'inactive'
    && summary?.projectionValues?.subagentTiming?.lastTurnCompleted === true
}

/** Count direct catalog members without treating external or other inactive entries as completed. */
function catalogProgress(entries: SubagentCatalogSnapshot['entries'], summaries: CatalogRowsProps['summaries'], t: TranslateNS<typeof NS>): string {
  let completed = 0
  let active = 0
  let inactive = 0
  let external = 0
  let failed = 0
  for (const entry of entries) {
    if (entry.mode === 'external') external++
    else if (entry.activity === 'running') active++
    else if (entry.failed) failed++
    else if (completedEntry(entry, summaries[entry.id])) completed++
    else inactive++
  }
  return [
    ...completed > 0 ? [t('progress.completed', { count: completed })] : [],
    ...active > 0 ? [t('progress.active', { count: active })] : [],
    ...failed > 0 ? [t('progress.failed', { count: failed })] : [],
    ...inactive > 0 ? [t('progress.inactive', { count: inactive })] : [],
    ...external > 0 ? [t('progress.external', { count: external })] : [],
  ].join('\u2002·\u2002')
}

/** Render one catalog level and recurse only through explicitly expanded rows. */
function CatalogRows({
  parentSessionId, currentSessionId, catalog, catalogs, summaries, expanded, level,
  openChild, openChildAside, refreshProjection, toggleBranch, closeCatalog, t,
}: CatalogRowsProps & { t: TranslateNS<typeof NS> }) {
  const [now, setNow] = useState(() => Date.now())
  const running = catalog.entries.some(entry => entry.activity === 'running')
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [running])
  const emptyLoading = catalog.state === 'loading' && catalog.entries.length === 0
  const reserveDisclosure = catalog.entries.some(entry => canExpandCatalog(entry, catalogs, summaries))
  return (
    <>
      {catalog.state === 'idle' && catalog.entries.length === 0 && (
        <div className={css.notice}>{t('load.idle')}</div>
      )}
      {emptyLoading && (
        <CatalogLoadingRows t={t} />
      )}
      {catalog.state === 'error' && (
        <div className={css.error}>
          <span>{catalog.error?.message ?? t('load.error')}</span>
          <button
            type="button"
            className={css.refresh}
            onClick={() => { refreshProjection(parentSessionId) }}
          >
            <IconRefreshOutlineRegular size={14} />
            {t('retry')}
          </button>
        </div>
      )}
      {catalog.entries.map((entry) => {
        const external = entry.mode === 'external'
        const childCatalog = catalogs[entry.id]
        const isCurrent = entry.id === currentSessionId
        const requiresOpening = summaries[entry.id]?.formatStatus === 'migration-required'
          || childCatalog?.state === 'migration-required'
        const canExpand = canExpandCatalog(entry, catalogs, summaries)
        const isExpanded = canExpand && expanded.has(entry.id)
        const summary = summaries[entry.id]
        const description = entry.label || summary?.title
        const name = entryName(entry)
        const primaryLabel = description || name
        const secondaryLabel = description ? name : undefined
        const mode = external ? t('mode.external') : entry.mode === 'unknown' ? t('mode.unknown')
          : entry.mode === 'one-shot' ? t('mode.oneShot') : t('mode.continuable')
        const completed = completedEntry(entry, summary)
        const activity = external ? undefined : entry.activity === 'running'
          ? t('activity.running')
          : entry.failed ? t('activity.failed') : completed
            ? t('activity.completed')
            : t('activity.inactive')
        const secondary = [secondaryLabel, mode, activity]
          .filter(value => value !== undefined)
          .join(' · ')
        const totalTokens = tokenTotal(summary?.projectionValues?.tokenUsage)
        const durationMs = activityDuration(
          summary,
          entry.activity,
          now,
        )
        const tokenMetric = totalTokens === undefined
          ? undefined
          : t('tokens.total', { value: formatTokens(totalTokens, t) })
        const durationMetric = durationMs === undefined
          ? undefined
          : {
            compact: formatDuration(durationMs, t),
            exact: formatExactDuration(durationMs, t),
          }
        const metrics = [tokenMetric, durationMetric?.exact]
          .filter(value => value !== undefined)
          .join(' · ')

        const open = (): void => {
          if (external) return
          openChild({
            parentSessionId,
            childSessionId: entry.id,
            mode: entry.mode,
          })
          closeCatalog()
        }
        const handleKey = (event: KeyboardEvent<HTMLDivElement>): void => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            open()
          } else if (
            (event.key === 'ArrowRight' && canExpand && !isExpanded)
            || (event.key === 'ArrowLeft' && isExpanded)
          ) {
            event.preventDefault()
            event.stopPropagation()
            toggleBranch(entry.id)
          }
        }
        const toggle = (event: MouseEvent<HTMLButtonElement>): void => {
          event.preventDefault()
          event.stopPropagation()
          toggleBranch(entry.id)
        }

        return (
          <div key={entry.id} className={css.node}>
            <div
              role="treeitem"
              tabIndex={external ? -1 : 0}
              aria-disabled={external || undefined}
              aria-level={level}
              aria-current={isCurrent || undefined}
              aria-label={[primaryLabel, secondary, metrics].filter(value => value !== '').join(' ')}
              {...canExpand ? { 'aria-expanded': isExpanded } : {}}
              className={css.row}
              onClick={open}
              onKeyDown={handleKey}
            >
              {!canExpand
                ? reserveDisclosure && <span className={css.disclosureSpace} />
                : (
                  <button
                    type="button"
                    tabIndex={-1}
                    className={`${css.disclosure} ${isExpanded ? css.disclosureOpen : ''}`}
                    aria-label={t(isExpanded ? 'branch.collapse' : 'branch.expand', { label: primaryLabel })}
                    onClick={toggle}
                  >
                    <IconChevronRightOutlineRegular />
                  </button>
                )}
              <div className={css.clickarea}>
                <span className={css.rowActivitySlot}>
                  <StateDot state={entry.activity === 'running' ? 'ongoing' : completed ? 'done' : 'idle'} />
                </span>
                <span className={css.content}>
                  <span className={`${css.label} ${isCurrent ? css.currentLabel : ''}`}>{primaryLabel}</span>
                  {secondaryLabel !== undefined && (
                    <span className={css.secondaryLabel}>{secondaryLabel}</span>
                  )}
                </span>
                <StatusPill status={agentStatus(entry, summary)} t={t} />
                {metrics !== '' && (
                  <span className={css.metrics}>
                    {tokenMetric !== undefined && <span className={css.metricToken}>{tokenMetric}</span>}
                    {durationMetric !== undefined && (
                      <span
                        className={css.metricDuration}
                        title={t('duration.exactTitle', { duration: durationMetric.exact })}
                      >
                        {durationMetric.compact}
                      </span>
                    )}
                  </span>
                )}
                {isCurrent
                  ? (
                    <span className={`${css.sidebarSpace} ${css.currentCheck}`} aria-hidden data-subagent-current>
                      <IconCheckOutlineRegular size={16} />
                    </span>
                  )
                  : external ? <span className={css.sidebarSpace} /> : (
                    <Tooltip label={t('open.sidebar')} delayMs={500} side="bottom" align="end">
                      <button
                        type="button"
                        className={css.sidebarButton}
                        aria-label={t('open.sidebar.aria', { label: primaryLabel })}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          openChildAside({ parentSessionId, childSessionId: entry.id, mode: entry.mode })
                          closeCatalog()
                        }}
                        onKeyDown={(event) => { event.stopPropagation() }}
                      >
                        <IconChevronRightOutlineRegular />
                      </button>
                    </Tooltip>
                  )}
              </div>
            </div>
            {!isExpanded && !external && !requiresOpening && childCatalog?.state === 'error' && (
              <div className={css.error} role="alert">
                <span>{t('load.error')}</span>
                <button type="button" className={css.refresh} onClick={() => { refreshProjection(entry.id) }}>
                  <IconRefreshOutlineRegular size={14} />
                  {t('retry')}
                </button>
              </div>
            )}
            {childCatalog !== undefined && isExpanded && (
              <div
                role="group"
                className={css.children}
              >
                <CatalogRows
                  parentSessionId={entry.id}
                  currentSessionId={currentSessionId}
                  catalog={childCatalog}
                  catalogs={catalogs}
                  summaries={summaries}
                  expanded={expanded}
                  level={level + 1}
                  openChild={openChild}
                  openChildAside={openChildAside}
                  refreshProjection={refreshProjection}
                  toggleBranch={toggleBranch}
                  closeCatalog={closeCatalog}
                  t={t}
                />
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

interface CatalogDropdownSharedProps extends InjectFace<SubagentCatalogInjected> {
  /** Session whose direct catalog roots the tree. */
  rootSessionId: SessionId
  useSessions: SubagentHeaderLineageProps['useSessions']
  useSessionStatus: SubagentHeaderLineageProps['useSessionStatus']
  t: TranslateNS<typeof NS>
  /** Section labels are useful only beside a visible shared-task list. */
  hasSharedTasks?: boolean
  /** Retain an empty catalog's entry for shared tasks or a task-board error. */
  hasBoardContent?: boolean
  renderFooter?: () => ReactNode
}

type CatalogDropdownProps = CatalogDropdownSharedProps & (
  | {
    /** Descendant-count control. */
    variant: 'count'
    currentSessionId?: never
    displayTitle?: never
    openTitle?: never
  }
  | {
    /** Current-title sibling switcher. */
    variant: 'switcher'
    /** Selected descendant highlighted in the catalog. */
    currentSessionId: SessionId
    /** Visible title included in the switcher's hover target. */
    displayTitle: string
    /** Optional ancestor navigation when the combined title is clicked. */
    openTitle?: () => void
  }
)

function agentStatus(entry: SubagentCatalogSnapshot['entries'][number], summary: SessionSummary | undefined) {
  if (entry.mode === 'external') return 'external'
  if (entry.activity === 'running') return 'running'
  if (entry.failed) return 'failed'
  return completedEntry(entry, summary) ? 'completed' : 'inactive'
}

function StatusPill({ status, t }: { status: ReturnType<typeof agentStatus>; t: TranslateNS<typeof NS> }) {
  const symbols = { running: '◷', completed: '✓', failed: '!', inactive: 'Ⅱ', external: '↗' }
  return <small data-status={status}><span aria-hidden="true">{symbols[status]} </span>
    {t(status === 'external' ? 'mode.external' : `activity.${status}`)}
  </small>
}

function AgentControls({ address, status, perform }: {
  address: SubagentAddress
  status: ReturnType<typeof agentStatus>
  perform: NonNullable<SubagentCatalogInjected['agentAction']>
}) {
  const [instruction, setInstruction] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [failedRead, setFailedRead] = useState<'instruction' | 'result' | undefined>()
  const run = async (action: 'stop' | 'retry' | 'instruction' | 'result') => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setMessage('')
    let reading = true
    try {
      const text = await perform(address, action)
      reading = false
      setFailedRead(undefined)
      if (action === 'instruction') setInstruction(text)
      if (action === 'result') { await navigator.clipboard.writeText(text); setMessage('Résultat copié') }
      if (action === 'stop') setMessage('Arrêt demandé')
      if (action === 'retry') setMessage('Relance demandée')
    } catch (error) {
      if (reading && (action === 'result' || action === 'instruction')) setFailedRead(action)
      setMessage(error instanceof Error ? error.message : String(error))
    } finally { lock.current = false; setBusy(false) }
  }
  return <div className={css.agentControls}>
    <details onToggle={(event) => { if (event.currentTarget.open && !instruction) void run('instruction') }}>
      <summary>Consigne du parent</summary><p>{instruction}</p>
    </details>
    {status === 'running' && <button disabled={busy} title="Arrêter" onClick={() => void run('stop')}><span aria-hidden="true">■</span><span className={css.actionLabel}>Arrêter</span></button>}
    {status === 'completed' && <button disabled={busy} title="Copier le résultat" onClick={() => void run('result')}><span aria-hidden="true">⧉</span><span className={css.actionLabel}>Copier le résultat</span></button>}
    {(status === 'completed' || status === 'failed' || status === 'inactive') && address.mode === 'continuable' &&
      <button disabled={busy} title="Relancer" onClick={() => void run('retry')}><span aria-hidden="true">↻</span><span className={css.actionLabel}>Relancer</span></button>}
    {failedRead && <button disabled={busy} onClick={() => void run(failedRead)}>Relancer la récupération</button>}
    <small role="status">{message}</small>
  </div>
}

/** Edit the parent's durable display label without changing the agent's routing identity. */
function AgentName({ address, title, rename, t }: {
  address: SubagentAddress
  title: string
  rename: NonNullable<SubagentCatalogInjected['renameAgent']>
  t: TranslateNS<typeof NS>
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const inputId = useId()
  async function save() {
    if (pending.current || !draft.trim()) return
    pending.current = true
    setBusy(true)
    setError('')
    try { await rename(address, draft.trim()); setEditing(false) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { pending.current = false; setBusy(false) }
  }
  return <div className={css.agentControls}>
    {editing ? <form className={css.agentNameForm} onSubmit={(event) => { event.preventDefault(); void save() }}>
      <label htmlFor={inputId}>{t('rename.label')}</label>
      <input id={inputId} autoFocus maxLength={200} value={draft} disabled={busy}
        onChange={(event) => { setDraft(event.currentTarget.value) }} />
      <button type="submit" disabled={busy || !draft.trim()}>{t('rename.save')}</button>
      <button type="button" disabled={busy} onClick={() => { setEditing(false) }}>{t('rename.cancel')}</button>
      {error && <small role="alert">{error}</small>}
    </form> : <button type="button" onClick={() => { setDraft(title); setError(''); setEditing(true) }}>{t('rename.action')}</button>}
  </div>
}

function AgentSidebar({
  entries, summaries, catalogs, refreshProjection, progress, parentId, openChildAside, agentAction, archive, updateArchive, renameAgent, t,
}: {
  archive: SessionProjectionMap['subagentArchive'] | undefined
  updateArchive: SubagentCatalogInjected['updateArchive']
  renameAgent: SubagentCatalogInjected['renameAgent']
  agentAction: SubagentCatalogInjected['agentAction']
  entries: SubagentCatalogSnapshot['entries']
  summaries: CatalogRowsProps['summaries']
  catalogs: Catalogs
  refreshProjection: SubagentCatalogInjected['refreshProjection']
  progress: string
  parentId: SessionId
  openChildAside: SubagentCatalogInjected['openChildAside']
  t: TranslateNS<typeof NS>
}) {
  const [now, setNow] = useState(Date.now)
  const [saving, setSaving] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  async function saveArchive(change: SubagentArchiveUpdate) {
    if (!updateArchive || saving) return
    setSaving(true)
    setArchiveError('')
    try { await updateArchive(change) }
    catch (error) { setArchiveError(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }
  const running = entries.some(entry => entry.mode !== 'external' && entry.activity === 'running')
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [running])
  const rows = entries.map((entry) => {
    const summary = summaries[entry.id]
    const status = agentStatus(entry, summary)
    return { entry, status, tokens: tokenTotal(summary?.projectionValues?.tokenUsage),
      duration: activityDuration(summary, entry.activity, now) } as const
  })
  const rank = { running: 0, failed: 1, completed: 2, inactive: 3, external: 4 }
  rows.sort((a, b) => rank[a.status] - rank[b.status])
  const measured = rows.flatMap(row => row.tokens === undefined ? [] : [row.tokens])
  const total = measured.reduce((sum, count) => sum + count, 0)
  const percent = new Intl.NumberFormat(document.documentElement.lang || undefined, { style: 'percent', maximumSignificantDigits: 3 })
  const archivedIds = new Set(archive?.archived)
  const archived = rows.filter(({ entry, status }) => status === 'completed' && archivedIds.has(entry.id))
  const visible = rows.filter(({ entry, status }) => status !== 'completed' || !archivedIds.has(entry.id))
  const renderRow = ({ entry, status, tokens, duration }: typeof rows[number], isArchived: boolean) => {
    const name = entryName(entry)
    const label = archive?.names?.[entry.id] || entry.label
    const title = label && label !== name ? `${name} · ${label}` : name
    const readError = entry.mode !== 'external' && catalogs[entry.id]?.state === 'error'
    const mode = entry.mode === 'one-shot' ? t('mode.oneShot') : entry.mode === 'continuable' ? t('mode.continuable') : t(entry.mode === 'external' ? 'mode.external' : 'mode.unknown')
    const share = tokens !== undefined && total > 0 ? percent.format(tokens / total) : undefined
    return <div key={entry.id} role="group" aria-label={title} data-agent-id={entry.id} data-outcome={status}>
      <button type="button" disabled={entry.mode === 'external'}
        title={entry.mode === 'external' ? title : t('open.sidebar.aria', { label: title })}
        onClick={() => { if (entry.mode !== 'external') openChildAside({ parentSessionId: parentId, childSessionId: entry.id, mode: entry.mode }) }}>
        <b>{title}</b>
        <StatusPill status={status} t={t} />
        <small>{[mode, duration === undefined ? undefined : formatDuration(duration, t)].filter(Boolean).join(' · ')}</small>
        <small>{t('tokens.total', { value: tokens === undefined ? '—' : formatTokens(tokens, t) })}
          {share !== undefined && <> · {share}</>}</small>
        {tokens !== undefined && total > 0 && <progress aria-hidden="true" value={tokens} max={total} />}
      </button>
      {isArchived
        ? <div className={css.agentControls}><button disabled={saving} onClick={() => void saveArchive({ action: 'restore', childId: entry.id })}>{t('archive.restore')}</button></div>
        : agentAction && entry.mode !== 'external' && <AgentControls address={{ parentSessionId: parentId, childSessionId: entry.id, mode: entry.mode }}
          status={status} perform={agentAction} />}
      {renameAgent && entry.mode !== 'external' && <AgentName
        address={{ parentSessionId: parentId, childSessionId: entry.id, mode: entry.mode }}
        title={label || name} rename={renameAgent} t={t} />}
      {readError && <details className={css.sidebarError}><summary>{t('load.error')}</summary>
        <p>{catalogs[entry.id]?.error?.message}</p>
        <button type="button" onClick={() => { refreshProjection(entry.id) }}>{t('retry')}</button>
      </details>}</div>
  }
  return <section className={css.agentSidebar} aria-label={t('section.title')}>
    <header><strong>{t(rows.length === 1 ? 'count.total.one' : 'count.total.other', { count: rows.length })}</strong><small aria-live="polite">{progress}</small></header>
    {visible.map(row => renderRow(row, false))}
    {updateArchive && <div className={css.archiveToolbar}>
      <button type="button" disabled={saving || !visible.some(row => row.status === 'completed')}
        onClick={() => void saveArchive({ action: 'archiveCompleted' })}>{t('archive.completed')}</button>
      <label><input type="checkbox" checked={archive?.auto ?? false} disabled={saving}
        onChange={event => void saveArchive({ action: 'setAuto', enabled: event.currentTarget.checked })} /> {t('archive.auto')}</label>
      {archiveError && <small role="alert">{archiveError}</small>}
    </div>}
    {archived.length > 0 && <details className={css.archivedRows}><summary>{t('archive.list', { count: archived.length })}</summary>
      {archived.map(row => renderRow(row, true))}
    </details>}
    {measured.length > 0 && <footer>{t('sidebar.usage', { value: t('tokens.total', { value: formatTokens(total, t) }) })}</footer>}
  </section>
}

function CatalogDropdown(props: CatalogDropdownProps) {
  const {
    rootSessionId, currentSessionId, displayTitle, openTitle, variant,
    useSessions, useSessionStatus, openChild, openChildAside, prepareCatalog, t, hasSharedTasks = false,
  } = props
  const ancestorSwitcher = variant === 'switcher' && openTitle !== undefined
  const sidebar = useSyncExternalStore(subscribeSidebar, () => document.getElementById(`session-agents-sidebar-${rootSessionId}`), () => null)
  const projections = useSessions(state => state.projectionsBySession)
  const summaries = useSessions(state => state.byId)
  const statuses = useSessionStatus(value => value)
  const catalogs = useMemo<Catalogs>(() => {
    return Object.fromEntries(Object.entries(projections).map(([id, snapshot]) => {
      const projected = snapshot.values.subagentCatalog
      const state = snapshot.state === 'idle'
        ? projected === undefined ? 'idle' : 'ready'
        : snapshot.state === 'migration-required' && projected !== undefined ? 'ready' : snapshot.state
      return [id, {
        state,
        error: snapshot.error,
        entries: (projected ?? []).map(entry => ({
          ...entry,
          failed: statuses.get(entry.id)?.completionFailed === true,
          activity: (statuses.get(entry.id)?.running ?? summaries[entry.id]?.running) === true
            ? 'running' as const : 'inactive' as const,
        })),
      } satisfies SubagentCatalogSnapshot]
    }))
  }, [projections, summaries, statuses])
  const catalog = catalogs[rootSessionId]
  const prepareLevel = (sessionId: SessionId): void => {
    void prepareCatalog(sessionId).catch((error: unknown) => {
      console.error('[ui-subagent] catalog discovery failed:', error)
    })
  }
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<SessionId>>(() => new Set())
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const countRef = useRef<HTMLSpanElement>(null)
  const activityId = useId()
  const menuRef = useRef<HTMLDivElement>(null)
  const anchorName = `--dsh-subagents-${activityId.replaceAll(':', '')}`
  const hoverOpenTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hoverCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // A click-opened (pinned) menu ignores hover-out; only explicit dismissal closes it.
  const pinnedRef = useRef(false)
  const currentEntry = currentSessionId === undefined
    ? undefined
    : catalog?.entries.find(entry => entry.id === currentSessionId)
  const switcherDisplayTitle = currentEntry !== undefined
    ? currentEntry.label || entryName(currentEntry)
    : displayTitle
  const directChildren = catalog?.entries ?? []
  const directCount = directChildren.length
  const runningCount = directChildren.filter(entry => entry.activity === 'running').length
  const progress = catalogProgress(directChildren, summaries, t)
  const totalCountKey = directCount === 1 ? 'count.total.one' : 'count.total.other'
  const runningCountKey = runningCount === 1 ? 'count.running.one' : 'count.running.other'
  const presentedCatalog: SubagentCatalogSnapshot | undefined = catalog ?? (variant === 'switcher' || props.hasBoardContent
    ? { entries: [], state: 'idle', error: null }
    : undefined)

  const cancelHoverClose = (): void => {
    if (hoverCloseTimer.current === undefined) return
    clearTimeout(hoverCloseTimer.current)
    hoverCloseTimer.current = undefined
  }

  const cancelHoverOpen = (): void => {
    if (hoverOpenTimer.current === undefined) return
    clearTimeout(hoverOpenTimer.current)
    hoverOpenTimer.current = undefined
  }

  const changeOpen = (next: boolean, restoreFocus = false): void => {
    cancelHoverOpen()
    cancelHoverClose()
    if (next) {
      const trigger = triggerRef.current
      /* v8 ignore next -- a queued callback can outlive the trigger */
      if (trigger === null) return
      setOpen(true)
    }
    else {
      pinnedRef.current = false
      setOpen(false)
      setExpanded(new Set())
    }
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  // CSS owns the header-width breakpoint; interaction reads its result only when scheduling hover.
  const allowsHoverOpen = (): boolean => variant === 'switcher'
    || (countRef.current !== null && getComputedStyle(countRef.current).display !== 'none')

  const scheduleHoverOpen = (): void => {
    cancelHoverOpen()
    cancelHoverClose()
    if (open || !allowsHoverOpen()) return
    hoverOpenTimer.current = setTimeout(() => {
      hoverOpenTimer.current = undefined
      if (allowsHoverOpen()) changeOpen(true)
    }, 150)
  }

  const scheduleHoverClose = (): void => {
    cancelHoverOpen()
    cancelHoverClose()
    if (pinnedRef.current) return
    hoverCloseTimer.current = setTimeout(() => {
      hoverCloseTimer.current = undefined
      changeOpen(false)
    }, 120)
  }

  const closeBranch = (root: SessionId): void => {
    const closing = new Set<SessionId>()
    const visit = (parentSessionId: SessionId): void => {
      if (closing.has(parentSessionId) || !expanded.has(parentSessionId)) return
      closing.add(parentSessionId)
      const branch = catalogs[parentSessionId]
      for (const entry of branch?.entries ?? []) {
        visit(entry.id)
      }
    }
    visit(root)
    setExpanded(current => new Set([...current].filter(id => !closing.has(id))))
  }

  const toggleBranch = (childSessionId: SessionId): void => {
    if (expanded.has(childSessionId)) {
      closeBranch(childSessionId)
      return
    }
    setExpanded(current => new Set(current).add(childSessionId))
    prepareLevel(childSessionId)
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node
        && !rootRef.current?.contains(event.target)
        && !menuRef.current?.contains(event.target)
      ) {
        changeOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    const dismiss = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      changeOpen(false, menuRef.current?.contains(document.activeElement) === true)
    }
    document.addEventListener('keydown', dismiss)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', dismiss)
    }
  }, [open])

  useEffect(() => () => {
    cancelHoverOpen()
    cancelHoverClose()
  }, [])

  const visible = presentedCatalog !== undefined
    && (variant === 'switcher'
      || props.hasBoardContent || presentedCatalog.state === 'error'
      || presentedCatalog.entries.length > 0)
  useEffect(() => {
    if (visible) return
    cancelHoverOpen()
    cancelHoverClose()
    if (!open) return
    pinnedRef.current = false
    setOpen(false)
    setExpanded(new Set())
  }, [visible, open])

  if (!visible) return null

  const focusAt = (index: number): void => {
    const items = treeItems(menuRef.current)
    if (items.length === 0) return
    items[(index + items.length) % items.length]?.focus()
  }

  const navigate = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof Element
      && event.target !== triggerRef.current && event.target !== menuRef.current
      && event.target.closest('[role="tree"]') === null) return
    const items = treeItems(menuRef.current)
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Home') {
      event.preventDefault()
      focusAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusAt(items.length - 1)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusAt(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusAt(index < 0 ? items.length - 1 : index - 1)
    }
  }

  return (
    <div
      className={`${css.root} ${variant === 'switcher' ? css.switcherRoot : ''}`}
      ref={rootRef}
      data-subagent-action
      onKeyDown={navigate}
      onPointerLeave={scheduleHoverClose}
    >
      {sidebar && variant === 'count' && directCount > 0 && createPortal(
        <AgentSidebar key={rootSessionId} agentAction={props.agentAction} entries={directChildren} summaries={summaries}
          catalogs={catalogs} refreshProjection={props.refreshProjection} progress={progress}
          archive={projections[rootSessionId]?.values.subagentArchive} updateArchive={props.updateArchive}
          parentId={rootSessionId} openChildAside={openChildAside} renameAgent={props.renameAgent} t={t} />, sidebar)}
      <Tooltip
        label={t(totalCountKey, { count: directCount })}
        disabled={open || variant === 'switcher'}
        delayMs={500} portal side="bottom"
      >
        <button
          ref={triggerRef}
          style={{ anchorName }}
          onPointerEnter={(event) => {
            if (event.pointerType !== 'touch') scheduleHoverOpen()
          }}
          type="button"
          className={variant === 'switcher'
            ? `${css.switcherTrigger} ${ancestorSwitcher ? css.ancestorSwitcherTrigger : ''}`
            : css.trigger}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={variant === 'switcher'
            ? t('switcher.aria', { title: switcherDisplayTitle })
            : t(totalCountKey, { count: directCount })}
          aria-describedby={variant === 'count' && runningCount > 0 ? activityId : undefined}
          onClick={openTitle === undefined
            ? () => {
              cancelHoverOpen()
              cancelHoverClose()
              if (variant === 'count' && open && (pinnedRef.current || !allowsHoverOpen())) {
                changeOpen(false, true)
                return
              }
              pinnedRef.current = true
              if (!open) changeOpen(true)
              prepareLevel(rootSessionId)
              queueMicrotask(() => { menuRef.current?.focus() })
            }
            : () => {
              cancelHoverOpen()
              if (open) changeOpen(false)
              openTitle()
            }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown') return
            event.preventDefault()
            if (variant === 'count' && !allowsHoverOpen()) pinnedRef.current = true
            if (!open) changeOpen(true)
            prepareLevel(rootSessionId)
            queueMicrotask(() => { focusAt(0) })
          }}
        >
          {variant === 'switcher'
            ? <span className={css.switcherTitle}>{switcherDisplayTitle}</span>
            : (
              <>
                <span className={css.activitySlot} aria-hidden>
                  <IconUsersOutlineRegular size={14} className={runningCount > 0 ? css.compactIcon : undefined} />
                  {runningCount > 0 && <StateDot state="ongoing" className={css.textModeActivity} />}
                </span>
                <span ref={countRef} className={css.count} data-subagent-count>{t(totalCountKey, { count: directCount })}</span>
              </>
            )}
          {variant === 'switcher' && <SubagentSwitcherIcon />}
        </button>
      </Tooltip>
      {variant === 'count' && runningCount > 0 && (
        <span id={activityId} hidden>{t(runningCountKey, { count: runningCount })}</span>
      )}
      {open && createPortal((
        <MenuSurface
          ref={menuRef}
          className={variant === 'count' && props.agentAction && directCount ? `${css.menu} ${css.managementMenu}` : css.menu}
          style={{ positionAnchor: anchorName }}
          role="dialog"
          tabIndex={-1}
          aria-label={t('tree.aria')}
          data-subagent-panel
          onPointerEnter={(event) => {
            if (event.pointerType !== 'touch') cancelHoverClose()
          }}
          onPointerLeave={scheduleHoverClose}
        >
          <div className={css.menuBody}>
            {variant === 'count' && props.agentAction && directCount > 0 ? (
              <AgentSidebar key={rootSessionId} entries={directChildren} summaries={summaries} catalogs={catalogs}
                refreshProjection={props.refreshProjection} progress={progress} parentId={rootSessionId}
                archive={projections[rootSessionId]?.values.subagentArchive} updateArchive={props.updateArchive}
                agentAction={props.agentAction} renameAgent={props.renameAgent} t={t}
                openChildAside={(address) => { openChildAside(address); changeOpen(false) }} />
            ) : <>
              {hasSharedTasks && (
                <div className={css.sectionHeader} data-subagent-section-header>
                  <span className={css.sectionIcon} aria-hidden><IconUsersOutlineRegular size={14} /></span>
                  <h3 className={css.sectionTitle}>{t('section.title')}</h3>
                  {progress && <span className={css.sectionProgress}>{progress}</span>}
                </div>
              )}
              {hasSharedTasks && presentedCatalog.state === 'ready' && directCount === 0 && (
                <p className={css.sectionEmpty}>{t('section.empty')}</p>
              )}
              <div role="tree" aria-label={t('tree.aria')}>
                <CatalogRows
                  parentSessionId={rootSessionId}
                  currentSessionId={currentSessionId}
                  catalog={presentedCatalog}
                  catalogs={catalogs}
                  summaries={summaries}
                  expanded={expanded}
                  level={1}
                  openChild={openChild}
                  openChildAside={openChildAside}
                  refreshProjection={prepareLevel}
                  toggleBranch={toggleBranch}
                  closeCatalog={() => { changeOpen(false) }}
                  t={t}
                />
              </div>
            </>}
            {props.renderFooter?.()}
          </div>
        </MenuSurface>
      ), document.body)}
    </div>
  )
}

/** Full props for the root-session catalog entry in the header actions band. */
export type SubagentCatalogActionProps =
  PropsRuntime<'conversation.session.header.actions'> & InjectFace<SubagentCatalogActionInjected> & PropsLocale<typeof NS>
  & Omit<PropsRenderSlots<'conversation.session.header.actions.subagent.footer'>, 'SessionProvider'>

/**
 * Session-header catalog action for root sessions: the descendant count and
 * its dropdown after the preset label in the header actions band. Child sessions render nothing
 * here — their breadcrumb switcher in the lineage slot owns the same
 * navigation.
 * @param props - Session standard props plus the catalog actions and translator.
 * @returns The count dropdown, or null on a child session.
 */
export function SubagentCatalogAction(props: SubagentCatalogActionProps) {
  const addressedChild = props.useSession(snapshot => snapshot.subagent !== null)
  const listedChild = props.useSessions(state => state.byId[props.sessionId]?.origin === 'subagent')
  if (addressedChild || listedChild) return null
  return <RootCatalogAction {...props} />
}

/** Bind task-board visibility only in root conversations. */
function RootCatalogAction({
  sessionId, useProjection, useSessions, useSessionStatus, useFooterAvailable,
  openChild, openChildAside, refreshProjection, prepareCatalog, agentAction, updateArchive, renameAgent, openAgents, t, renderSlot,
}: SubagentCatalogActionProps) {
  const hasSharedTasks = useProjection('agentTeam', team => team?.enabled === true
    && team.tasks.some(task => task.status !== 'deleted'))
  const hasTaskFailure = useProjection('agentTeam', team => team?.enabled === true && team.failure !== undefined)
  const footerAvailable = useFooterAvailable(value => value)
  return (
    <CatalogDropdown
      key={sessionId}
      {...agentAction ? { agentAction } : {}}
      {...updateArchive ? { updateArchive } : {}}
      {...renameAgent ? { renameAgent } : {}}
      {...openAgents ? { openAgents } : {}}
      rootSessionId={sessionId}
      variant="count"
      hasSharedTasks={footerAvailable && hasSharedTasks}
      hasBoardContent={footerAvailable && (hasSharedTasks || hasTaskFailure)}
      renderFooter={() => renderSlot('conversation.session.header.actions.subagent.footer', {})}
      useSessions={useSessions}
      useSessionStatus={useSessionStatus}
      openChild={openChild}
      openChildAside={openChildAside}
      refreshProjection={refreshProjection}
      prepareCatalog={prepareCatalog}
      t={t}
    />
  )
}

/**
 * Render one breadcrumb title together with its subagent navigation.
 * @param props - Breadcrumb title, session standard props, and catalog actions.
 * @returns A title-and-chevron sibling switcher, or nothing on a root session.
 */
export function SubagentHeaderLineage({
  lineageSessionId, displayTitle, openTitle,
  useSessions, useSession, useSessionStatus, openChild, openChildAside, refreshProjection, prepareCatalog, t,
}: SubagentHeaderLineageProps) {
  const address = useSession(session => session.subagent?.address)
  const parentId = useSessions((state) => {
    if (address?.childSessionId === lineageSessionId) return address.parentSessionId
    for (const [parentId, snapshot] of Object.entries(state.projectionsBySession)) {
      if (snapshot.values.subagentCatalog?.some(entry => entry.id === lineageSessionId)) return parentId as SessionId
    }
    const summary = state.byId[lineageSessionId]
    return summary?.origin === 'subagent' ? summary.parentId : undefined
  })
  const shared = { useSessions, useSessionStatus, openChild, openChildAside, refreshProjection, prepareCatalog, t }
  // Root sessions carry no breadcrumb; their descendant count lives in the
  // header actions band (SubagentCatalogAction).
  if (parentId === undefined) return null
  return (
    <>
      <CatalogDropdown
        key={`switcher:${lineageSessionId}`}
        rootSessionId={parentId}
        currentSessionId={lineageSessionId}
        variant="switcher"
        displayTitle={displayTitle}
        {...openTitle === undefined ? {} : { openTitle }}
        {...shared}
      />
      {openTitle === undefined && (
        <CatalogDropdown
          key={`children:${lineageSessionId}`}
          rootSessionId={lineageSessionId}
          variant="count"
          {...shared}
        />
      )}
    </>
  )
}
