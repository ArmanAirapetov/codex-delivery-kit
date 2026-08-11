#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  buildHumanReviewInbox,
  reviewCommand,
  statusCommand,
  tuiCommand,
} from '../.codex/delivery-kit/cli.mjs';
import {
  appendEvent,
  createInitialState,
  now,
  runPaths,
  saveState,
} from '../.codex/delivery-kit/lib/core.mjs';
import { git } from '../.codex/delivery-kit/lib/git.mjs';
import {
  applyTuiKey,
  createTuiModel,
  renderTuiScreen,
  reviewDecisionCounts,
  stripAnsi,
} from '../.codex/delivery-kit/lib/tui.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-delivery-tui-smoke-'));
const repo = path.join(temp, 'repo');
const runId = 'tui-smoke-run';

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

class TtyInput extends PassThrough {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
    this.rawModeChanges = [];
  }

  setRawMode(value) {
    this.isRaw = Boolean(value);
    this.rawModeChanges.push(this.isRaw);
    return this;
  }
}

function ttyOutputCollector({ columns = 110, rows = 34 } = {}) {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  stream.isTTY = true;
  stream.columns = columns;
  stream.rows = rows;
  return { stream, text: () => text };
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

async function driveTui(command, keys) {
  const input = new TtyInput();
  const output = ttyOutputCollector();
  const promise = command({ input, output: output.stream });
  await delay(50);
  for (const entry of keys) {
    const key = typeof entry === 'string' ? entry : entry.key;
    const wait = typeof entry === 'string' ? 25 : entry.wait ?? 25;
    input.write(key);
    await delay(wait);
  }
  const result = await promise;
  return { result, input, output: output.text() };
}

await mkdir(path.join(repo, 'src'), { recursive: true });
await writeFile(path.join(repo, 'src', 'tui.txt'), 'initial\n', 'utf8');
await git(repo, ['init', '-b', 'main']);
await git(repo, ['config', 'user.email', 'tui-smoke@example.com']);
await git(repo, ['config', 'user.name', 'TUI Smoke']);
await git(repo, ['add', '--all']);
await git(repo, ['commit', '-m', 'initial']);
const baseCommit = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

const state = createInitialState({
  runId,
  objective: 'TUI smoke blocked delivery',
  repoRoot: repo,
  baseRef: 'main',
  baseCommit,
  maxRepairs: 3,
});
state.phase = 'blocked';
state.finishedAt = now();
state.repairIteration = 3;
state.acceptanceCriteria = [
  { id: 'AC-1', text: 'The TUI-visible backend checkpoint is proven.' },
  { id: 'AC-2', text: 'The TUI-visible validation harness passes.' },
];
state.workstreams = [
  { id: 'WS-1', title: 'TUI smoke workstream', role: 'implementer', kind: 'write', status: 'integrated', scope: ['src/**'], commit: baseCommit },
  { id: 'R1', title: 'TUI repair workstream', role: 'debugger', kind: 'write', status: 'integrated', scope: ['tests/**'], commit: baseCommit },
];
state.integration = {
  branch: 'codex-delivery-integration/tui-smoke-run/integration',
  worktreePath: repo,
  commit: baseCommit,
  attempts: [],
};
state.validation = {
  commands: ['python -m pytest tests/tui', 'npm --prefix web run build'],
  setup: {
    enabled: true,
    reason: 'human review approved project dependency repair',
    steps: [{ id: 'python-install', kind: 'python-install', command: 'python -m pip install -r requirements-dev.txt' }],
  },
  setupRuns: [
    { command: 'python -m pip install -r requirements-dev.txt', kind: 'python-install', ok: true, exitCode: 0, durationMs: 42, logPath: `.codex/delivery-runs/${runId}/commands/validation-setup-01.log` },
  ],
  runs: [
    { command: 'python -m pytest tests/tui', ok: false, exitCode: 1, durationMs: 55, logPath: `.codex/delivery-runs/${runId}/commands/validation-01.log` },
    { command: 'npm --prefix web run build', ok: true, exitCode: 0, durationMs: 98, logPath: `.codex/delivery-runs/${runId}/commands/validation-02.log` },
  ],
};
state.verification = {
  verdict: 'failed',
  summary: 'One criterion is still unknown.',
  criteria: [
    { id: 'AC-1', status: 'proven', evidence: ['src/tui.txt exists'], paths: ['src/tui.txt'], commands: ['node scripts/tui-smoke.mjs'] },
    { id: 'AC-2', status: 'unknown', evidence: ['pytest failed'], paths: [], commands: ['python -m pytest tests/tui'] },
  ],
  failedCommands: [],
  residualRisks: [],
};
state.reviews = [
  {
    role: 'reviewer',
    verdict: 'changes_requested',
    summary: 'Validation harness still has a failure.',
    findings: [
      {
        severity: 'high',
        title: 'TUI validation failure is still blocking',
        summary: 'The pytest validation command fails.',
        paths: ['tests/tui'],
        criterionIds: ['AC-2'],
        reproduction: ['python -m pytest tests/tui'],
        recommendation: 'Repair the failing test harness.',
      },
    ],
    positiveEvidence: [],
  },
  { role: 'security', verdict: 'approved', summary: 'No blocking security findings.', findings: [], positiveEvidence: [] },
];
state.final = {
  status: 'blocked',
  summary: 'Quality gate failed; human review is required.',
  runId,
  integrationBranch: state.integration.branch,
  integrationCommit: state.integration.commit,
  integrationWorktree: state.integration.worktreePath,
  gate: null,
  finishedAt: now(),
};

await mkdir(path.join(repo, '.codex', 'delivery-runs', runId, 'commands'), { recursive: true });
await writeFile(path.join(repo, '.codex', 'delivery-runs', 'latest'), `${runId}\n`, 'utf8');
await writeFile(path.join(repo, '.codex', 'delivery-runs', runId, 'commands', 'validation-01.log'), 'AssertionError: tui harness failed\n', 'utf8');
await writeFile(path.join(repo, '.codex', 'delivery-runs', runId, 'commands', 'validation-02.log'), 'vite build ok\n', 'utf8');
await writeFile(path.join(repo, '.codex', 'delivery-runs', runId, 'commands', 'validation-setup-01.log'), 'installed\n', 'utf8');
await saveState(repo, state);
await appendEvent(repo, state, { type: 'workflow.started', baseRef: 'main', baseCommit });
await appendEvent(repo, state, { type: 'workflow.checkpoint', checkpoint: 'validation', tracks: 2 });
await appendEvent(repo, state, { type: 'validation.completed', command: 'python -m pytest tests/tui', ok: false, exitCode: 1, durationMs: 55, index: 1, total: 2 });
await appendEvent(repo, state, { type: 'quality.gate', passed: false, failedCommands: 1, failedCriteria: 1, blockingFindings: 1 });
await appendEvent(repo, state, { type: 'workflow.blocked', integrationCommit: baseCommit, summary: state.final.summary });

const inbox = await buildHumanReviewInbox(repo, state);
assert.equal(inbox.counts.validation, 1);
assert.equal(inbox.counts.criteria, 1);
assert.equal(inbox.counts.findings, 1);
assert.equal(inbox.items.length, 3);

const events = (await readFile(runPaths(repo, runId).events, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
let model = createTuiModel({ repo, runId, state, inbox, events, noColor: true });
const overview = renderTuiScreen(model, { width: 100, height: 30 });
assert.match(overview, /Codex Delivery TUI/);
assert.match(overview, /TUI smoke blocked delivery/);
assert.match(overview, /Validation:/);
assert.equal(stripAnsi(overview), overview);

const previousForceColor = process.env.FORCE_COLOR;
const previousNoColor = process.env.NO_COLOR;
process.env.FORCE_COLOR = '1';
delete process.env.NO_COLOR;
const colorModel = createTuiModel({ repo, runId, state, inbox, events, noColor: false });
const colorScreen = renderTuiScreen(colorModel, { width: 100, height: 30 });
assert.notEqual(stripAnsi(colorScreen), colorScreen);
if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
else process.env.FORCE_COLOR = previousForceColor;
if (previousNoColor === undefined) delete process.env.NO_COLOR;
else process.env.NO_COLOR = previousNoColor;

model = applyTuiKey(model, '2').model;
assert.equal(model.panel, 'events');
assert.match(renderTuiScreen(model, { width: 100, height: 18 }), /\[validation\] failed/);
model = applyTuiKey(model, '3').model;
assert.equal(model.panel, 'checkpoints');
assert.match(renderTuiScreen(model, { width: 100, height: 18 }), /\[checkpoint\]/);
model = applyTuiKey(model, '4').model;
assert.equal(model.panel, 'review');
assert.match(renderTuiScreen(model, { width: 120, height: 30 }), /Review Inbox \(3\)/);
model = applyTuiKey(model, 'j').model;
assert.equal(model.selected.review, 1);
model = applyTuiKey(model, 'k').model;
assert.equal(model.selected.review, 0);
model = applyTuiKey(model, 'e').model;
assert.equal(model.decisions[inbox.items[0].id], 'environment_required');
model = applyTuiKey(model, 'm').model;
assert.equal(model.decisions[inbox.items[0].id], 'manual_required');
model = applyTuiKey(model, 'a').model;
assert.equal(model.decisions[inbox.items[0].id], 'acknowledged');
model = applyTuiKey(model, 'r').model;
assert.equal(model.decisions[inbox.items[0].id], 'repair_requested');
model = applyTuiKey(model, 'n').model;
for (const char of 'TUI note') model = applyTuiKey(model, char).model;
model = applyTuiKey(model, '\r').model;
assert.equal(model.notes[inbox.items[0].id], 'TUI note');
assert.equal(reviewDecisionCounts(model).repair_requested, 3);

const nonTtyOutput = outputCollector();
await assert.rejects(
  () => tuiCommand({ repo, run: runId, _: [] }, { inputStream: Readable.from(['q']), outputStream: nonTtyOutput.stream }),
  /requires an interactive terminal/,
);

const statusRun = await driveTui(
  ({ input, output }) => statusCommand({ repo, run: runId, tui: true, noColor: true, _: [] }, { inputStream: input, outputStream: output }),
  ['q'],
);
assert.match(statusRun.output, /Codex Delivery TUI/);
assert.match(statusRun.output, /Overview/);
assert.match(statusRun.output, /Control Points/);
assert.ok(statusRun.output.includes('\u001b[?1049h'));
assert.ok(statusRun.output.includes('\u001b[?1049l'));
assert.deepEqual(statusRun.input.rawModeChanges, [true, false]);

const eventRun = await driveTui(
  ({ input, output }) => tuiCommand({ repo, run: runId, panel: 'events', noColor: true, _: [] }, { inputStream: input, outputStream: output }),
  ['q'],
);
assert.match(eventRun.output, /\[validation\] failed/);
assert.match(eventRun.output, /\[final\] blocked/);

const reviewRun = await driveTui(
  ({ input, output }) => reviewCommand({ repo, run: runId, tui: true, noColor: true, _: [] }, { inputStream: input, outputStream: output }),
  [
    'r',
    'n',
    ...'Approved by TUI'.split(''),
    '\r',
    { key: 's', wait: 250 },
    'q',
  ],
);
assert.match(reviewRun.output, /Review Inbox/);
assert.match(reviewRun.output, /Human review saved/);
const saved = JSON.parse(await readFile(runPaths(repo, runId).state, 'utf8'));
assert.equal(saved.humanReviews.length, 1);
assert.equal(saved.humanReviews[0].counts.byDecision.repair_requested, 3);
assert.ok(saved.humanReviews[0].repairContext.repairRequests.some((item) => item.note === 'Approved by TUI'));
assert.ok(await exists(path.join(repo, saved.humanReviews[0].artifactPath)));
const artifact = JSON.parse(await readFile(path.join(repo, saved.humanReviews[0].artifactPath), 'utf8'));
assert.equal(artifact.decisions.length, 3);
assert.equal(artifact.decisions[0].note, 'Approved by TUI');
assert.equal(artifact.counts.byDecision.repair_requested, 3);
assert.ok(await exists(path.join(repo, '.codex', 'delivery-runs', runId, 'human-reviews.jsonl')));

console.log('tui-smoke: OK');
