import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadJudges, parseJudges } from '../src/judge-config.js';
import { judgePrompt } from '../src/judges.js';

const criterion = { name: 'Encryption', description: 'Data is encrypted.', anchors: { '1': 'None.', '5': 'Partial.', '10': 'Full.' } };
const judge = { id: 'security', name: 'Security', prompt: 'You review security.', rubric: [criterion] };

test('the default config loads and every criterion has 1/5/10 anchors', async () => {
  const judges = await loadJudges();
  assert.equal(judges.length, 6);
  for (const j of judges) {
    for (const c of j.rubric) assert.ok(c.anchors['1'] && c.anchors['5'] && c.anchors['10'], `${j.id}: ${c.name}`);
  }
});

test('the judge prompt starts with the configured prompt and includes the anchors', () => {
  const [parsed] = parseJudges({ judges: [judge] });
  const prompt = judgePrompt(parsed!);
  assert.ok(prompt.startsWith('You review security.'));
  assert.match(prompt, /1\. Encryption: Data is encrypted\.\n {3}- 1: None\.\n {3}- 5: Partial\.\n {3}- 10: Full\./);
  assert.match(prompt, /SECURITY-1/);
});

test('rejects a criterion missing an anchor', () => {
  const bad = { ...criterion, anchors: { '1': 'None.', '5': 'Partial.' } };
  assert.throws(() => parseJudges({ judges: [{ ...judge, rubric: [bad] }] }), /anchors/);
});

test('rejects extra anchor grades, so typos are not silently ignored', () => {
  const bad = { ...criterion, anchors: { ...criterion.anchors, '7': 'Mostly.' } };
  assert.throws(() => parseJudges({ judges: [{ ...judge, rubric: [bad] }] }), /7/);
});

test('rejects duplicate judge ids and duplicate criteria', () => {
  assert.throws(() => parseJudges({ judges: [judge, judge] }), /duplicate judge id "security"/);
  assert.throws(() => parseJudges({ judges: [{ ...judge, rubric: [criterion, criterion] }] }), /duplicate criterion "Encryption"/);
});
