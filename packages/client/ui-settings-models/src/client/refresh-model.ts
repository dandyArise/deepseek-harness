import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * Refresh the reported facts for one retained model, preserving durable human and protocol evidence.
 * @param model - retained model configuration with optional manual overrides and verification.
 * @param candidate - current discovery result, if the endpoint still advertises this model.
 * @returns updated metadata, or the original configuration when no metadata was discovered.
 */
export function refreshModel(model: Record<string, unknown>, candidate: LlmDiscoveredModel | undefined): Record<string, unknown> {
  if (candidate?.lmStudio === undefined) return model
  const previous = model.lmStudio as LlmDiscoveredModel['lmStudio']
  return { ...model, lmStudio: {
    ...candidate.lmStudio,
    ...previous?.overrides === undefined ? {} : { overrides: previous.overrides },
    ...previous?.verification === undefined ? {} : { verification: previous.verification },
  } }
}
