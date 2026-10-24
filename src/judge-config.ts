import { readFile } from 'node:fs/promises';

import { z } from 'zod';

/**
 * Judge definitions loaded from JSON (default: config/judges.json).
 *
 * Each judge has a name, its own prompt, and a rubric. Every rubric criterion is graded 1-10,
 * and must describe what a 1, a 5 and a 10 look like; judges interpolate between those anchors.
 */

const Slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase words separated by hyphens, e.g. "cost-optimization"');

export const Criterion = z.object({
  name: z.string().min(1).describe('Short name of what is graded, e.g. "Protect data in transit and at rest".'),
  description: z.string().min(1).describe('What this criterion measures in a design document.'),
  anchors: z
    .object({
      '1': z.string().min(1).describe('What a document scoring 1 looks like for this criterion.'),
      '5': z.string().min(1).describe('What a document scoring 5 looks like.'),
      '10': z.string().min(1).describe('What a document scoring 10 looks like.'),
    })
    .strict()
    .describe('Required anchor descriptions for grades 1, 5 and 10. Judges interpolate the grades in between.'),
}).strict();
export type Criterion = z.infer<typeof Criterion>;

export const JudgeDefinition = z.object({
  id: Slug.describe('Unique judge ID; used for the graph node ID and on the command line (--only).'),
  name: z.string().min(1).describe('Display name, e.g. "Security".'),
  findingPrefix: z
    .string()
    .regex(/^[A-Z][A-Z0-9]*$/, 'uppercase letters and digits, e.g. "SEC"')
    .optional()
    .describe('Prefix for this judge\'s finding IDs, e.g. "SEC" gives SEC-1, SEC-2. Defaults to the uppercased ID.'),
  prompt: z
    .string()
    .min(1)
    .describe('The judge\'s own instructions: role, focus and anything specific to this area. The harness appends the rubric, scoring rules and output format.'),
  rubric: z.array(Criterion).min(1).describe('Criteria this judge grades, each 1-10.'),
}).strict();
export type JudgeDefinition = z.infer<typeof JudgeDefinition>;

export const JudgesFile = z
  .object({
    $schema: z.string().optional(),
    judges: z.array(JudgeDefinition).min(1),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.judges.forEach((judge, i) => {
      if (seen.has(judge.id)) {
        ctx.addIssue({ code: 'custom', path: ['judges', i, 'id'], message: `duplicate judge id "${judge.id}"` });
      }
      seen.add(judge.id);
      const names = new Set<string>();
      judge.rubric.forEach((criterion, j) => {
        if (names.has(criterion.name)) {
          ctx.addIssue({ code: 'custom', path: ['judges', i, 'rubric', j, 'name'], message: `duplicate criterion "${criterion.name}" in judge "${judge.id}"` });
        }
        names.add(criterion.name);
      });
    });
  });
export type JudgesFile = z.infer<typeof JudgesFile>;

export const DEFAULT_JUDGES_PATH = new URL('../config/judges.json', import.meta.url);

export function parseJudges(raw: unknown, source = 'judges config'): JudgeDefinition[] {
  const parsed = JudgesFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${source}:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data.judges;
}

export async function loadJudges(path: string | URL = DEFAULT_JUDGES_PATH): Promise<JudgeDefinition[]> {
  const text = await readFile(path, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${String(path)} is not valid JSON: ${(error as Error).message}`);
  }
  return parseJudges(raw, String(path));
}

export function findingPrefix(judge: JudgeDefinition): string {
  return judge.findingPrefix ?? judge.id.toUpperCase().replace(/-/g, '');
}
