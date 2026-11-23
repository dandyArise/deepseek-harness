import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fingerprint, loadProject } from '../src/files.ts'
import { projectSchema } from '../src/evidence.ts'

const dirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'validation-files-'))
  dirs.push(cwd)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalFileSystem)
  return { cwd, fs: ctx.fs, signal: new AbortController().signal }
}
it('reuses package scripts but never invents a missing lint command', async () => {
  const { cwd, fs, signal } = await setup()
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', build: 'vite build' } }))
  writeFileSync(join(cwd, 'pnpm-lock.yaml'), '')
  const config = await loadProject(fs, cwd, signal)
  expect(config.checks.find(c => c.id === 'test')?.command).toBe('pnpm run test')
  expect(config.checks.find(c => c.id === 'lint')?.command).toBeNull()
})
it('detects creation, external modification, deletion and keeps generated directories excluded', async () => {
  const { cwd, fs, signal } = await setup()
  const config = projectSchema.parse({ checks: [] })
  const scan = () => fingerprint(fs, cwd, config, { maxFiles: 100, maxBytes: 10000 }, signal)
  const initial = await scan()
  writeFileSync(join(cwd, 'source.ts'), 'one')
  const created = await scan()
  expect(created.digest).not.toBe(initial.digest)
  writeFileSync(join(cwd, 'source.ts'), 'two')
  expect((await scan()).digest).not.toBe(created.digest)
  rmSync(join(cwd, 'source.ts'))
  expect((await scan()).digest).toBe(initial.digest)
  mkdirSync(join(cwd, 'dist'))
  writeFileSync(join(cwd, 'dist', 'generated.js'), 'output')
  expect((await scan()).digest).toBe(initial.digest)
})
it('reports an exceeded byte budget instead of a partial green fingerprint', async () => {
  const { cwd, fs, signal } = await setup()
  writeFileSync(join(cwd, 'large.txt'), '0123456789')
  const result = await fingerprint(fs, cwd, projectSchema.parse({ checks: [] }), { maxFiles: 2, maxBytes: 3 }, signal)
  expect(result.digest).toBeNull()
  expect(result.error).toBeTruthy()
})
