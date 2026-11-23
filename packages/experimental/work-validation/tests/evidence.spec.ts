import { describe, expect, it } from 'vitest'
import { claimsSuccess, unsupportedSuccess, projectSchema, verdict, type Evidence } from '../src/evidence.ts'

const current = { digest: 'revision-a', error: null }
function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return { callId: 'c1', command: 'npm test', cwd: '/project', durationMs: 10,
    exitCode: 0, interrupted: false, before: current, after: current,
    stdout: { text: '4 passed', truncated: false }, stderr: { text: '', truncated: false }, ...overrides }
}
describe('evidence verdicts', () => {
  it('requires a real matching execution', () =>{  expect(verdict(undefined, current)).toBe('not-run') })
  it('accepts an uninterrupted zero exit on unchanged files', () =>{  expect(verdict(evidence(), current)).toBe('passed') })
  it.each([1, 127, null])('reports failed execution %s', (exitCode) =>{  expect(verdict(evidence({ exitCode }), current)).toBe('failed') })
  it('does not accept zero from an interrupted command', () =>{  expect(verdict(evidence({ interrupted: true }), current)).toBe('failed') })
  it('invalidates after an external or shell change', () =>{  expect(verdict(evidence(), { digest: 'revision-b', error: null })).toBe('stale') })
  it('rejects changes during the test', () =>{  expect(verdict(evidence({ before: { digest: 'old', error: null } }), current)).toBe('stale') })
  it('never accepts an incomplete scan', () =>{  expect(verdict(evidence(), { digest: null, error: 'limit' })).toBe('stale') })
  it('keeps missing commands explicit', () =>{  expect(projectSchema.parse({ checks: [{ id: 'lint', command: null }] }).checks[0]?.command).toBeNull() })
  it('rejects duplicate identifiers', () =>{  expect(() => projectSchema.parse({ checks: [{ id: 'test', command: null }, { id: 'test', command: 'x' }] })).toThrow() })
  it('detects explicit positive claims without treating an honest limit as success', () => {
    expect(claimsSuccess('All tests pass')).toBe(true)
    expect(claimsSuccess('Tests non exécutés ; travail incomplet.')).toBe(false)
  })
  it('matches a success claim only to the corresponding check', () => {
    const rows = [{ id: 'test', required: true, status: 'passed' as const }, { id: 'lint', required: true, status: 'not-run' as const }]
    expect(unsupportedSuccess('Tests passed. Lint was not run.', rows)).toBe(false)
    expect(unsupportedSuccess('All checks pass', rows)).toBe(true)
    expect(unsupportedSuccess('Build succeeded', rows)).toBe(true)
  })
})
