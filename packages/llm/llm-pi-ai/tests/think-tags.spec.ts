import { expect, it } from 'vitest'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import { normalizeThinkTags } from '../src/think-tags.ts'

const base: AssistantMessage = {
  role: 'assistant', api: 'openai-completions', provider: 'lmstudio', model: 'fixture',
  content: [], timestamp: 0, stopReason: 'stop',
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
}
async function* reply(parts: string[], tool = false): AsyncGenerator<AssistantMessageEvent> {
  const partial: AssistantMessage = { ...base, content: [{ type: 'text', text: '' }] }
  yield { type: 'text_start', contentIndex: 0, partial }
  for (const delta of parts) {
    partial.content[0] = { type: 'text', text: (partial.content[0] as { text: string }).text + delta }
    yield { type: 'text_delta', contentIndex: 0, delta, partial }
  }
  yield { type: 'text_end', contentIndex: 0, content: parts.join(''), partial }
  if (tool) {
    const toolCall = { type: 'toolCall' as const, id: 'call-1', name: 'read', arguments: { file_path: 'preuve.txt' } }
    partial.content.push(toolCall)
    yield { type: 'toolcall_start', contentIndex: 1, partial }
    yield { type: 'toolcall_delta', contentIndex: 1, delta: JSON.stringify(toolCall.arguments), partial }
    yield { type: 'toolcall_end', contentIndex: 1, toolCall, partial }
  }
  yield { type: 'done', reason: tool ? 'toolUse' : 'stop', message: { ...partial, stopReason: tool ? 'toolUse' : 'stop' } }
}
async function collect(events: AsyncIterable<AssistantMessageEvent>) {
  const result: AssistantMessageEvent[] = []
  for await (const event of normalizeThinkTags(events)) result.push(event)
  return result
}
it('separates tagged reasoning at every chunk boundary and preserves the following tool call', async () => {
  const text = ' \n<think>Inspect the file.</think>Reading.'
  for (let at = 1; at < text.length; at++) {
    const result = await collect(reply([text.slice(0, at), text.slice(at)], true))
    const visible = result.filter(e => e.type === 'text_delta').map(e => e.delta).join('')
    expect(visible).toBe('Reading.')
    expect(result.at(-1)).toMatchObject({ message: { content: [
      { type: 'thinking', thinking: 'Inspect the file.' },
      { type: 'text', text: 'Reading.' },
      { type: 'toolCall', id: 'call-1', name: 'read', arguments: { file_path: 'preuve.txt' } },
    ], usage: base.usage } })
    expect(result.find(e => e.type === 'toolcall_start')).toMatchObject({ contentIndex: 2, partial: { content: [
      { type: 'thinking' }, { type: 'text' }, { type: 'toolCall', name: 'read' },
    ] } })
  }
})
it('keeps incomplete reasoning out of the visible answer while emitting live reasoning', async () => {
  const result = await collect(reply(['<think>', 'Checking', ' now', '</thi']))
  expect(result.some(e => e.type === 'text_delta')).toBe(false)
  expect(result.filter(e => e.type === 'thinking_delta').map(e => e.delta).join('')).toBe('Checking now</thi')
})
it('preserves literal examples and normal text', async () => {
  for (const text of ['Bonjour', 'Exemple : <think>x</think>', '<thing>', '<thi']) {
    const result = await collect(reply([...text]))
    expect(result.filter(e => e.type === 'text_delta').map(e => e.delta).join('')).toBe(text)
  }
})
it('records the rendered answer without internal tags', async () => {
  const result = await collect(reply(['<think>private</think>Bonjour !']))
  expect(result.filter(e => e.type === 'text_delta').map(e => e.delta).join('')).toMatchInlineSnapshot('"Bonjour !"')
})

it('preserves native reasoning signatures before a tagged final text block', async () => {
  async function* events(): AsyncGenerator<AssistantMessageEvent> {
    const native = { type: 'thinking' as const, thinking: 'Native reasoning.', thinkingSignature: 'reasoning_content' }
    const partial = { ...base, content: [native] }
    yield { type: 'thinking_start', contentIndex: 0, partial }
    yield { type: 'thinking_delta', contentIndex: 0, delta: native.thinking, partial }
    yield { type: 'thinking_end', contentIndex: 0, content: native.thinking, partial }
    for await (const event of reply(['<think>More reasoning.</think>Answer.'])) {
      if (event.type === 'done') yield { ...event, message: { ...event.message, content: [native, ...event.message.content] } }
      else if ('contentIndex' in event) yield { ...event, contentIndex: event.contentIndex + 1, partial: { ...event.partial, content: [native, ...event.partial.content] } }
    }
  }
  const result = await collect(events())
  expect(result.at(-1)).toMatchObject({ message: { content: [
    { type: 'thinking', thinkingSignature: 'reasoning_content' },
    { type: 'thinking', thinking: 'More reasoning.' },
    { type: 'text', text: 'Answer.' },
  ] } })
})
