import type { Context } from '@deepseek-ai/cordis'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'
export const name = 'mission-mock'
export const inject = ['llm']
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['mission-coordinator'], new MockAdapter([
    toolCallResponse('task', 'mission_task', { id: 'compare', role: 'research', objective: 'Compare three products.', acceptance: ['State missing evidence.'] }),
    toolCallResponse('recover', 'mission_results', { id: 'compare' }),
    textResponse('Comparison incomplete: sources unavailable. Result recovered without repeating the work.'),
  ]))
  ctx.llm.registerAdapter(['mission-worker'], new MockAdapter([
    toolCallResponse('denied', 'working_directory', {}),
    textResponse('Sources unavailable. No verified product comparison.'),
  ]))
}
