#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  buildHumanReviewInbox,
  reportCommand,
  reviewCommand,
} from '../.codex/delivery-kit/cli.mjs';
import {
  createInitialState,
  now,
  runPaths,
  saveState,
} from '../.codex/delivery-kit/lib/core.mjs';
import { git } from '../.codex/delivery-kit/lib/git.mjs';
import { repairPlanPrompt } from '../.codex/delivery-kit/lib/prompts.mjs';
import { renderProgressLine } from '../.codex/delivery-kit/lib/progress.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-delivery-review-smoke-'));
const repo = path.join(temp, 'repo');
const runId = 'review-smoke-run';

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function outputCollector() {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
}

await mkdir(path.join(repo, 'src'), { recursive: true });
await writeFile(path.join(repo, 'src', 'a.txt'), 'initial\n');
await git(repo, ['init', '-b', 'main']);
await git(repo, ['config', 'user.email', 'review-smoke@example.com']);
await git(repo, ['config', 'user.name', 'Review Smoke']);
await git(repo, ['add', '--all']);
await git(repo, ['commit', '-m', 'initial']);
const baseCommit = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

const state = createInitialState({
  runId,
  objective: 'Review smoke blocked delivery',
  repoRoot: repo,
  baseRef: 'main',
  baseCommit,
  maxRepairs: 2,
});
state.phase = 'blocked';
state.finishedAt = now();
state.repairIteration = 2;
state.acceptanceCriteria = [
  { id: 'AC-1', text: 'Backend behavior is implemented.' },
  { id: 'AC-2', text: 'Regression coverage exists.' },
];
state.integration = {
  branch: 'codex-delivery-integration/review-smoke-run/integration',
  worktreePath: repo,
  commit: baseCommit,
  attempts: [],
};
state.validation = {
  commands: ['python -m pytest tests/contracts', 'docker compose up --build'],
  runs: [
    {
      command: 'python -m pytest tests/contracts',
      ok: false,
      exitCode: 1,
      durationMs: 51,
      logPath: `.codex/delivery-runs/${runId}/commands/validation-01.log`,
    },
    {
      command: 'docker compose up --build',
      ok: false,
      exitCode: null,
      durationMs: 0,
      logPath: `.codex/delivery-runs/${runId}/commands/validation-02.log`,
      error: 'Command rejected by validation allowlist.',
    },
  ],
};
state.verification = {
  verdict: 'failed',
  summary: 'Criteria are not proven.',
  criteria: [
    { id: 'AC-1', status: 'failed', evidence: ['src/a.txt still has initial marker'], paths: ['src/a.txt'], commands: ['node scripts/check.mjs'] },
    { id: 'AC-2', status: 'unknown', evidence: ['No regression test was observed'], paths: [], commands: [] },
  ],
  failedCommands: [],
  residualRisks: [],
};
state.reviews = [
  {
    role: 'reviewer',
    verdict: 'changes_requested',
    summary: 'Behavior is incomplete.',
    findings: [
      {
        severity: 'high',
        title: 'Missing behavior',
        summary: 'The expected marker is not written.',
        paths: ['src/a.txt'],
        criterionIds: ['AC-1'],
        reproduction: ['Read src/a.txt'],
        recommendation: 'Write the expected marker and add coverage.',
      },
    ],
    positiveEvidence: [],
  },
  {
    role: 'security',
    verdict: 'approved',
    summary: 'No material security findings.',
    findings: [
      { severity: 'low', title: 'Style note', summary: 'Non-blocking.', paths: [], criterionIds: [], reproduction: [], recommendation: 'Optional.' },
    ],
    positiveEvidence: [],
  },
];
state.final = {
  status: 'blocked',
  summary: 'Quality gate failed after 2 repair iteration(s). Human review is required.',
  runId,
  integrationBranch: state.integration.branch,
  integrationCommit: state.integration.commit,
  integrationWorktree: state.integration.worktreePath,
  gate: null,
  finishedAt: now(),
};

await mkdir(path.join(repo, '.codex', 'delivery-runs'), { recursive: true });
await mkdir(path.join(repo, '.codex', 'delivery-runs', runId, 'commands'), { recursive: true });
await writeFile(path.join(repo, '.codex', 'delivery-runs', 'latest'), `${runId}\n`, 'utf8');
await writeFile(path.join(repo, '.codex', 'delivery-runs', runId, 'commands', 'validation-01.log'), 'No module named pytest\n', 'utf8');
await writeFile(path.join(repo, '.codex', 'delivery-runs', runId, 'commands', 'validation-02.log'), 'Command rejected by validation allowlist.\n', 'utf8');
await saveState(repo, state);

