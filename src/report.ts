import type { JudgeOutcome } from './orchestrator.js';
import type { JudgeReview, Severity, Synthesis } from './schemas.js';

const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];
const VERDICT_LABEL: Record<Synthesis['verdict'], string> = {
  ready: 'Ready',
  ready_with_changes: 'Ready with changes',
  needs_rework: 'Needs rework',
};

/** Mean of applicable (non-null) criterion scores, computed here rather than trusted from the model. */
export function judgeScore(review: JudgeReview): number | undefined {
  const scores = review.criteria.map((c) => c.score).filter((s): s is number => s !== null);
  if (scores.length === 0) return undefined;
  return scores.reduce((sum, s) => sum + s, 0) / scores.length;
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const fmt = (score: number | undefined): string => (score === undefined ? 'n/a' : score.toFixed(1));

export function renderReport(opts: {
  documentName: string;
  draftName: string;
  outcomes: JudgeOutcome[];
  synthesis: Synthesis;
  generatedAt: Date;
}): string {
  const { documentName, draftName, outcomes, synthesis, generatedAt } = opts;
  const reviewed = outcomes.filter((o): o is JudgeOutcome & { review: JudgeReview } => !!o.review);
  const findings = reviewed.flatMap((o) => o.review.findings.map((f) => ({ ...f, judgeName: o.judge.name })));
  const counts = SEVERITY_ORDER.map((s) => `${findings.filter((f) => f.severity === s).length} ${s}`).join(', ');
  const applied = new Set(synthesis.appliedChanges.flatMap((c) => c.findingIds));
  const deferred = new Map(synthesis.deferredFindings.map((d) => [d.findingId, d.reason]));

  const lines: string[] = [
    `# Well-Architected review: ${documentName}`,
    '',
    `**Verdict:** ${VERDICT_LABEL[synthesis.verdict]} | **Findings:** ${counts} | **Revised draft:** \`${draftName}\` | **Generated:** ${generatedAt.toISOString()}`,
    '',
    '## Summary',
    '',
    synthesis.executiveSummary,
    '',
    '## Scores by judge',
    '',
    'Mean of applicable rubric criteria, out of 10.',
    '',
    '| Judge | Score | Findings | Summary |',
    '|---|---|---|---|',
    ...outcomes.map((o) =>
      o.review
        ? `| ${o.judge.name} | ${fmt(judgeScore(o.review))} | ${o.review.findings.length} | ${cell(o.review.summary)} |`
        : `| ${o.judge.name} | not reviewed | - | Judge failed: ${cell(o.error ?? 'unknown error')} |`,
    ),
    '',
  ];

  if (synthesis.crossCuttingThemes.length > 0) {
    lines.push('## Cross-cutting themes', '', ...synthesis.crossCuttingThemes.map((t) => `- ${t}`), '');
  }

  if (synthesis.conflicts.length > 0) {
    lines.push('## Conflicts between judges', '');
    for (const c of synthesis.conflicts) {
      lines.push(`- **${c.findingIds.join(', ')}:** ${c.description} *Resolution:* ${c.resolution}`);
    }
    lines.push('');
  }

  lines.push('## Findings', '', '| ID | Severity | Judge | Finding | Status |', '|---|---|---|---|---|');
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
  for (const f of sorted) {
    const status = applied.has(f.id) ? 'Applied' : deferred.has(f.id) ? `Deferred: ${deferred.get(f.id)}` : 'Not addressed';
    lines.push(`| ${f.id} | ${f.severity} | ${f.judgeName} | ${cell(f.title)} | ${cell(status)} |`);
  }
  lines.push('');

  lines.push('## Changes applied in the revised draft', '');
  if (synthesis.appliedChanges.length === 0) lines.push('None.');
  for (const c of synthesis.appliedChanges) {
    lines.push(`- **${c.section}** (${c.findingIds.join(', ')}): ${c.description}`);
  }
  lines.push('');

  lines.push('## Detail by judge', '');
  for (const o of reviewed) {
    lines.push(`### ${o.judge.name}`, '', o.review.summary, '');
    if (o.review.strengths.length > 0) {
      lines.push('**Strengths**', '', ...o.review.strengths.map((s) => `- ${s}`), '');
    }
    lines.push('| Criterion | Score | Evidence | Rationale |', '|---|---|---|---|');
    for (const c of o.review.criteria) {
      lines.push(`| ${cell(c.criterion)} | ${c.score === null ? 'n/a' : `${c.score}/10`} | ${cell(c.evidence)} | ${cell(c.rationale)} |`);
    }
    lines.push('');
    for (const f of o.review.findings) {
      lines.push(
        `**${f.id} (${f.severity}): ${f.title}**`,
        '',
        `- *Criterion:* ${f.criterion}`,
        `- *Evidence:* ${f.evidence}`,
        `- *Recommendation:* ${f.recommendation}`,
        `- *Section:* ${f.section}`,
        '',
      );
    }
  }

  return lines.join('\n');
}
