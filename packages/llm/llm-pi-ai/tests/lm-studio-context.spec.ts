import { describe, expect, it, vi } from 'vitest'
import { resizeLmStudioContext } from '../src/lm-studio-context.ts'

const model = 'recursivesi/flint'
const endpoint = 'http://127.0.0.1:1234/v1'
const idle = { type: 'llm', identifier: model, modelKey: model, selectedVariant: model + '@q4_k_m',
  variants: [model + '@q4_k_m'], contextLength: 8192, status: 'idle', queued: 0, parallel: 4, ttlMs: 3600000 }

function cliFor(instances: unknown[], failLarge = false) {
  return vi.fn(async (args: string[]) => {
    if (args[0] === 'server') return '{"running":true,"port":1234}'
    if (args[0] === 'ps') return JSON.stringify(instances)
    if (failLarge && args.includes('16384') && !args.includes('--estimate-only')) throw new Error('Out of memory')
    return ''
  })
}

describe('LM Studio context recovery', () => {
  it('resizes one idle Flint once for simultaneous 12354-token requests with reply headroom', async () => {
    const cli = cliFor([idle])
    const resize = () => resizeLmStudioContext(endpoint, model, 12354 + 2048, 262144, undefined, cli)
    expect(await Promise.all([resize(), resize()])).toEqual([16384, 16384])
    const calls = cli.mock.calls.map(([args]) => args)
    expect(calls.filter(args => args[0] === 'unload')).toEqual([['unload', model]])
    expect(calls.at(-1)).toEqual(['load', model, '--identifier', model, '-c', '16384', '--parallel', '1', '--ttl', '3600', '--yes'])
  })

  it.each([[{ ...idle, status: 'processing' }], [{ ...idle, queued: 1 }], [idle, { ...idle, identifier: 'other' }]])(
    'leaves busy or shared instances alone', async (...instances) => {
      const cli = cliFor(instances)
      expect(await resizeLmStudioContext(endpoint, model, 13000, 262144, undefined, cli)).toBeUndefined()
      expect(cli.mock.calls.map(([args]) => args[0])).not.toContain('unload')
    })

  it('restores the original context and parallelism if the larger load fails', async () => {
    const cli = cliFor([idle], true)
    await expect(resizeLmStudioContext(endpoint, model, 12354, 262144, undefined, cli)).rejects.toThrow('restored')
    expect(cli.mock.calls.at(-1)?.[0]).toEqual(['load', model, '--identifier', model, '-c', '8192', '--parallel', '4', '--ttl', '3600', '--yes'])
  })
})
