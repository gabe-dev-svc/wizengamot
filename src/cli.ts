import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { config } from './config.js';
import { buildReviewGraph, reviewTask } from './graph.js';
import { DEFAULT_JUDGES_PATH, loadJudges } from './judge-config.js';
import { ORCHESTRATOR_NODE_ID, collectJudgeOutcomes } from './orchestrator.js';
import { renderReport } from './report.js';
import { Synthesis } from './schemas.js';

const USAGE = `Usage: npm run review -- <design-doc.md> [options]

Options:
  --judges <file>        Judge definitions (default: config/judges.json)
  --only <id,id>         Run only these judge IDs
  --out <dir>            Output directory (default: ./output)
  --concurrency <n>      Judges run in parallel (default: 6)

Writes <dir>/<name>.review.md (the report) and <dir>/<name>.draft-2.md (the revised draft).`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', default: 'output' },
      judges: { type: 'string' },
      only: { type: 'string' },
      concurrency: { type: 'string', default: '6' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const docPath = positionals[0];
  if (values.help || !docPath) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const allJudges = await loadJudges(values.judges ?? DEFAULT_JUDGES_PATH);
  const wanted = values.only?.split(',').map((id) => id.trim());
  const unknown = wanted?.filter((id) => !allJudges.some((j) => j.id === id)) ?? [];
  if (unknown.length > 0) {
    console.error(`Unknown judge id(s): ${unknown.join(', ')}. Available: ${allJudges.map((j) => j.id).join(', ')}`);
    return 1;
  }
  const judges = wanted ? allJudges.filter((j) => wanted.includes(j.id)) : allJudges;

  const document = await readFile(docPath, 'utf8');
  const name = path.basename(docPath, path.extname(docPath));
  console.log(`Reviewing ${docPath} with ${judges.length} judges (judge model ${config.judgeModelId}, orchestrator ${config.orchestratorModelId})`);

  const graph = buildReviewGraph(document, judges, { maxConcurrency: Number(values.concurrency) });
  const stream = graph.stream(reviewTask(document));
  let step = await stream.next();
  while (!step.done) {
    const event = step.value;
    if (event.type === 'beforeNodeCallEvent') console.log(`  started   ${event.nodeId}`);
    if (event.type === 'nodeResultEvent') {
      console.log(`  finished  ${event.nodeId} (${event.result.status}, ${(event.result.duration / 1000).toFixed(0)}s)`);
    }
    step = await stream.next();
  }
  const result = step.value;

  const orchestrator = result.results.find((r) => r.nodeId === ORCHESTRATOR_NODE_ID);
  const synthesis = Synthesis.safeParse(orchestrator?.structuredOutput);
  if (!synthesis.success) {
    console.error(`Orchestrator did not produce a synthesis: ${orchestrator?.error?.message ?? synthesis.error.message}`);
    return 1;
  }

  const outcomes = collectJudgeOutcomes((id) => result.results.findLast((r) => r.nodeId === id), judges);

  await mkdir(values.out, { recursive: true });
  const draftName = `${name}.draft-2.md`;
  const reportPath = path.join(values.out, `${name}.review.md`);
  await writeFile(path.join(values.out, draftName), synthesis.data.revisedDocument);
  await writeFile(
    reportPath,
    renderReport({ documentName: path.basename(docPath), draftName, outcomes, synthesis: synthesis.data, generatedAt: new Date() }),
  );

  const failed = outcomes.filter((o) => o.error);
  console.log(`\nVerdict: ${synthesis.data.verdict}`);
  console.log(`Report: ${reportPath}`);
  console.log(`Revised draft: ${path.join(values.out, draftName)}`);
  console.log(`Tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
  if (failed.length > 0) console.warn(`Warning: ${failed.length} judge(s) failed: ${failed.map((o) => o.judge.id).join(', ')}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // Config and usage errors read better without a stack trace; WAR_DEBUG=1 shows it.
    console.error(process.env.WAR_DEBUG || !(error instanceof Error) ? error : `Error: ${error.message}`);
    process.exit(1);
  },
);
