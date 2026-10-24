import { Agent, type Model } from '@strands-agents/sdk';
import {
  Node,
  Status,
  type MultiAgentInput,
  type MultiAgentState,
  type MultiAgentStreamEvent,
  type NodeInputOptions,
  type NodeResult,
  type NodeResultUpdate,
} from '@strands-agents/sdk/multiagent';

import { callSignal } from './config.js';
import { judgeError, judgeNodeId } from './judges.js';
import type { JudgeDefinition } from './judge-config.js';
import { JudgeReview, Synthesis } from './schemas.js';

export const ORCHESTRATOR_NODE_ID = 'orchestrator';

const SYSTEM_PROMPT = `You lead a design review panel.
Each judge has reviewed the same design document for one area, scored it 1-10 against their rubric, and returned structured findings.
Your job is to reconcile their reviews and produce a revised draft of the document.

How to work:
- Read every judge's findings. Where several judges raise the same underlying issue, treat it as one cross-cutting theme.
- Where findings conflict (for example, a security control that adds cost or latency), decide how the revised draft resolves the tension and say why.
- Apply every critical, high and medium finding you can apply from the information in the document. Apply low findings when the change is small.
- Defer a finding instead of inventing facts. If applying it needs a decision or information only the authors have (a budget, an SLA, a vendor choice), add a clearly marked "Open question" in the relevant section and list the finding as deferred with the reason.
- Preserve the authors' voice, structure and every correct detail. Change what the findings call for, not what you would personally prefer.
- The revised document must be complete Markdown, not a diff or a summary. Add a short "Revision notes" section at the end listing what changed and which finding IDs drove each change.
- Verdict: "ready" if no critical or high findings remain open, "ready_with_changes" if remaining issues are resolved in this draft or are minor, "needs_rework" if critical issues need decisions from the authors.

Return your result only by calling the \`strands_structured_output\` tool exactly once. Do not reply with plain text.`;

export interface JudgeOutcome {
  judge: JudgeDefinition;
  review?: JudgeReview;
  error?: string;
}

/**
 * Reads each judge's typed review from its node result rather than from forwarded text.
 * `latestResult` looks up a node's most recent result (from graph state, or a finished run).
 */
export function collectJudgeOutcomes(
  latestResult: (nodeId: string) => NodeResult | undefined,
  judges: JudgeDefinition[],
): JudgeOutcome[] {
  return judges.map((judge) => {
    const result = latestResult(judgeNodeId(judge));
    if (!result || result.status !== Status.COMPLETED) {
      return { judge, error: result?.error?.message ?? `judge finished with status ${result?.status ?? 'unknown'}` };
    }
    const failure = judgeError(result.content);
    if (failure) return { judge, error: failure };
    const parsed = JudgeReview.safeParse(result.structuredOutput);
    return parsed.success ? { judge, review: parsed.data } : { judge, error: 'judge returned no valid structured review' };
  });
}

/**
 * The graph's sink node. A custom Node (instead of an AgentNode) so it can read the judges'
 * structured output directly, and still run when a judge fails.
 */
export class OrchestratorNode extends Node {
  private readonly document: string;
  private readonly judges: JudgeDefinition[];
  private readonly model: () => Model;

  constructor(document: string, judges: JudgeDefinition[], model: () => Model) {
    super(ORCHESTRATOR_NODE_ID, { description: 'Reconciles judge reviews and writes the revised draft.' });
    this.document = document;
    this.judges = judges;
    this.model = model;
  }

  async *handle(
    _input: MultiAgentInput,
    state: MultiAgentState,
    options?: NodeInputOptions,
  ): AsyncGenerator<MultiAgentStreamEvent, NodeResultUpdate, undefined> {
    const outcomes = collectJudgeOutcomes((id) => state.node(id)?.results.at(-1), this.judges);
    const reviews = outcomes.filter((o) => o.review).map((o) => o.review);
    const missing = outcomes.filter((o) => o.error).map((o) => `${o.judge.name}: ${o.error}`);
    if (reviews.length === 0) {
      throw new Error(`No judge produced a review:\n${missing.join('\n')}`);
    }

    const prompt = [
      '<design_document>',
      this.document,
      '</design_document>',
      '',
      '<judge_reviews>',
      JSON.stringify(reviews, null, 2),
      '</judge_reviews>',
      missing.length > 0
        ? `\nThese judges produced no review because they failed. Do not invent findings for their areas:\n${missing.join('\n')}`
        : '',
    ].join('\n');

    const agent = new Agent({
      id: ORCHESTRATOR_NODE_ID,
      name: 'Review orchestrator',
      model: this.model(),
      systemPrompt: SYSTEM_PROMPT,
      printer: false,
    });
    const result = await agent.invoke(prompt, {
      structuredOutputSchema: Synthesis,
      cancelSignal: callSignal(options?.cancelSignal),
    });

    return {
      content: result.lastMessage.content,
      structuredOutput: result.structuredOutput,
      ...(result.metrics?.accumulatedUsage && { usage: result.metrics.accumulatedUsage }),
    };
  }
}
