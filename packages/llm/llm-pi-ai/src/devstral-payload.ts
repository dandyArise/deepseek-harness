import type { RequestMessage } from '@deepseek-ai/dsh-llm'

/** Preserve actual user turn boundaries before reminders are projected to the user role. */
export function markDevstralRequests(messages: RequestMessage[]): RequestMessage[] {
  const isRequest = (message: RequestMessage) => message.role === 'user'
    && (message.source === undefined || message.source.kind === 'user')
  const last = messages.findLastIndex(isRequest)
  if (last < 0 || !messages.slice(0, last).some(isRequest)) return messages
  return messages.map((message, index) => {
    if (message.role !== 'user' || !isRequest(message)) return message
    const heading = index === last
      ? 'Current user request (answer this turn; resume earlier work only if requested):'
      : 'Earlier user request (conversation history):'
    return { ...message, content: [{ type: 'text', text: heading + '\n' }, ...message.content] }
  })
}

type Part = string | unknown[]

function parts(content: Part): unknown[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

// pi-ai can omit interrupted assistant turns during wire serialization.
// Merge instructions after that projection, preserving multimodal content.
export function mergeDevstralUsers(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || !('messages' in payload) || !Array.isArray(payload.messages)) return payload
  const messages = []
  for (const message of payload.messages) {
    const previous = messages.at(-1)
    if (previous?.role === 'user' && message?.role === 'user') {
      const left = previous.content
      const right = message.content
      previous.content = typeof left === 'string' && typeof right === 'string'
        ? left + '\n\n' + right
        : [...parts(left), { type: 'text', text: '\n\n' }, ...parts(right)]
    } else {
      messages.push({ ...message })
    }
  }
  return { ...payload, messages }
}
