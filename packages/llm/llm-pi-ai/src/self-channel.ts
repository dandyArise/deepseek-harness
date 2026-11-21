import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'

const SELF = 'to=self<|message|>'
const USER = 'to=user<|message|>'
const THINK = '<think>'
export const FINAL_CHANNEL_INSTRUCTION = '\nAnswer the latest user message directly. Produce only the final user-facing answer, without internal reasoning or channel headers.'

/** Repair leading channel headers and think blocks before rendered Markdown.
 * Ordinary replies stream after their first non-header prefix. A malformed reply is
 * withheld and retried once; internal deliberation is never promoted to an answer.
 */
export async function* recoverSelfChannel(
  open: (retry: boolean, usedOutput: number) => AsyncIterable<AssistantMessageEvent>,
): AsyncGenerator<AssistantMessageEvent> {
  let previous: AssistantMessage['usage'] | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending: AssistantMessageEvent[] = []
    let prefix = ''
    let passing = false
    let completed = false
    for await (const event of open(attempt === 1, previous?.output ?? 0)) {
      const withUsage = (message: AssistantMessage): AssistantMessage => {
        if (previous === undefined) return message
        const usage = { ...message.usage, cost: { ...message.usage.cost } }
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) usage[key] += previous[key]
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) usage.cost[key] += previous.cost[key]
        return { ...message, usage }
      }
      if (passing) {
        yield event.type === 'done' ? { ...event, message: withUsage(event.message) }
          : event.type === 'error' ? { ...event, error: withUsage(event.error) } : event
        continue
      }
      pending.push(event)
      if (event.type === 'text_delta') prefix += event.delta
      const trimmed = prefix.trimStart()
      const thinking = trimmed.startsWith(THINK)
      const channel = trimmed.startsWith(SELF) || trimmed.startsWith(USER) || thinking
      const possible = [SELF, USER, THINK].some(header => header.startsWith(trimmed))
      if ((!channel && !possible) || event.type === 'thinking_start' || event.type === 'toolcall_start') {
        passing = true
        for (const buffered of pending) yield buffered
        pending.length = 0
        continue
      }
      if (prefix.length > 65536) throw new LlmError('Malformed channel response exceeds recovery limit', 'MALFORMED_RESPONSE')
      if (event.type === 'error') {
        yield { ...event, error: withUsage(event.error) }
        return
      }
      if (event.type !== 'done') continue
      completed = true
      if (!channel) {
        for (const buffered of pending) yield buffered.type === 'done' ? { ...buffered, message: withUsage(buffered.message) } : buffered
        return
      }
      const userAt = trimmed.indexOf(USER)
      const thinkEnd = thinking ? trimmed.indexOf('</think>', THINK.length) : -1
      const answer = thinking
        ? thinkEnd < 0 ? '' : trimmed.slice(thinkEnd + '</think>'.length).trim()
        : userAt < 0 ? '' : trimmed.slice(userAt + USER.length).replace(/<\|(?:im_end|end|fim_suffix)\|>\s*$/, '').trim()
      if (answer && !answer.includes('<|') && !answer.includes('to=self')) {
        const message = withUsage({ ...event.message, content: [{ type: 'text', text: answer }] })
        yield { type: 'text_start', contentIndex: 0, partial: message }
        yield { type: 'text_delta', contentIndex: 0, delta: answer, partial: message }
        yield { type: 'text_end', contentIndex: 0, content: answer, partial: message }
        yield { ...event, message }
        return
      }
      previous = withUsage(event.message).usage
      if (attempt === 1 || event.message.stopReason !== 'stop') {
        yield { type: 'error', reason: 'error', error: {
          ...event.message, content: [], usage: previous, stopReason: 'error',
          errorMessage: 'MALFORMED_CHANNEL_RESPONSE: provider returned internal reasoning without a final answer',
        } }
        return
      }
      break
    }
    if (passing || !completed) {
      if (!passing) for (const buffered of pending) yield buffered
      return
    }
  }
}
