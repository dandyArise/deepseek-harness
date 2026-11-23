/** Smaller model-facing annotations; validation keeps the original schema. */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

type Schema = Pick<ToolDefinition, 'name' | 'description' | 'parameters'>

/**
 * Estimate serialized tool-definition cost using four characters per token.
 * @param tools - model-facing definitions to measure.
 * @returns rounded-up heuristic token count, not a tokenizer guarantee.
 */
export function definitionTokens(tools: readonly Schema[]): number {
  return Math.ceil(JSON.stringify(tools).length / 4)
}

function compactSchema(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const result: Record<string, unknown> = { ...value }
  delete result.description
  delete result.title
  delete result.examples
  for (const key of ['properties', 'patternProperties', '$defs', 'definitions']) {
    const map = result[key]
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      result[key] = Object.fromEntries(Object.entries(map).map(([name, schema]) => [name, compactSchema(schema)]))
    }
  }
  for (const key of ['items', 'additionalProperties', 'contains', 'not', 'if', 'then', 'else']) {
    if (key in result) result[key] = compactSchema(result[key])
  }
  for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    if (Array.isArray(result[key])) result[key] = result[key].map(compactSchema)
  }
  return result
}

/**
 * Shorten model-facing annotations while retaining schema validation constraints.
 * @param tool - original definition, left unchanged for execution validation.
 * @returns a compact copy with a bounded description.
 */
export function compactDefinition(tool: Schema): Schema {
  return { ...tool, description: tool.description.slice(0, 180), parameters: compactSchema(tool.parameters) as Schema['parameters'] }
}
