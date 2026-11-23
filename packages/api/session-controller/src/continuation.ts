/** Constant-size continuation eligibility over the complete durable Session. */
import type {} from './types.ts'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { brandNumber } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'

// Explicit manual requests use a fixed product policy, independent of automatic retry configuration.
const CONTINUABLE_FAILURES: ReadonlySet<string> = new Set([
  'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'STREAM_CLOSED',
  'CONTEXT_WINDOW_EXCEEDED',
])

const endingSchema = z.number().int().nonnegative().transform(brandNumber<SessionSeq>).nullable()
const stateSchema = z.object({
  admitted: z.boolean(),
  failedAttempt: z.boolean(),
  ending: endingSchema,
  truncated: z.literal(true).optional(),
  humanTurn: z.boolean(),
  retryTurn: z.boolean(),
  lastTextTruncated: z.boolean(),
  autoContinue: z.boolean(),
})

/** Recoverable manual-continuation facts over admitted user input and empty retry messages. */
export type ContinuationState = z.infer<typeof stateSchema>

/** Explicit continuation instruction for an admitted response truncated by its output limit. */
export const continuationPrompt = 'Continue the previous response in its original language from where it stopped.'

const EMPTY: ContinuationState = { admitted: false, failedAttempt: false, ending: null,
  humanTurn: false, retryTurn: false, lastTextTruncated: false, autoContinue: false }

/** Eligibility requires admitted human work and a failed settlement in the last request step. */
export const continuationProjectionDefinition = {
  key: 'conversationContinuation',
  stateVersion: 6,
  stateSchema,
  init: (): ContinuationState => EMPTY,
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start':
        return EMPTY
      case 'step/start':
        return state.failedAttempt ? { ...state, failedAttempt: false } : state
      case 'assistant/message': {
        const { message, stream, interrupted } = event.data
        const lastTextTruncated = !interrupted
          && !message.content.some(block => block.type === 'tool-call')
          && message.content.some(block => block.type === 'text' && block.text.trim())
          && stream.some(frame => frame.type === 'chunk' && frame.chunk.type === 'finish' && frame.chunk.reason.kind === 'max-tokens')
          && !stream.some(frame => frame.type === 'tool-call-chunks' || (frame.type === 'chunk'
            && frame.chunk.type === 'block-start' && frame.chunk.blockType === 'tool-call'))
        return !state.failedAttempt && state.lastTextTruncated === lastTextTruncated ? state
          : { ...state, failedAttempt: false, lastTextTruncated }
      }
      case 'user/message': {
        const humanTurn = state.humanTurn || (event.surfaceOp === 'append' && event.data.source.kind === 'user')
        const retryTurn = state.retryTurn || event.data.source.kind === 'retry'
        const admitted = state.admitted || event.surfaceOp === 'append'
          && ((event.data.source.kind === 'user' && event.data.content.length > 0)
            || (event.data.source.kind === 'retry' && (event.data.content.length === 0
              || (event.data.content.length === 1 && event.data.content[0]?.type === 'text'
                && event.data.content[0].text === continuationPrompt))))
        return admitted === state.admitted && humanTurn === state.humanTurn && retryTurn === state.retryTurn ? state
          : { ...state, admitted, humanTurn, retryTurn }
      }
      case 'assistant/attempt':
        return state.failedAttempt ? state : { ...state, failedAttempt: true }
      case 'turn/end': {
        if (event.data.reason.kind === 'max-tokens' && state.admitted) {
          return { ...EMPTY, ending: event.seq, truncated: true,
            autoContinue: state.humanTurn && !state.retryTurn && state.lastTextTruncated }
        }
        const ending = event.data.reason.kind === 'error' && CONTINUABLE_FAILURES.has(event.data.reason.error.code)
          && state.admitted && state.failedAttempt ? event.seq : null
        return ending === null ? EMPTY : { ...EMPTY, ending }
      }
      default:
        return state
    }
  },
  wire: {
    viewSchema: endingSchema,
    view: (state: ContinuationState) => state.ending,
  },
} satisfies ProjectionDefinition<'conversationContinuation', ContinuationState>
