import { expect, it, vi } from 'vitest'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import { recoverSelfChannel } from '../src/self-channel.ts'

async function* reply(parts: string[]): AsyncGenerator<AssistantMessageEvent> {
  const text = parts.join('')
  const message: AssistantMessage = {
    role: 'assistant', api: 'openai-completions', provider: 'lmstudio', model: 'fixture',
    content: [{ type: 'text', text }], timestamp: 0, stopReason: 'stop',
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
  yield { type: 'text_start', contentIndex: 0, partial: message }
  for (const delta of parts) yield { type: 'text_delta', contentIndex: 0, delta, partial: message }
  yield { type: 'text_end', contentIndex: 0, content: text, partial: message }
  yield { type: 'done', reason: 'stop', message }
}
async function collect(stream: AsyncIterable<AssistantMessageEvent>) {
  const result: AssistantMessageEvent[] = []
  for await (const event of stream) result.push(event)
  return result
}
it('recovers the observed split self-channel response once without exposing deliberation', async () => {
  const open = vi.fn((retry: boolean) => reply(retry ? ['discussion conservée.']
    : [' to', '=self', '<|message|>', 'The user says... No tool.']))
  const result = await collect(recoverSelfChannel(open))
  expect(open.mock.calls).toHaveLength(2)
  expect(JSON.stringify(result)).not.toContain('The user says')
  expect(result.at(-1)).toMatchObject({ type: 'done', message: {
    content: [{ type: 'text', text: 'discussion conservée.' }], usage: { input: 20, output: 10, totalTokens: 30 },
  } })
})
it('extracts an explicitly addressed user answer without making another request', async () => {
  const open = vi.fn(() => reply(['to=self<|message|>private', ' to=user<|message|>Bonjour !<|im_end|>']))
  const result = await collect(recoverSelfChannel(open))
  expect(open).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(result)).not.toContain('private')
  expect(result.at(-1)).toMatchObject({ message: { content: [{ type: 'text', text: 'Bonjour !' }] } })
})
it('stops after one unsuccessful recovery instead of claiming success', async () => {
  const open = vi.fn(() => reply(['to=self<|message|>private']))
  const result = await collect(recoverSelfChannel(open))
  expect(open).toHaveBeenCalledTimes(2)
  expect(result.at(-1)).toMatchObject({ type: 'error', error: { content: [], usage: { output: 10 } } })
})
it('preserves ordinary text and quoted protocol examples', async () => {
  for (const text of ['Bonjour !', 'to=someone', 'Exemple : `to=self<|message|>`', 'Exemple : `<think>texte</think>`', '<thing>']) {
    const original = await collect(reply([text]))
    expect(await collect(recoverSelfChannel(() => reply([text])))).toEqual(original)
  }
})

it('extracts the answer after split think tags without another generation or leaked replay text', async () => {
  const open = vi.fn(() => reply([' \n<', 'thi', 'nk>', 'private deliberation', '</thi', 'nk>Bonjour !']))
  const result = await collect(recoverSelfChannel(open))
  expect(open).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(result)).not.toContain('private deliberation')
  expect(JSON.stringify(result)).not.toContain('<think>')
  expect(result.at(-1)).toMatchObject({ type: 'done', message: {
    content: [{ type: 'text', text: 'Bonjour !' }], usage: { input: 10, output: 5, totalTokens: 15 },
  } })
  expect(result.filter(event => event.type === 'text_delta')).toMatchObject([{ delta: 'Bonjour !' }])
})

it('does not promote unclosed thinking to a final answer and bounds recovery', async () => {
  const open = vi.fn(() => reply(['<think>private deliberation']))
  const result = await collect(recoverSelfChannel(open))
  expect(open).toHaveBeenCalledTimes(2)
  expect(result.at(-1)).toMatchObject({ type: 'error', error: { content: [], usage: { output: 10 } } })
  expect(JSON.stringify(result)).not.toContain('private deliberation')
})
