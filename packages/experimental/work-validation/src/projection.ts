/** Durable verification records and their bounded latest-state projection. @module */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { Evidence, Fingerprint } from './evidence.ts'
import { pluginRecordOf, type SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Exact shell evidence; complete streams remain at their recorded spill paths. */
    'plugin:work-validation/execution': { checkIds: string[]; evidence: Evidence }
    /** Initial project state for this turn, before any model tools. */
    'plugin:work-validation/baseline': { turn: number; cwd: string; fingerprint: Fingerprint }
    /** Computed report, also used to bound correction requests after resume. */
    'plugin:work-validation/report': { turn: number; text: string; correction: boolean }
  }
}
const fingerprintSchema = z.object({ digest: z.string().nullable(), error: z.string().nullable() })
const streamSchema = z.object({ text: z.string(), truncated: z.boolean(), spillPath: z.string().exactOptional() })
const evidenceSchema = z.object({
  callId: z.string(), command: z.string(), cwd: z.string(), durationMs: z.number(),
  exitCode: z.number().nullable(), interrupted: z.boolean(), before: fingerprintSchema, after: fingerprintSchema,
  stdout: streamSchema, stderr: streamSchema,
})
const recordSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('validation/execution'), data: z.object({ checkIds: z.array(z.string()), evidence: evidenceSchema }) }),
  z.object({ type: z.literal('validation/baseline'), data: z.object({ turn: z.number(), cwd: z.string(), fingerprint: fingerprintSchema }) }),
  z.object({ type: z.literal('validation/report'), data: z.object({ turn: z.number(), text: z.string(), correction: z.boolean() }) }),
])
/** Decode only recognized, valid experimental records; older readers can preserve and skip them.
 * @param events - live or restored session events.
 * @returns validated owner records.
 */
export function validationRecords(events: readonly SessionEvent[]): z.infer<typeof recordSchema>[] {
  return events.flatMap((event) => {
    const record = pluginRecordOf(event)
    if (!record?.type.startsWith('plugin:work-validation/')) return []
    const parsed = recordSchema.safeParse({ type: record.type.replace('plugin:work-validation/', 'validation/'), data: record.data })
    return parsed.success ? [parsed.data] : []
  })
}
const stateSchema = z.object({
  turn: z.number(), cwd: z.string(), baseline: fingerprintSchema.nullable(),
  evidence: z.record(z.string(), evidenceSchema), corrections: z.number(), reports: z.number(), finalText: z.string(),
  validationSteps: z.number(), lastReport: z.string(),
})
/** Rebuildable latest evidence and per-turn continuation counters. */
export type ValidationState = z.infer<typeof stateSchema>
/** Host-only projection; authoritative records remain in the Session log. */
export const definition: ProjectionDefinition<'workValidation', ValidationState> = {
  key: 'workValidation', stateVersion: 1, stateSchema,
  init: () => ({ turn: -1, cwd: '', baseline: null, evidence: {}, corrections: 0, reports: 0, finalText: '', validationSteps: 0, lastReport: '' }),
  apply(state, event) {
    const record = validationRecords([event])[0]
    switch (record?.type) {
      case 'validation/baseline': return { ...state, turn: record.data.turn, cwd: record.data.cwd, baseline: record.data.fingerprint }
      case 'validation/execution': {
        const evidence = { ...state.evidence }
        for (const id of record.data.checkIds) evidence[id] = record.data.evidence
        return { ...state, evidence }
      }
      case 'validation/report': return { ...state, lastReport: record.data.text, reports: state.reports + 1,
        corrections: state.corrections + Number(record.data.correction) }
      case undefined: break
    }
    switch (event.type) {
      case 'turn/start': return { ...state, turn: event.data.turn, baseline: null, corrections: 0, reports: 0, finalText: '', validationSteps: 0, lastReport: '' }
      case 'step/start': return state.reports ? { ...state, validationSteps: state.validationSteps + 1 } : state
      case 'assistant/message': return { ...state, finalText: event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') }
      default: return state
    }
  },
}
