import { it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hiddenOracle } from './oracle.ts'

it('distinguishes working code, wrong exports and syntax errors from unavailable metrics', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-hidden-oracle-'))
  const fixture = { hiddenInputs: [0, -50, 100], offset: 17 }
  try {
    for (const [code, expected] of [
      ['module.exports=x=>x+17', [true, true, true]],
      ['module.exports={f:x=>x+17}', [false, false, false]],
      ['module.exports =', [false, false, false]],
      ['module.exports=x=>x===0?17:x-17', [true, false, false]],
    ] as const) {
      writeFileSync(join(cwd, 'solution.cjs'), code)
      expect(hiddenOracle(cwd, fixture)).toEqual(expected)
    }
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
