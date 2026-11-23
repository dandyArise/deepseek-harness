import type { RequestMessage } from '@deepseek-ai/dsh-llm'

/**
 * Preserve actual user turn boundaries before reminders are projected to the user role.
 * @param messages - request history before provider serialization.
 * @returns history with explicit current and earlier user-request labels when needed.
 */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPart(value: unknown): value is Part {
  return typeof value === 'string' || Array.isArray(value)
}

function parts(content: Part): unknown[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

/**
 * Merge consecutive user messages after serialization omits interrupted assistant turns.
 * @param payload - provider wire payload, preserving multimodal content and tool exchanges.
 * @returns the normalized payload, or the input when it has no message array.
 */
export function mergeDevstralUsers(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || !('messages' in payload) || !Array.isArray(payload.messages)) return payload
  const messages: unknown[] = []
  const sourceMessages: readonly unknown[] = payload.messages
  for (const message of sourceMessages) {
    const previous = messages.at(-1)
    if (isRecord(previous) && isRecord(message) && previous.role === 'user' && message.role === 'user'
      && isPart(previous.content) && isPart(message.content)) {
      const left = previous.content
      const right = message.content
      previous.content = typeof left === 'string' && typeof right === 'string'
        ? left + '\n\n' + right
        : [...parts(left), { type: 'text', text: '\n\n' }, ...parts(right)]
    } else {
      messages.push(isRecord(message) ? { ...message } : message)
    }
  }
  return { ...payload, messages }
}
