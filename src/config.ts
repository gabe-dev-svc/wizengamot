import type { Model } from '@strands-agents/sdk';
import { BedrockModel } from '@strands-agents/sdk/models/bedrock';

/**
 * Model settings, overridable through environment variables.
 *
 * The default is a Bedrock cross-region inference profile for Claude Opus 5.5. Confirm the
 * exact profile ID available in your account and region with:
 *   aws bedrock list-inference-profiles --region us-east-1 --query "inferenceProfileSummaries[].inferenceProfileId"
 */
const DEFAULT_MODEL_ID = 'global.anthropic.claude-opus-5-5';

export const config = {
  region: process.env.AWS_REGION ?? 'us-east-1',
  judgeModelId: process.env.WAR_JUDGE_MODEL_ID ?? DEFAULT_MODEL_ID,
  orchestratorModelId: process.env.WAR_ORCHESTRATOR_MODEL_ID ?? DEFAULT_MODEL_ID,
  // Judges write compact JSON; the orchestrator rewrites the whole document, so it needs room.
  judgeMaxTokens: Number(process.env.WAR_JUDGE_MAX_TOKENS ?? 16000),
  orchestratorMaxTokens: Number(process.env.WAR_ORCHESTRATOR_MAX_TOKENS ?? 64000),
  // Per-model-call wall clock (ms), enforced with an AbortSignal. A long rewrite can take minutes.
  nodeTimeoutMs: Number(process.env.WAR_NODE_TIMEOUT_MS ?? 15 * 60 * 1000),
  // Whole-run wall clock (ms): judges (with one retry each) plus the orchestrator.
  runTimeoutMs: Number(process.env.WAR_RUN_TIMEOUT_MS ?? 60 * 60 * 1000),
};

export function judgeModel(): BedrockModel {
  return new BedrockModel({ region: config.region, modelId: config.judgeModelId, maxTokens: config.judgeMaxTokens });
}

export function orchestratorModel(): BedrockModel {
  return new BedrockModel({
    region: config.region,
    modelId: config.orchestratorModelId,
    maxTokens: config.orchestratorMaxTokens,
  });
}

/** Builds a fresh model per agent. Injectable so tests can run the graph without Bedrock. */
export interface ModelFactories {
  judge: () => Model;
  orchestrator: () => Model;
}

export const bedrockModels: ModelFactories = { judge: judgeModel, orchestrator: orchestratorModel };

/** Cancels at the graph's signal or after the per-call timeout, whichever comes first. */
export function callSignal(graphSignal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(config.nodeTimeoutMs);
  return graphSignal ? AbortSignal.any([graphSignal, timeout]) : timeout;
}
