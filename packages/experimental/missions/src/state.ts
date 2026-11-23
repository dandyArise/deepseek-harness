/** Validated mission records. Replay never starts a model or executes a tool. */
import { z } from 'zod'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

const positive = z.number().int().positive()
/** Deployment limits captured in the mission, independent of later configuration changes. */
export const limitsSchema = z.object({
  maxTasks: positive.max(100), maxSteps: positive.max(1000),
  taskSteps: positive.max(100), taskSeconds: positive.max(3600),
  maxOutputTokens: positive, maxResultChars: positive.max(100000),
})
/** Explicit model route and allowed tool names; an empty list permits no tools. */
export const roleSchema = z.object({
  name: z.string().min(1).max(64), provider: z.string().min(1), model: z.string().min(1),
  tools: z.array(z.string().min(1)).max(64),
})
/** A task id is an idempotency key within its owning root session. */
export const requestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  role: z.string().min(1).max(64), objective: z.string().min(1).max(16000),
  acceptance: z.array(z.string().min(1).max(2000)).min(1).max(20),
})
/** A completed execution does not imply independent verification. */
export const taskSchema = z.object({
  request: requestSchema, route: roleSchema, childId: z.string().min(1),
  status: z.enum(['running', 'done', 'failed', 'stopped', 'timed_out', 'interrupted', 'budget_exhausted']),
  delivery: z.enum(['pending', 'available', 'retrieved']),
  verification: z.literal('unverified'), steps: z.number().int().nonnegative(),
  startedAt: z.number(), endedAt: z.number().nullable(),
  output: z.string(), truncated: z.boolean(), reason: z.string().nullable(),
})
/** Entire latest mission state, bounded by maxTasks and maxResultChars. */
export const stateSchema = z.object({
  limits: limitsSchema.nullable(), tasks: z.array(taskSchema),
})
/** Persisted mission state. */
export type MissionState = z.infer<typeof stateSchema>
/** Persisted task outcome and independently tracked delivery. */
export type MissionTask = z.infer<typeof taskSchema>
/** Validated input from a model-facing tool. */
export type TaskRequest = z.infer<typeof requestSchema>
/** Validated role configuration. */
export type Role = z.infer<typeof roleSchema>
/** Validated mission limits. */
export type Limits = z.infer<typeof limitsSchema>

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Version-one bounded mission snapshot; replay has no side effects. */
    'plugin:missions/state': { version: 1; state: MissionState }
  }
}

/** Host-only mission projection, owned by the missions plugin. */
export const definition: ProjectionDefinition<'missions', MissionState> = {
  key: 'missions', stateVersion: 1, stateSchema,
  init: () => ({ limits: null, tasks: [] }),
  apply(state, event) {
    const record = pluginRecordOf(event)
    if (record?.type !== 'plugin:missions/state') return state
    // Corrupt or future records fail closed, never silently reset budgets.
    return z.object({ version: z.literal(1), state: stateSchema }).parse(record.data).state
  },
}
