/** Project checks and evidence-derived verdicts. @module */
import { z } from 'zod'

/** Trusted project policy, including explicit missing commands and bounded check count. */
export const projectSchema = z.object({
  mode: z.enum(['development', 'inspection', 'auto']).default('auto'),
  checks: z.array(z.object({
    id: z.string().min(1),
    command: z.string().min(1).nullable(),
    cwd: z.string().default('.'),
    required: z.boolean().default(true),
  })).max(32),
  exclude: z.array(z.string()).default(['.git', 'node_modules', '.venv', '__pycache__', '.pytest_cache', 'dist', 'coverage', 'target']),
}).strict().refine(value => new Set(value.checks.map(check => check.id)).size === value.checks.length, 'Duplicate check id')

/** Validated check configuration for one project root. */
export type Project = z.infer<typeof projectSchema>
/** One named check whose success cannot establish another check. */
export type Check = Project['checks'][number]
/** Complete content digest or an explicit observation failure. */
export interface Fingerprint { digest: string | null; error: string | null }
/** Auditable foreground command result bound to observed file states. */
export interface Evidence {
  callId: string
  command: string
  cwd: string
  durationMs: number
  exitCode: number | null
  interrupted: boolean
  before: Fingerprint
  after: Fingerprint
  stdout: { text: string; truncated: boolean; spillPath?: string }
  stderr: { text: string; truncated: boolean; spillPath?: string }
}
/** Evidence-derived verification status; no execution is distinct from failure. */
export type Verdict = 'passed' | 'failed' | 'not-run' | 'stale'

/** Evaluate only the latest matching execution; a later failed run supersedes green.
 * @param evidence - latest matching execution, if any.
 * @param current - current complete project fingerprint.
 * @returns a conservative verdict, never green with incomplete observations.
 */
export function verdict(evidence: Evidence | undefined, current: Fingerprint): Verdict {
  if (!evidence) return 'not-run'
  if (!current.digest || !evidence.before.digest || evidence.before.digest !== evidence.after.digest
    || current.digest !== evidence.after.digest) return 'stale'
  return evidence.exitCode === 0 && !evidence.interrupted ? 'passed' : 'failed'
}

/** Detect common explicit success claims, not arbitrary semantic entailment.
 * @param text - final assistant prose.
 * @returns whether an explicit positive verification claim needs supporting evidence.
 */
export function claimsSuccess(text: string): boolean {
  const claims = ['all (tests|checks) pass', 'tests? passed', 'build succeeded', 'tout est (vert|validé)',
    'tests? (passent|réussis)', 'validation (réussie|terminée)', '(build|lint|typecheck) (passed|succeeded)', '\\d+ passed']
  return new RegExp(`\\b(${claims.join('|')})\\b`, 'iu').test(text)
}

/** Match common claims to their own control; a green test does not assert a green lint.
 * @param text - final prose.
 * @param rows - current evidence-derived statuses.
 * @returns whether a recognized success claim lacks its matching proof.
 */
export function unsupportedSuccess(text: string, rows: { id: string; required: boolean; status: Verdict }[]): boolean {
  const normalized = text.toLowerCase()
  const groups: [RegExp, string[] | null][] = [
    [/\b(all checks pass|tout est (vert|validé)|validation (réussie|terminée))\b/iu, null],
    [/\b(all tests pass|tests? passed|tests? (passent|réussis)|\d+ passed)\b/iu, ['test', 'tests']],
    [/\b(build succeeded|build passed|compilation réussie)\b/iu, ['build']],
    [/\b(lint passed|lint succeeded)\b/iu, ['lint']],
    [/\b(typecheck passed|typecheck succeeded)\b/iu, ['typecheck']],
  ]
  return groups.some(([pattern, ids]) => {
    if (!pattern.test(normalized)) return false
    const relevant = rows.filter(row => ids ? ids.includes(row.id) : row.required)
    return relevant.length === 0 || relevant.some(row => row.status !== 'passed')
  })
}
