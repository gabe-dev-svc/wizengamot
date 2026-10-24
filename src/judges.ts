import { Agent, TextBlock, type Model } from '@strands-agents/sdk';
import {
  Node,
  type MultiAgentInput,
  type MultiAgentState,
  type MultiAgentStreamEvent,
  type NodeInputOptions,
  type NodeResultUpdate,
} from '@strands-agents/sdk/multiagent';

import { callSignal } from './config.js';
import { findingPrefix, type JudgeDefinition } from './judge-config.js';
import { JudgeReview } from './schemas.js';

// Strands asks for structured output with `auto` tool choice first and only forces the tool
// if the model answers in plain text. Claude Opus 5.5 rejects forced tool choice, so the
// prompt has to make the first attempt land.
const OUTPUT_INSTRUCTION =
  'Return your review only by calling the `strands_structured_output` tool exactly once. ' +
  'Do not reply with plain text.';

function rubricText(judge: JudgeDefinition): string {
  return judge.rubric
    .map((c, i) => [
      `${i + 1}. ${c.name}: ${c.description}`,
      `   - 1: ${c.anchors['1']}`,
      `   - 5: ${c.anchors['5']}`,
      `   - 10: ${c.anchors['10']}`,
    ].join('\n'))
    .join('\n');
}

/** The judge's own prompt from config, followed by the shared review harness. */
export function judgePrompt(judge: JudgeDefinition): string {
  return `${judge.prompt}

You are the ${judge.name} judge on a design review panel. Other judges cover other areas, so review only yours.
You will be given a software design document. Grade it against every criterion in your rubric.

Rubric:
${rubricText(judge)}

Scoring:
- Grade each criterion from 1 to 10. The anchors describe what a 1, a 5 and a 10 look like; place the document between them (2-4 sits between the 1 and 5 anchors, 6-9 between the 5 and 10 anchors).
- Use null only when the criterion genuinely cannot apply to what this document proposes, and say why in the rationale. Do not use null for something the document should cover but doesn't; that is a low score.
- Judge the design as written. Do not assume the authors will do something the document doesn't say.
- Back every score with evidence: quote or name the section. If nothing in the document addresses it, write "Not addressed".

Findings:
- Each finding must be specific enough that an editor could apply it to the document without asking you a follow-up question. Name the section it belongs in.
- Severity: critical = likely outage, breach or failed project; high = significant risk that should block approval; medium = should fix before implementation; low = improvement.
- Number finding IDs ${findingPrefix(judge)}-1, ${findingPrefix(judge)}-2, and so on.
- List strengths too. A review that only lists problems is less useful to the authors.

${OUTPUT_INSTRUCTION}`;
}

export function judgeNodeId(judge: JudgeDefinition): string {
  return `judge-${judge.id}`;
}

const JUDGE_ERROR_PREFIX = 'JUDGE_FAILED: ';

/**
 * Runs one judge. It never ends FAILED: the graph only starts a node once every
 * upstream node is COMPLETED, so one failed judge would otherwise block the orchestrator.
 * After one retry it completes with no structured output and the error as its text.
 */
export class JudgeNode extends Node {
  private readonly judge: JudgeDefinition;
  private readonly model: () => Model;

  constructor(judge: JudgeDefinition, model: () => Model) {
    super(judgeNodeId(judge), { description: `${judge.name} judge` });
    this.judge = judge;
    this.model = model;
  }

  async *handle(
    input: MultiAgentInput,
    _state: MultiAgentState,
    options?: NodeInputOptions,
  ): AsyncGenerator<MultiAgentStreamEvent, NodeResultUpdate, undefined> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (options?.cancelSignal?.aborted) break;
      const agent = new Agent({
        id: this.id,
        name: `${this.judge.name} judge`,
        model: this.model(),
        systemPrompt: judgePrompt(this.judge),
        printer: false,
      });
      try {
        const result = await agent.invoke(input, {
          structuredOutputSchema: JudgeReview,
          cancelSignal: callSignal(options?.cancelSignal),
        });
        return {
          content: result.lastMessage.content,
          structuredOutput: result.structuredOutput,
          ...(result.metrics?.accumulatedUsage && { usage: result.metrics.accumulatedUsage }),
        };
      } catch (error) {
        lastError = error;
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'cancelled');
    return { content: [new TextBlock(JUDGE_ERROR_PREFIX + message)] };
  }
}

/** The error a JudgeNode recorded, if it gave up. */
export function judgeError(content: readonly { type: string }[]): string | undefined {
  for (const block of content) {
    if (block instanceof TextBlock && block.text.startsWith(JUDGE_ERROR_PREFIX)) {
      return block.text.slice(JUDGE_ERROR_PREFIX.length);
    }
  }
  return undefined;
}
