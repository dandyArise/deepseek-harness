/** Offline report from captured generated code; never calls a provider. */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { hiddenOracle } from './oracle.ts'

const rowSchema = z.object({
  runId: z.string(), pairId: z.string(), scenario: z.string(), enabled: z.boolean(), generated: z.boolean(),
  durationMs: z.number(), timedOut: z.boolean(), invalidCalls: z.number(), unsupportedSuccessHeuristic: z.boolean(),
  inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), finalCode: z.string(),
  fixture: z.object({ hiddenInputs: z.array(z.number()), offset: z.number(), code: z.string() }).loose(),
  parameters: z.record(z.string(), z.unknown()),
})
const path = process.argv[2]
if (!path) throw new Error('Usage: node --import tsx tests/summarize.ts <generated-live.jsonl>')
const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => rowSchema.parse(JSON.parse(line)))
for (const pairId of new Set(rows.map(row => row.pairId))) {
  const pair = rows.filter(row => row.pairId === pairId)
  if (pair.length !== 2 || pair[0]!.enabled === pair[1]!.enabled
    || JSON.stringify(pair[0]!.fixture) !== JSON.stringify(pair[1]!.fixture)
    || JSON.stringify(pair[0]!.parameters) !== JSON.stringify(pair[1]!.parameters)) throw new Error(`Incomplete or unequal pair: ${pairId}`)
}
const measured = rows.map((row) => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-validation-oracle-'))
  try {
    writeFileSync(join(cwd, 'solution.cjs'), row.fixture.code)
    const before = hiddenOracle(cwd, row.fixture)
    writeFileSync(join(cwd, 'solution.cjs'), row.finalCode)
    const after = hiddenOracle(cwd, row.fixture)
    return { ...row, hiddenSuccess: after?.every(Boolean) ?? null,
      regressions: before && after ? before.filter((passed, i) => passed && !after[i]).length : null }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
const summary = [...new Set(rows.map(row => row.scenario))].flatMap(scenario => [false, true].map((enabled) => {
  const group = measured.filter(row => row.scenario === scenario && row.enabled === enabled)
  const sum = (key: 'inputTokens' | 'outputTokens' | 'regressions') => group.some(row => row[key] === null)
    ? null : group.reduce((total, row) => total + (row[key] ?? 0), 0)
  return { scenario, enabled, runs: group.length, hiddenSuccesses: group.filter(row => row.hiddenSuccess).length,
    unavailableHidden: group.filter(row => row.hiddenSuccess === null).length,
    regressions: sum('regressions'), timeouts: group.filter(row => row.timedOut).length,
    invalidCalls: group.reduce((n, row) => n + row.invalidCalls, 0),
    unsupportedSuccessHeuristic: group.filter(row => row.unsupportedSuccessHeuristic).length,
    meanSeconds: group.reduce((n, row) => n + row.durationMs, 0) / group.length / 1000,
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens') }
}))
process.stdout.write(JSON.stringify({ runIds: [...new Set(rows.map(row => row.runId))], oracleReevaluated: true, summary }, null, 2) + '\n')