const inbox = await buildHumanReviewInbox(repo, state);
assert.equal(inbox.counts.total, 5);
assert.equal(inbox.counts.validation, 2);
assert.equal(inbox.counts.criteria, 2);
assert.equal(inbox.counts.findings, 1);
assert.equal(inbox.items.find((item) => item.command === 'python -m pytest tests/contracts').defaultDecision, 'environment_required');
assert.equal(inbox.items.find((item) => item.command === 'docker compose up --build').defaultDecision, 'repair_requested');
assert.deepEqual(inbox.items.filter((item) => item.type === 'criterion').map((item) => item.id), ['AC-1', 'AC-2']);
assert.ok(inbox.items.some((item) => /^F-reviewer-[a-f0-9]+$/.test(item.id)));

const prompt = repairPlanPrompt({
  objective: 'Review smoke blocked delivery',
  criteria: state.acceptanceCriteria,
  verification: { failedCriteria: state.verification.criteria, failedCommands: state.validation.runs },
  reviews: state.reviews,
  humanReview: { reviewId: 'HR-test', repairRequests: [{ itemId: 'AC-1', note: 'Focus on backend marker.' }] },
  iteration: 3,
  maxParallel: 2,
});
assert.match(prompt, /Human review repair requests/);
assert.match(prompt, /Focus on backend marker/);

const jsonOutput = outputCollector();
await reviewCommand({ repo, run: runId, json: true, _: [] }, { outputStream: jsonOutput.stream });
const jsonInbox = JSON.parse(jsonOutput.text());
assert.equal(jsonInbox.counts.total, 5);
assert.equal(await exists(path.join(repo, '.codex', 'delivery-runs', runId, 'human-reviews.jsonl')), false);

const input = [
  '',
  'Install pytest before resume.',
  '',
  'Allow docker compose config only.',
  'manual_required',
  'Needs product owner confirmation.',
  'a',
  '',
  'r',
  'Fix the missing behavior.',
  '',
].join('\n');
const reviewedOutput = outputCollector();
await reviewCommand({ repo, run: runId, _: [] }, {
  inputStream: Readable.from([input]),
  outputStream: reviewedOutput.stream,
});
assert.match(reviewedOutput.text(), /Human review saved/);
assert.match(reviewedOutput.text(), /resume --run review-smoke-run --max-repairs 3 --background/);
const saved = JSON.parse(await readFile(runPaths(repo, runId).state, 'utf8'));
assert.equal(saved.humanReviews.length, 1);
assert.equal(saved.humanReviews[0].counts.byDecision.repair_requested, 2);
assert.equal(saved.humanReviews[0].counts.byDecision.environment_required, 1);
assert.equal(saved.humanReviews[0].counts.byDecision.manual_required, 1);
assert.equal(saved.humanReviews[0].counts.byDecision.acknowledged, 1);
assert.equal(saved.humanReviews[0].repairContext.repairRequests.length, 2);
assert.ok(saved.humanReviews[0].repairContext.repairRequests.some((item) => item.note === 'Allow docker compose config only.'));
assert.ok(await exists(path.join(repo, '.codex', 'delivery-runs', runId, 'human-reviews.jsonl')));
assert.ok(await exists(path.join(repo, saved.humanReviews[0].artifactPath)));
const summary = await readFile(runPaths(repo, runId).summary, 'utf8');
assert.match(summary, /## Human reviews/);
assert.match(summary, /HR-/);
const events = (await readFile(runPaths(repo, runId).events, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.match(renderProgressLine(events.at(-1), { repo }), /\[human-review\] recorded/);

const reportOutput = outputCollector();
await reportCommand({ repo, run: runId, _: [] }, { outputStream: reportOutput.stream });
assert.equal(JSON.parse(reportOutput.text()).humanReviews.length, 1);

const activeRunId = 'review-active-run';
const active = createInitialState({
  runId: activeRunId,
  objective: 'Active run review smoke',
  repoRoot: repo,
  baseRef: 'main',
  baseCommit,
});
active.phase = 'implementation';
active.acceptanceCriteria = [{ id: 'AC-1', text: 'Active criterion.' }];
active.validation = { commands: [], runs: [] };
await saveState(repo, active);
const activeOutput = outputCollector();
await reviewCommand({ repo, run: activeRunId, json: true, _: [] }, { outputStream: activeOutput.stream });
assert.equal(JSON.parse(activeOutput.text()).phase, 'implementation');
let activeError = null;
try {
  await reviewCommand({ repo, run: activeRunId, _: [] }, {
    inputStream: Readable.from(['']),
    outputStream: outputCollector().stream,
  });
} catch (error) {
  activeError = error;
}
assert.match(activeError?.message ?? '', /blocked or failed runs/);

console.log('review-smoke: OK');
