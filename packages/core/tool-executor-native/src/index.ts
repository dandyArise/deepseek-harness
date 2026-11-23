/** Native execution plugin for the mounting Agent, preset, or deployment scope. @module */
import type { Context } from '@deepseek-ai/cordis'
import { projectToolSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutor, ToolModelInput, ToolBatchInput, ToolBatchResult } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline'
import { compactDefinition, definitionTokens } from './presentation.ts'

const DISCOVER = 'harness_discover_tools'
interface PresentationState { budget: number; selected?: string; deferred: boolean }

/** Executes visible capabilities directly and owns their complete batch settlement. */
export class NativeToolExecutor implements ToolExecutor {
  private readonly pipeline: ToolExecutionPipeline
  private readonly states = new WeakMap<object, PresentationState>()
  private readonly registry: Context['tools']

  constructor(ctx: Context, private readonly maxParallel: () => number = () => 10) {
    this.registry = ctx.tools
    this.pipeline = new ToolExecutionPipeline(ctx, {
      get: (name, scope, toolSet) => {
        const state = scope && this.states.get(scope)
        if (name === DISCOVER && state?.deferred) return this.discovery(state)
        if (state?.deferred && name !== state.selected) return undefined
        return this.registry.executable(name, scope, toolSet)
      },
    })
  }

  describe(tools: readonly ToolDefinition[], context?: { scope?: object; contextWindow?: number }): ToolModelInput {
    if (context?.scope && context.contextWindow !== undefined) {
      const previous = this.states.get(context.scope)
      this.states.set(context.scope, { ...previous, budget: Math.max(128, Math.floor(context.contextWindow / 4)), deferred: false })
    }
    const full = tools.map(definition => projectToolSchema(definition, false))
    const state = context?.scope && this.states.get(context.scope)
    if (!state || definitionTokens(full) <= state.budget || tools.some(tool => tool.name === DISCOVER)) {
      if (state) state.deferred = false
      return { schemas: full }
    }
    const compact = full.map(compactDefinition)
    if (definitionTokens(compact) <= state.budget) {
      state.deferred = false
      return { schemas: compact }
    }
    state.deferred = true
    const schemas = [projectToolSchema(this.discovery(state), false)]
    const selected = compact.find(tool => tool.name === state.selected)
    if (selected && definitionTokens([...schemas, selected]) <= state.budget) schemas.push(selected)
    else delete state.selected
    return { schemas, knownNames: [...tools.map(tool => tool.name), DISCOVER] }
  }

  private discovery(state: PresentationState): ToolDefinition {
    return {
      name: DISCOVER,
      description: 'Tools are available on demand to save context. Search by keyword (empty query lists names), then request an exact name to enable it on the next step. Only that tool is enabled until you select another. Do not discover tools for a greeting or a question that needs no tools.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['query'] },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: (args, exec) => Promise.resolve().then(() => {
        const { query, offset = 0 } = args as { query: string; offset?: number }
        const tools = this.registry.definitions(exec.agent, exec.toolSet)
        const exact = tools.find(tool => tool.name === query)
        if (exact) {
          const schema = compactDefinition(projectToolSchema(exact, false))
          if (definitionTokens([projectToolSchema(this.discovery(state), false), schema]) > state.budget) {
            return { enabled: false, error: 'This tool schema exceeds the available tool budget; use a smaller tool or a larger context.' }
          }
          state.selected = exact.name
          return { enabled: true, name: exact.name, instruction: 'Call this tool directly on the next step; its schema will be supplied.' }
        }
        const matches = tools.filter(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase()))
        return { tools: matches.slice(offset, offset + 12).map(tool => ({ name: tool.name, description: tool.description.slice(0, 100) })),
          total: matches.length, nextOffset: offset + 12 < matches.length ? offset + 12 : null }
      }),
    }
  }

  execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    return executeToolBatch(input, this.pipeline, this.maxParallel)
  }
}

/** Cordis plugin name. */
export const name = 'native-tool-executor'
/** Tool registration and scoped dispatch. */
export const inject = ['tools']

/**
 * Select native execution in the mounting scope.
 * @param ctx - context owning this executor's selection and lifetime.
 */
export function apply(ctx: Context): void {
  ctx.tools.setExecutor(new NativeToolExecutor(ctx))
}
