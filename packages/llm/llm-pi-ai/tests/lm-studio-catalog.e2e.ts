import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { expect, it } from 'vitest'

it.skipIf(!process.env.LM_API_TOKEN)('imports the live LM Studio catalog and resolves its effective context without generation', async () => {
  const ctx = new Context()
  const baseURL = 'http://127.0.0.1:1234/v1'
  const local = 'lm-studio'
  try {
    await ctx.plugin(LlmRuntime)
    const discovery = ctx.plugin(LlmPiAi, {})
    await discovery
    const found = await ctx.llm.discoverModels('llm-pi-ai', {
      provider: local, baseURL, apiKey: process.env.LM_API_TOKEN!,
    })
    expect(found.length).toBeGreaterThan(0)
    expect(found.every(model => model.lmStudio?.source === '/api/v1/models')).toBe(true)
    await discovery.dispose()
    await ctx.plugin(LlmPiAi, { providers: {
      [local]: { baseURL, api: 'openai-completions', apiKeyEnv: 'LM_API_TOKEN', models: found.map(model => ({
        id: model.id, lmStudio: model.lmStudio!,
      })) },
    } })
    for (const model of found) {
      const data = model.lmStudio!
      const info = await ctx.llm.resolveModelInfo(local, model.id)
      expect(info.lmStudio).toMatchObject(data)
      expect(info.context?.contextWindow).toBe(data.loadedContext ?? data.maxContext)
    }
  } finally {
    await ctx.fiber.dispose()
  }
})
