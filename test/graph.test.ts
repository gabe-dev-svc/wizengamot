/**
 * Offline test of the review graph: a fake Model answers every agent through the structured
 * output tool, so the graph wiring, fan-in, failure handling and report rendering run without
 * Bedrock.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Model, type BaseModelConfig, type Message, type ModelStreamEvent } from '@strands-agents/sdk';

import { buildReviewGraph, reviewTask } from '../src/graph.js';
import { loadJudges } from '../src/judge-config.js';
import { ORCHESTRATOR_NODE_ID, collectJudgeOutcomes } from '../src/orchestrator.js';
import { judgeScore, renderReport } from '../src/report.js';
import { Synthesis, type JudgeReview } from '../src/schemas.js';

const JUDGES = await loadJudges();

class FakeModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake' };
  constructor(private readonly reply: () => unknown) {
    super();
  }
  updateConfig(modelConfig: BaseModelConfig): void {
    this.config = modelConfig;
  }
  getConfig(): BaseModelConfig {
    return this.config;
  }
  async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    const answered = messages.at(-1)?.content.some((b) => b.type === 'toolResultBlock');
    if (answered) {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Done.' } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
      return;
    }
    yield {
      type: 'modelContentBlockStartEvent',
      start: { type: 'toolUseStart', name: 'strands_structured_output', toolUseId: `t-${Math.random()}` },
    };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(this.reply()) } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    yield { type: 'modelMetadataEvent', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  }
}

const review = (prefix: string): JudgeReview => ({
  judge: prefix,
  summary: `Summary for ${prefix}.`,
  criteria: [
    { criterion: 'A', score: 8, evidence: 'Section 1', rationale: 'Good.' },
    { criterion: 'B', score: 3, evidence: 'Not addressed', rationale: 'Missing.' },
    { criterion: 'C', score: null, evidence: 'n/a', rationale: 'Out of scope.' },
  ],
  findings: [{
    id: `${prefix}-1`, severity: 'high', criterion: 'B', title: `Fix ${prefix}`,
    evidence: 'Silent on it.', recommendation: 'Add it.', section: 'Design',
  }],
  strengths: ['Clear scope.'],
});

const synthesis: Synthesis = {
  verdict: 'ready_with_changes',
  executiveSummary: 'Mostly sound.',
  crossCuttingThemes: ['Token handling'],
  conflicts: [],
  appliedChanges: [{ findingIds: ['X-1'], section: 'Design', description: 'Added it.' }],
  deferredFindings: [],
  revisedDocument: '# Revised doc\n',
};

test('judges fan in to the orchestrator and the report renders', async () => {
  const judges = JUDGES.slice(0, 3);
  const graph = buildReviewGraph('# Doc', judges, {
    models: { judge: () => new FakeModel(() => review('X')), orchestrator: () => new FakeModel(() => synthesis) },
  });
  const result = await graph.invoke(reviewTask('# Doc'));

  const orchestrator = result.results.find((r) => r.nodeId === ORCHESTRATOR_NODE_ID);
  assert.equal(orchestrator?.status, 'COMPLETED');
  const parsed = Synthesis.parse(orchestrator?.structuredOutput);
  assert.equal(parsed.revisedDocument, '# Revised doc\n');

  const outcomes = collectJudgeOutcomes((id) => result.results.findLast((r) => r.nodeId === id), judges);
  assert.equal(outcomes.filter((o) => o.review).length, 3);
  // Mean of applicable scores (8 and 3); the null (not applicable) is excluded.
  assert.equal(judgeScore(outcomes[0]!.review!), 5.5);

  const report = renderReport({ documentName: 'doc.md', draftName: 'doc.draft-2.md', outcomes, synthesis: parsed, generatedAt: new Date(0) });
  assert.match(report, /\*\*Verdict:\*\* Ready with changes/);
  assert.match(report, /\| X-1 \| high \|/);
  assert.match(report, /\| A \| 8\/10 \|/);
  assert.match(report, /\| C \| n\/a \|/);
});

test('a failing judge does not block the orchestrator', async () => {
  const judges = JUDGES.slice(0, 2);
  let calls = 0;
  const graph = buildReviewGraph('# Doc', judges, {
    maxConcurrency: 1,
    models: {
      // The first judge fails on both attempts; the second succeeds.
      judge: () => new FakeModel(() => {
        calls++;
        if (calls <= 2) throw new Error('throttled');
        return review('Y');
      }),
      orchestrator: () => new FakeModel(() => synthesis),
    },
  });
  const result = await graph.invoke(reviewTask('# Doc'));

  assert.equal(result.results.find((r) => r.nodeId === ORCHESTRATOR_NODE_ID)?.status, 'COMPLETED');
  const outcomes = collectJudgeOutcomes((id) => result.results.findLast((r) => r.nodeId === id), judges);
  assert.match(outcomes[0]!.error ?? '', /throttled/);
  assert.ok(outcomes[1]!.review);

  const report = renderReport({ documentName: 'doc.md', draftName: 'd.md', outcomes, synthesis, generatedAt: new Date(0) });
  assert.match(report, /not reviewed \| - \| Judge failed: .*throttled/);
});
