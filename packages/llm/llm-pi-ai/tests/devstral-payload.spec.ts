import { expect, it } from 'vitest'
import { markDevstralRequests, mergeDevstralUsers } from '../src/devstral-payload.ts'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'

it('preserves invalid wire values for provider validation instead of throwing or losing them', () => {
  const messages = [null, 'invalid', { role: 'user', content: null }, { role: 'user', content: 'keep' }]
  expect(mergeDevstralUsers({ messages })).toEqual({ messages })
  expect(mergeDevstralUsers(null)).toBeNull()
  const payload = { messages: 'invalid' }
  expect(mergeDevstralUsers(payload)).toBe(payload)
})

it('distinguishes an earlier coding request from a new question even with a trailing context injection', () => {
  const user = (text: string): RequestMessage => ({ role: 'user', content: [{ type: 'text', text }] })
  const reminder = { ...user('Time context'), source: { kind: 'time-context' } } as RequestMessage
  const turns = markDevstralRequests([user('Edit the tests'), user('What is 12 + 8?'), reminder])
  expect(turns[0]?.content[0]).toMatchObject({ text: expect.stringContaining('Earlier user request') as string })
  expect(turns[1]?.content[0]).toMatchObject({ text: expect.stringContaining('Current user request') as string })
  expect(turns[2]).toBe(reminder)
})

it('keeps tool exchanges and merges users adjacent after an interrupted reply was omitted', () => {
  const exchange = [
    { role: 'assistant', tool_calls: [{ id: 'example' }] },
    { role: 'tool', tool_call_id: 'example', content: '42' },
    { role: 'assistant', content: 'Received.' },
  ]
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
  const first = { role: 'user', content: 'First instruction' }
  expect(mergeDevstralUsers({ messages: [...exchange, first, { role: 'user', content: [image] }] }))
    .toEqual({ messages: [...exchange, { role: 'user', content: [
      { type: 'text', text: first.content }, { type: 'text', text: '\n\n' }, image,
    ] }] })
  expect(first.content).toBe('First instruction')
})
