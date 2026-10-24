import { Graph } from '@strands-agents/sdk/multiagent';

import { bedrockModels, config, type ModelFactories } from './config.js';
import { JudgeNode, judgeNodeId } from './judges.js';
import { ORCHESTRATOR_NODE_ID, OrchestratorNode } from './orchestrator.js';
import type { JudgeDefinition } from './judge-config.js';

/**
 * One node per configured judge (graph sources, run in parallel) fanning in to the orchestrator.
 * The Graph waits for every judge before starting the orchestrator.
 */
export function buildReviewGraph(
  document: string,
  judges: JudgeDefinition[],
  options: { maxConcurrency?: number; models?: ModelFactories } = {},
): Graph {
  const models = options.models ?? bedrockModels;
  return new Graph({
    id: 'design-review',
    nodes: [...judges.map((judge) => new JudgeNode(judge, models.judge)), new OrchestratorNode(document, judges, models.orchestrator)],
    edges: judges.map((judge) => [judgeNodeId(judge), ORCHESTRATOR_NODE_ID] as [string, string]),
    ...(options.maxConcurrency !== undefined && { maxConcurrency: options.maxConcurrency }),
    // The graph is acyclic: every node runs exactly once.
    maxSteps: judges.length + 1,
    timeout: config.runTimeoutMs,
  });
}

export function reviewTask(document: string): string {
  return `Review the following design document.\n\n<design_document>\n${document}\n</design_document>`;
}
