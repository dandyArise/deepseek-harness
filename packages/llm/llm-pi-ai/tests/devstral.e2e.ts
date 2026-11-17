import { randomBytes } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { expect, it } from 'vitest'
import { assemble } from './assemble.ts'

const model = process.env.DEVSTRAL_MODEL
it.skipIf(!model || !process.env.LM_API_TOKEN)('Devstral answers and reads a fresh value through a tool', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, { providers: { local: {
      api: 'openai-completions', baseURL: 'http://127.0.0.1:1234/v1',
      apiKeyEnv: 'LM_API_TOKEN', models: [{ id: model! }],
    } } })
    const history = (prompt: string) => ['Session locale.', 'Langue française.', 'Mode test.', 'Contexte prêt.', prompt]
      .map(text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    const request = { provider: 'local', model: model!, system: 'Suis les instructions.', temperature: 0, maxTokens: 256 }
    const simple = await assemble(ctx, { ...request, messages: history('Réponds uniquement OK') })
    const text = (reply: typeof simple) => reply.message.content.filter(block => block.type === 'text').map(block => block.text).join('').trim()
    expect(text(simple)).toBe('OK')
    const messages = history('Quel est mon numéro de suivi ? Utilise lire_suivi et donne-moi le numéro renvoyé.')
    const tools = [{ name: 'lire_suivi', description: 'Renvoie le numéro de suivi du colis.', parameters: { type: 'object', properties: {} } }]
    const first = await assemble(ctx, { ...request, messages, tools })
    const calls = first.message.content.filter(block => block.type === 'tool-call')
    expect(calls.map(call => call.name)).toEqual(['lire_suivi'])
    const code = randomBytes(8).toString('hex')
    const result = createToolResultMessage({ callId: calls[0]!.id, content: [{ type: 'text', text: JSON.stringify({ numero_suivi: code }) }], isError: false })
    const reminder = createUserMessage({
      source: { kind: 'repeat-tool-reminder' },
      content: [{ type: 'text', text: 'Utilise le résultat précédent pour répondre.' }],
    })
    const final = await assemble(ctx, { ...request, messages: [...messages, first.message, result, reminder], tools })
    expect(text(final)).toContain(code)
  } finally {
    await ctx.fiber.dispose()
  }
}, 120_000)
