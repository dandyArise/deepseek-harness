/** Bounded fingerprints through the configured filesystem execution world. @module */
import { createHash } from 'node:crypto'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { Fingerprint, Project } from './evidence.ts'
import { projectSchema } from './evidence.ts'

/** Load explicit project checks or reuse package scripts without inventing missing commands.
 * @param fs - execution-world filesystem.
 * @param cwd - project root.
 * @param signal - operation cancellation.
 * @returns validated configuration and its source.
 */
export async function loadProject(fs: FileSystem, cwd: string, signal: AbortSignal): Promise<Project> {
  const config = await fs.resolve('.harness-validation.json', { cwd, signal })
  if (await fs.stat(config, signal)) return projectSchema.parse(JSON.parse(await fs.readText(config, signal)))
  const target = await fs.resolve('package.json', { cwd, signal })
  let scripts: Record<string, unknown> = {}
  if (await fs.stat(target, signal)) {
    const value: unknown = JSON.parse(await fs.readText(target, signal))
    if (typeof value === 'object' && value !== null && 'scripts' in value
      && typeof value.scripts === 'object' && value.scripts !== null) scripts = value.scripts as Record<string, unknown>
  }
  let runner = 'npm'
  for (const [file, name] of [['pnpm-lock.yaml', 'pnpm'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['yarn.lock', 'yarn']]) {
    if (file && name && await fs.stat(await fs.resolve(file, { cwd, signal }), signal)) { runner = name; break }
  }
  return projectSchema.parse({ checks: ['test', 'typecheck', 'lint', 'build'].map(id => ({
    id, command: typeof scripts[id] === 'string' ? `${runner} run ${id}` : null,
  })) })
}

/** Hash contents and paths, including new/deleted files; reject incomplete or unstable scans.
 * @param fs - execution-world filesystem, preserving provider containment.
 * @param cwd - project root.
 * @param project - excluded generated directories.
 * @param limits - bounded I/O per scan.
 * @param signal - cancellation.
 * @returns digest or explicit inability to verify.
 */
export async function fingerprint(fs: FileSystem, cwd: string, project: Project,
  limits: { maxFiles: number; maxBytes: number }, signal: AbortSignal): Promise<Fingerprint> {
  try {
    const root = await fs.resolve(cwd, { signal })
    const hash = createHash('sha256')
    let files = 0
    let bytes = 0
    const seen = new Set<string>()
    async function visit(target: FsTarget, path: string): Promise<void> {
      signal.throwIfAborted()
      if (!fs.contains(root, target)) throw new Error(`Outside project: ${path}`)
      const key = fs.processPath(target)
      if (seen.has(key)) throw new Error(`Aliased or cyclic path: ${path}`)
      seen.add(key)
      const entries = await fs.listDir(target, signal)
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (project.exclude.includes(entry.name)) continue
        const relative = `${path}/${entry.name}`
        if (entry.type === 'directory') { await visit(entry.target, relative); continue }
        if (entry.type !== 'file') throw new Error(`Unsupported file: ${relative}`)
        if (++files > limits.maxFiles || !fs.contains(root, entry.target)) throw new Error('Fingerprint file limit or containment failure')
        const before = await fs.stat(entry.target, signal)
        const data = await fs.readBytes(entry.target, signal, limits.maxBytes - bytes)
        bytes += data.byteLength
        const after = await fs.stat(entry.target, signal)
        if (!before || !after || before.version !== after.version) throw new Error(`File changed during scan: ${relative}`)
        hash.update(JSON.stringify(relative)).update(createHash('sha256').update(data).digest())
      }
      const again = await fs.listDir(target, signal)
      if (JSON.stringify(entries.map(e => e.name).sort()) !== JSON.stringify(again.map(e => e.name).sort())) throw new Error('Directory changed during scan')
    }
    await visit(root, '')
    return { digest: hash.digest('hex'), error: null }
  } catch (error) {
    signal.throwIfAborted()
    return { digest: null, error: String(error) }
  }
}
