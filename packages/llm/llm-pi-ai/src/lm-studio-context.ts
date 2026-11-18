import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

const execute = promisify(execFile)
const resizes = new Map<string, Promise<number | undefined>>()

export async function waitForLmStudioResize(baseURL: string, model: string): Promise<void> {
  await resizes.get(new URL(baseURL).origin + '/' + model)
}

/** A heuristic for preflight. The server's measured count takes precedence on a rejection. */
export function estimateLmStudioPrompt(options: GenerateOptions): number {
  let chars = options.system?.length ?? 0
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type === 'text') chars += block.text.length
      else if (block.type === 'tool-call') chars += block.arguments.length + block.name.length
    }
  }
  chars += JSON.stringify(options.tools ?? []).length
  return Math.ceil(chars / 4) + options.messages.length * 4
}

export function lmStudioOverflow(detail: string): { prompt: number; loaded: number } | undefined {
  if (!detail.includes('exceed_context_size_error')) return
  const fields = detail.replaceAll('\\"', '"')
  const prompt = Number(/"n_prompt_tokens"\s*:\s*(\d+)/.exec(fields)?.[1])
  const loaded = Number(/"n_ctx"\s*:\s*(\d+)/.exec(fields)?.[1])
  if (Number.isSafeInteger(prompt) && Number.isSafeInteger(loaded) && loaded > 0 && prompt > loaded) return { prompt, loaded }
}

interface Instance {
  type: string
  identifier: string
  modelKey: string
  selectedVariant?: string
  variants?: string[]
  contextLength: number
  status: string
  queued: number
  parallel: number
  ttlMs?: number
  engineConfigFileEnabled?: boolean
}

async function localCli(args: string[], timeout: number): Promise<string> {
  const binary = join(homedir(), '.lmstudio', 'bin', process.platform === 'win32' ? 'lms.exe' : 'lms')
  const { stdout } = await execute(binary, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  return stdout
}

/** Reload only the selected idle local LLM. Concurrent callers share a reload. */
export async function resizeLmStudioContext(baseURL: string, model: string, needed: number, max: number,
  signal?: AbortSignal, cli = localCli): Promise<number | undefined> {
  const url = new URL(baseURL)
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname.replace(/\/$/, '') !== '/v1'
    || !Number.isSafeInteger(needed) || needed <= 0 || needed > max || model.startsWith('-')) return
  const target = Math.min(max, 2 ** Math.ceil(Math.log2(needed)))
  const key = url.origin + '/' + model
  const existing = resizes.get(key)
  if (existing) {
    const size = await existing
    return size !== undefined && size >= needed ? size : undefined
  }
  const operation = (async () => {
    const server = JSON.parse(await cli(['server', 'status', '--json'], 5000))
    if (!server.running || server.port !== Number(url.port || (url.protocol === 'https:' ? 443 : 80))) return
    const instances = (JSON.parse(await cli(['ps', '--json'], 5000)) as Instance[]).filter(item => item.type === 'llm')
    const instance = instances.find(item => item.identifier === model)
    if (!instance) return
    if (instance.contextLength >= needed) return instance.contextLength
    if (instances.length !== 1 || instance.status !== 'idle' || instance.queued !== 0 || instance.engineConfigFileEnabled) return
    // lms ps can return a suffixed selectedVariant (e.g. @q4_k_m) that lms load rejects.
    // The model key resolves unambiguously when there is only one installed variant.
    const variant = instance.variants?.length === 1 ? instance.modelKey : instance.selectedVariant ?? instance.modelKey
    if (!variant || variant.startsWith('-') || !Number.isSafeInteger(instance.parallel) || instance.parallel < 1) return
    const load = (size: number, parallel: number) => ['load', variant, '--identifier', model, '-c', String(size),
      '--parallel', String(parallel), ...instance.ttlMs && instance.ttlMs > 0 ? ['--ttl', String(Math.ceil(instance.ttlMs / 1000))] : [], '--yes']
    await cli([...load(target, 1), '--estimate-only'], 15000)
    signal?.throwIfAborted()
    const latest = (JSON.parse(await cli(['ps', '--json'], 5000)) as Instance[]).filter(item => item.type === 'llm')
    if (latest.length !== 1 || latest[0]?.identifier !== model || latest[0].contextLength !== instance.contextLength
      || latest[0].status !== 'idle' || latest[0].queued !== 0) return
    await cli(['unload', model], 15000)
    try {
      // Finish or restore the replacement even when the caller cancels after unload.
      await cli(load(target, 1), 120000)
    } catch (error) {
      try { await cli(load(instance.contextLength, instance.parallel), 120000) }
      catch (restore) { throw new Error('LM Studio failed to load the larger context and to restore the original instance.', { cause: restore }) }
      throw new Error('LM Studio could not load the larger context. The previous instance was restored.', { cause: error })
    }
    return target
  })()
  resizes.set(key, operation)
  try { return await operation } finally { resizes.delete(key) }
}
