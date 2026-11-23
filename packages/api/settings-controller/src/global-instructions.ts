/** Fixed-path Markdown persistence for the authenticated settings API. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { GlobalInstructionsDocument } from './types.ts'

/** Owns serialized writes to the process-home instruction file. */
export class GlobalInstructionsFile {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly path: string
  constructor(private readonly home = resolveDshHome()) {
    this.path = join(home, 'AGENTS.md')
  }

  /**
   * Read an existing document, or return an empty draft without creating it.
   * @returns Markdown content, fixed path and revision for a subsequent save.
   */
  async read(): Promise<GlobalInstructionsDocument> {
    let content: string
    try {
      content = await readFile(this.path, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { path: this.path, content: '', revision: 'missing' }
      }
      throw new RemoteError('gateway/internal', 'Cannot read global AGENTS.md', {}, { cause: error })
    }
    return { path: this.path, content, revision: createHash('sha256').update(content).digest('hex') }
  }

  /**
   * Atomically replace Markdown after checking the revision; concurrent UI saves serialize.
   * @param content - replacement Markdown, limited to one MiB.
   * @param revision - previously read revision used to reject concurrent edits.
   * @returns the saved document and its new revision.
   */
  save(content: string, revision: string): Promise<GlobalInstructionsDocument> {
    const operation = this.queue.then(async () => {
      if (typeof content !== 'string' || typeof revision !== 'string' || Buffer.byteLength(content) > 1024 * 1024) {
        throw new RemoteError('gateway/bad-request', 'Invalid Markdown document (maximum 1 MiB)', {})
      }
      const current = await this.read()
      if (current.revision !== revision) {
        throw new RemoteError('gateway/bad-request', 'AGENTS.md changed since it was opened. Reload before saving.', {})
      }
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        await mkdir(this.home, { recursive: true })
        await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
        // Detect external edits made during preparation as well as stale UI drafts.
        if ((await this.read()).revision !== revision) {
          throw new Error('AGENTS.md changed during save; reload before saving')
        }
        await rename(temporary, this.path)
      } catch (error) {
        throw new RemoteError('gateway/internal', 'Cannot save global AGENTS.md; reload and retry', {}, { cause: error })
      } finally {
        await rm(temporary, { force: true })
      }
      return { path: this.path, content, revision: createHash('sha256').update(content).digest('hex') }
    })
    this.queue = operation.catch(() => undefined)
    return operation
  }
}
