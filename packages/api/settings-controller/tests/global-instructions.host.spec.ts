import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect, onTestFinished } from 'vitest'
import { GlobalInstructionsFile } from '../src/global-instructions.ts'

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-instructions-'))
  onTestFinished(() => rm(home, { recursive: true, force: true }))
  return { home, file: new GlobalInstructionsFile(home) }
}
it('creates only the fixed document and preserves Markdown exactly', async () => {
  const { home, file } = await fixture()
  const initial = await file.read()
  expect(initial).toEqual({ path: join(home, 'AGENTS.md'), content: '', revision: 'missing' })
  const saved = await file.save('# Vérifications\n\n- Exécuter les tests.\n', initial.revision)
  expect(await readFile(saved.path, 'utf8')).toBe(saved.content)
  expect(await file.read()).toEqual(saved)
  expect((await file.save('', saved.revision)).content).toBe('')
})
it('rejects concurrent and externally stale drafts', async () => {
  const { file } = await fixture()
  const initial = await file.read()
  const results = await Promise.allSettled([file.save('first', initial.revision), file.save('second', initial.revision)])
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  const saved = await file.read()
  await writeFile(saved.path, 'external')
  await expect(file.save('stale', saved.revision)).rejects.toThrow('changed')
  expect((await file.read()).content).toBe('external')
})
it('reports oversized input and filesystem failures', async () => {
  const { home, file } = await fixture()
  await expect(file.save('x'.repeat(1024 * 1024 + 1), 'missing')).rejects.toThrow('maximum')
  await mkdir(join(home, 'AGENTS.md'))
  await expect(file.read()).rejects.toThrow('Cannot read')
  await expect(file.save('new', 'missing')).rejects.toThrow('Cannot read')
})
