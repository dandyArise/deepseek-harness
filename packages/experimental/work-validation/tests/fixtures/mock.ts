import type { Context } from '@deepseek-ai/cordis'
import { MockAdapter, textResponse } from '../../../../core/agent-loop/tests/mock-adapter.ts'
export const name = 'validation-mock'
export const inject = ['llm']
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['validation-mock'], new MockAdapter([
    textResponse('All tests pass'), textResponse('Work is incomplete: the required test has no configured command.'),
  ]))
}
