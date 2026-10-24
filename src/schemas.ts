import { z } from 'zod';

export const Severity = z.enum(['critical', 'high', 'medium', 'low']);
export type Severity = z.infer<typeof Severity>;

export const CriterionScore = z.object({
  criterion: z.string().describe('The criterion name, exactly as given in the rubric.'),
  score: z
    .number()
    .int()
    .min(1)
    .max(10)
    .nullable()
    .describe('1-10 against the criterion\'s anchors, or null if the criterion does not apply to this document.'),
  evidence: z.string().describe('A short quote or section reference from the document, or "Not addressed".'),
  rationale: z.string().describe('Why this score, in one to three sentences.'),
});

export const Finding = z.object({
  id: z.string().describe('Stable ID: the judge\'s finding prefix plus a number, e.g. "SEC-1".'),
  severity: Severity,
  criterion: z.string().describe('The rubric criterion this finding relates to.'),
  title: z.string(),
  evidence: z.string().describe('What the document says (or omits) that causes the issue.'),
  recommendation: z.string().describe('What should change, concretely.'),
  section: z.string().describe('The document section the change belongs in, or "New section: <name>".'),
});

export const JudgeReview = z.object({
  judge: z.string().describe('The judge\'s name.'),
  summary: z.string().describe('Two to four sentences: overall assessment from this judge.'),
  criteria: z.array(CriterionScore).describe('One entry per rubric criterion, in rubric order.'),
  findings: z.array(Finding).describe('Concrete issues, most severe first. Empty if none.'),
  strengths: z.array(z.string()).describe('What the document already does well in this judge\'s area.'),
});
export type JudgeReview = z.infer<typeof JudgeReview>;

export const Synthesis = z.object({
  verdict: z.enum(['ready', 'ready_with_changes', 'needs_rework']),
  executiveSummary: z.string().describe('One paragraph for the document owner.'),
  crossCuttingThemes: z.array(z.string()).describe('Issues raised by more than one judge.'),
  conflicts: z.array(z.object({
    findingIds: z.array(z.string()),
    description: z.string(),
    resolution: z.string().describe('How the revised draft resolves the tension.'),
  })),
  appliedChanges: z.array(z.object({
    findingIds: z.array(z.string()),
    section: z.string(),
    description: z.string().describe('What was changed in the revised draft.'),
  })),
  deferredFindings: z.array(z.object({
    findingId: z.string(),
    reason: z.string().describe('Why it was not applied, e.g. needs a decision from the owner or more information.'),
  })),
  revisedDocument: z.string().describe('The complete revised design document in Markdown.'),
});
export type Synthesis = z.infer<typeof Synthesis>;
