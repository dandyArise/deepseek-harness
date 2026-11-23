/** Independent hidden oracle used by live comparisons and offline re-evaluation of captured code. */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

/** Evaluate the function contract, treating syntax errors, exceptions and timeouts as failures.
 * @param cwd - disposable directory containing solution.cjs.
 * @param fixture - host-only generated expectations.
 * @returns per-assertion outcomes; null only when the runtime cannot start or the result cannot be read.
 */
export function hiddenOracle(cwd: string, fixture: { hiddenInputs: number[]; offset: number }): boolean[] | null {
  const inputs = JSON.stringify(fixture.hiddenInputs)
  const script = `let f; try {f=require(process.argv[1])} catch {f=null};
    const r=${inputs}.map(x=>{try{return f(x)===x+${fixture.offset}}catch{return false}});
    process.stdout.write('\\nORACLE:'+JSON.stringify(r))`
  const result = spawnSync(process.execPath, ['-e', script, join(cwd, 'solution.cjs')], {
    cwd, timeout: 5000, encoding: 'utf8', windowsHide: true,
  })
  if (result.error && result.error.message.includes('ENOENT')) return null
  if (result.status !== 0) return fixture.hiddenInputs.map(() => false)
  try {
    const parsed: unknown = JSON.parse(result.stdout.split('\nORACLE:').at(-1) ?? '')
    return Array.isArray(parsed) && parsed.length === fixture.hiddenInputs.length && parsed.every(x => typeof x === 'boolean') ? parsed : null
  } catch { return null }
}
