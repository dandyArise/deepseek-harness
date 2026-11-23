import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'

const OPEN = '<think>'
const CLOSE = '</think>'

/** Convert leading tagged reasoning to typed blocks, including tool-enabled replies.
 * @param events - provider events with potentially fragmented text tags.
 * @returns events with consistent streamed and replay content; no extra inference.
 */
export async function* normalizeThinkTags(events: AsyncIterable<AssistantMessageEvent>): AsyncGenerator<AssistantMessageEvent> {
  const blocks: AssistantMessage['content'] = []
  const indices = new Map<number, number>()
  const texts = new Map<number, { phase: 'prefix' | 'thinking' | 'text'; pending: string; index: number }>()
  const message = (source: AssistantMessage): AssistantMessage => ({ ...source, content: blocks.map(block => ({ ...block })) })
  for await (const event of events) {
    if (event.type === 'done') {
      yield { ...event, message: message(event.message) }
      continue
    }
    if (event.type === 'error') {
      yield { ...event, error: message(event.error) }
      continue
    }
    if (event.type === 'start') {
      yield { ...event, partial: message(event.partial) }
      continue
    }
    if (event.type === 'text_start') {
      texts.set(event.contentIndex, { phase: 'prefix', pending: '', index: -1 })
      continue
    }
    if (event.type === 'text_delta' || event.type === 'text_end') {
      const state = texts.get(event.contentIndex)
      if (state === undefined) throw new Error('Text event received before text_start')
      const ending = event.type === 'text_end'
      if (!ending) state.pending += event.delta
      if (state.phase === 'prefix') {
        const trimmed = state.pending.trimStart()
        if (!ending && OPEN.startsWith(trimmed) && trimmed !== OPEN) continue
        state.phase = trimmed.startsWith(OPEN) ? 'thinking' : 'text'
        if (state.phase === 'thinking') state.pending = trimmed.slice(OPEN.length)
        state.index = blocks.length
        blocks.push(state.phase === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' })
        yield { type: state.phase === 'thinking' ? 'thinking_start' : 'text_start', contentIndex: state.index, partial: message(event.partial) }
      }
      if (state.phase === 'thinking') {
        const at = state.pending.indexOf(CLOSE)
        let keep = 0
        if (at < 0 && !ending) {
          for (let size = 1; size < CLOSE.length; size++) {
            if (state.pending.endsWith(CLOSE.slice(0, size))) keep = size
          }
        }
        const delta = at >= 0 ? state.pending.slice(0, at) : state.pending.slice(0, state.pending.length - keep)
        const index = state.index
        const block = blocks[index]
        if (block?.type === 'thinking') {
          block.thinking += delta
          if (delta) yield { type: 'thinking_delta', contentIndex: index, delta, partial: message(event.partial) }
          if (at >= 0 || ending) yield { type: 'thinking_end', contentIndex: index, content: block.thinking, partial: message(event.partial) }
        }
        state.pending = at >= 0 ? state.pending.slice(at + CLOSE.length) : state.pending.slice(state.pending.length - keep)
        if (at >= 0) {
          state.phase = 'text'
          state.index = blocks.length
          blocks.push({ type: 'text', text: '' })
          yield { type: 'text_start', contentIndex: state.index, partial: message(event.partial) }
        }
      }
      if (state.phase === 'text') {
        const index = state.index
        const block = blocks[index]
        if (block?.type === 'text') {
          block.text += state.pending
          if (state.pending) yield { type: 'text_delta', contentIndex: index, delta: state.pending, partial: message(event.partial) }
          state.pending = ''
          if (ending) yield { type: 'text_end', contentIndex: index, content: block.text, partial: message(event.partial) }
        }
      }
      continue
    }
    let index = indices.get(event.contentIndex)
    if (index === undefined) {
      index = blocks.length
      indices.set(event.contentIndex, index)
    }
    // Preserve native reasoning, signatures and structured tool calls unchanged.
    const original = event.partial.content[event.contentIndex]
    if (original) blocks[index] = { ...original }
    yield { ...event, contentIndex: index, partial: message(event.partial) }
  }
}
