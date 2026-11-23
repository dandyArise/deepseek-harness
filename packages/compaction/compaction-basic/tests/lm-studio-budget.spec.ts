import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Session, type SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { BasicCompactionEngine } from '../src/index.ts'
import { resolveProfiles } from '../../../llm/llm-pi-ai/src/config.ts'
import { memoryAuth } from '../../../llm/llm-pi-ai/tests/auth-double.ts'

afterEach(() => vi.unstubAllGlobals())

it.each([[false, false], [true, false], [false, true]])('compacts history retaining the latest instruction and reply space (underestimate %s, removed previous model %s)', async (underestimated, removed) => {
  const sent: {
    messages: { role: string; content: string }[]
    max_completion_tokens?: number | undefined
    max_tokens?: number | undefined
  }[] = []
  const model = 'glimmer-v7'
  let rejected = false
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const address = url instanceof Request ? url.url : String(url)
    if (address.endsWith('/api/v1/models')) return Response.json({ models: [{
      key: removed ? `meta/${model}` : model, type: 'llm', max_context_length: 131072,
      loaded_instances: [{ id: 'loaded-copy', config: { context_length: 8192 } }],
    }] })
    expect(address).toBe('http://localhost:1234/v1/chat/completions')
    const body = z.object({ messages: z.array(z.object({ role: z.string(), content: z.string() })),
      max_completion_tokens: z.number().optional(), max_tokens: z.number().optional() })
      .parse(JSON.parse(z.string().parse(init?.body)))
    sent.push(body)
    const prompt = body.messages.map((m: { content: string }) => m.content).join('\n')
    const input = Math.ceil(prompt.length / 4) + body.messages.length * 4
    const reply = body.max_completion_tokens ?? body.max_tokens ?? 0
    expect(reply).toBeGreaterThan(0)
    expect(input + reply).toBeLessThanOrEqual(8192)
    const summary = prompt.includes('acting as a compaction engine')
    if (summary) {
      expect(prompt).toContain('at most 200 words')
      expect(reply).toBe(2048)
    }
    if (underestimated && !summary && !rejected) {
      rejected = true
      return Response.json({ error: { type: 'exceed_context_size_error', n_prompt_tokens: 11991, n_ctx: 8192,
        message: 'request (11991 tokens) exceeds the available context size (8192 tokens)' } }, { status: 400 })
    }
    const text = summary ? 'Earlier work: preserve the saved files; no tests were run.' : 'OK'
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  }))
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  ctx.llm.registerAdapter(['lmstudio'], new PiAiAdapter({
    profiles: () => resolveProfiles({ lmstudio: { api: 'openai-completions', baseURL: 'http://localhost:1234/v1',
      models: [{ id: model, contextWindow: 131072, ...removed ? {} : { lmStudio: { source: '/api/v1/models', maxContext: 131072 } } }],
    } }), resolveApiKey: async () => 'test-only', auth: memoryAuth(),
  }))
  await ctx.plugin(BasicCompactionEngine)
  const seed = Session.create(brandString<SessionId>('capacity-seed'))
  for (let turn = 1; turn <= 4; turn++) {
    seed.append('turn/start', { turn })
    seed.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(underestimated ? 1000 : 11970) }] }), { surfaceOp: 'append' })
    seed.append('step/start', { turn, step: 1 })
    if (removed && turn === 1) seed.append('request/header', {
      header: { config: { provider: 'lmstudio', model: 'removed-v7' } }, reason: 'initial',
    })
    seed.append('assistant/message', { turn, step: 1, stream: [], message: createMessage({ role: 'assistant',
      source: { kind: 'model', provider: 'lmstudio', model: removed ? 'removed-v7' : model }, content: [{ type: 'text', text: 'saved' }] }) }, { surfaceOp: 'append' })
    seed.append('step/end', { turn, step: 1 })
    seed.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  try {
    const { agent } = await ctx.agentLoop.createAgent(ctx, { sessionId: brandString<SessionId>('loaded-capacity'),
      seed: seed.snapshotEvents(), agentOptions: { provider: 'lmstudio', model } })
    if (removed) agent.model.select({ provider: 'lmstudio', model })
    const latest = 'Réponds uniquement OK. Ne lance aucun outil et ne modifie aucun fichier.'
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: latest }] }))
    await agent.whenIdle()
    const events = agent.session.snapshotEvents()
    expect(events.at(-1), JSON.stringify(events.filter(e => e.type === 'compaction/end' || e.type === 'turn/end').slice(-4))).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(events.filter(e => e.type === 'compaction/summary').length).toBeGreaterThan(0)
    expect(sent.at(-1)?.messages.some(message => message.content.includes(latest))).toBe(true)
    expect(sent.at(-1)?.max_completion_tokens ?? sent.at(-1)?.max_tokens).toBe(2048)
    expect(sent.length).toBeLessThanOrEqual(5)
    expect(events.filter(e => e.type === 'tool/call')).toHaveLength(0)
  } finally { await ctx.fiber.dispose() }
})
