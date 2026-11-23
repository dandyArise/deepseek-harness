import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'
export const name = 'mission-live-coordinator'
export const inject = ['llm', 'tools']
export function apply(ctx: Context): void {
  const nonce = process.env.MISSION_PROBE_NONCE
  if (!nonce) throw new Error('MISSION_PROBE_NONCE is required')
  ctx.llm.registerAdapter(['mission-coordinator'], new MockAdapter([
    toolCallResponse('task', 'mission_task', { id: 'compare', role: 'research',
      objective: 'Call mission_probe exactly once. Then return its exact receipt in your final answer. No other task or tools.',
      acceptance: ['Use a real structured tool call and reproduce the returned receipt exactly.'] }),
    toolCallResponse('recover', 'mission_results', { id: 'compare' }),
    textResponse('The saved worker result was retrieved. Its contents require checking against the probe receipt.'),
  ]))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'mission_probe', description: 'Return a random test receipt. No side effects.',
    parameters: {},
    output: { schema: { type: 'object', properties: { receipt: { type: 'string', required: true } }, additionalProperties: false },
      render: (_args, result) => [{ type: 'text', text: result.receipt }] },
    execute: async () => ({ receipt: nonce }),
  })))
}
