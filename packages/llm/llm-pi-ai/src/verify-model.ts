import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ModelVerificationResult, RequestMessage } from '@deepseek-ai/dsh-llm'

/**
 * Exercise both directions of the Harness tool protocol on the configured adapter.
 * @param ctx - context exposing the LLM service.
 * @param provider - configured provider route.
 * @param model - model identifier to verify.
 * @param protocol - expected protocol, checked before generation.
 * @param signal - caller cancellation combined with the verification deadline.
 * @returns a measured structured-tool verdict and failure cause when applicable.
 */
export async function verifyToolRoundTrip(
  ctx: Context, provider: string, model: string, protocol: string, signal: AbortSignal,
): Promise<ModelVerificationResult> {
  const messages: RequestMessage[] = [createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'Quel est mon numéro de suivi ? Utilise lire_suivi et donne-moi le numéro renvoyé.' }],
  })]
  const tools: NonNullable<GenerateOptions['tools']> = [{
    name: 'lire_suivi', description: 'Renvoie le numéro de suivi du colis.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }]
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
  async function generate() {
    const call = await ctx.llm.prepareCall({ provider, model, temperature: 0, maxTokens: 512 }, deadline, (controls, info) => {
      if (info.protocol !== protocol) throw new Error('The configured protocol has changed.')
      return controls
    })
    const assembler = new BlockAssembler()
    for await (const chunk of call.stream({ ...call.config, messages, tools, signal: deadline })) assembler.push(chunk)
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure.message)
    return { finish, message: assembler.message({ provider, model,
      ...assembler.replayState === undefined ? {} : { replayState: assembler.replayState },
    }) }
  }
  try {
    const first = await generate()
    const calls = first.message.content.filter(block => block.type === 'tool-call')
    const [call] = calls
    if (first.finish.kind !== 'tool-calls' || calls.length !== 1 || call?.name !== 'lire_suivi' || !call.id) {
      return { status: 'failed', cause: 'No matching structured tool call.' }
    }
    const value = randomBytes(12).toString('hex')
    messages.push(first.message, createToolResultMessage({ callId: call.id, isError: false,
      content: [{ type: 'text', text: JSON.stringify({ numero_suivi: value }) }],
    }))
    const final = await generate()
    const answer = final.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    return final.finish.kind === 'stop' && answer.includes(value)
      ? { status: 'verified' }
      : { status: 'failed', cause: 'The final answer did not return the tool result.' }
  } catch (error) {
    signal.throwIfAborted()
    return { status: 'blocked', cause: error instanceof Error ? error.message : String(error) }
  }
}
