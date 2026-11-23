import { execFileSync } from 'node:child_process'

const staged = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], { encoding: 'utf8' }).split('\0')
const sources = staged.filter(path => /^vendor\/[^/]+\/(src\/|bin\.js)/.test(path))
if (sources.length && !staged.includes('vendor/README.md')) {
  console.error('vendor manifest guard: vendored SOURCE changed without updating vendor/README.md:')
  for (const path of sources) console.error(`  ${path}`)
  console.error('Log the modification in vendor/README.md ("Local modifications") and stage it.')
  process.exitCode = 1
}
