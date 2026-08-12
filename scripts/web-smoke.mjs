#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWebServer } from '../.codex/delivery-kit/web-server.mjs';
import { appendEvent, createInitialState, now, saveState } from '../.codex/delivery-kit/lib/core.mjs';
import { git } from '../.codex/delivery-kit/lib/git.mjs';

async function fetchJson(base, target, { token = 'web-smoke-token', ...init } = {}) {
  const response = await fetch(`${base}${target}`, {
    ...init,
    headers: {
      authorization: token ? `Bearer ${token}` : '',
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  const payload = await response.json();
  return { response, payload };
}

const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-delivery-web-smoke-'));
const repo = path.join(temp, 'repo');
let server = null;

try {
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, 'README.md'), 'web smoke\n', 'utf8');
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'web-smoke@example.invalid']);
  await git(repo, ['config', 'user.name', 'Web Smoke']);
  await git(repo, ['add', '--all']);
  await git(repo, ['commit', '-m', 'initial']);
  const baseCommit = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

  const runId = 'web-smoke-run';
  const state = createInitialState({
    runId,
    objective: 'Web smoke delivery',
    repoRoot: repo,
    baseRef: 'main',
    baseCommit,
    maxRepairs: 2,
  });
  state.phase = 'blocked';
  state.finishedAt = now();
  state.integration = {
    branch: 'codex-delivery-integration/web-smoke/integration',
    worktreePath: repo,
    commit: baseCommit,
    attempts: [],
  };
  state.validation = {
    commands: ['node scripts/check.mjs'],
    runs: [{ command: 'node scripts/check.mjs', ok: false, exitCode: 1, durationMs: 42, logPath: `.codex/delivery-runs/${runId}/commands/validation-01.log` }],
  };
  state.final = {
    status: 'blocked',
    summary: 'Validation failed.',
    runId,
    integrationBranch: state.integration.branch,
    integrationCommit: baseCommit,
    integrationWorktree: repo,
    gate: null,
    finishedAt: now(),
  };
  await mkdir(path.join(repo, '.codex', 'delivery-runs', runId, 'commands'), { recursive: true });
  await mkdir(path.join(repo, '.codex', 'delivery-runs', 'manual'), { recursive: true });
  await writeFile(path.join(repo, '.codex', 'delivery-runs', 'manual', 'events.jsonl'), '{"type":"manual"}\n', 'utf8');
  await writeFile(path.join(repo, '.codex', 'delivery-runs', 'latest'), 'manual\n', 'utf8');
  await writeFile(path.join(repo, '.codex', 'delivery-runs', runId, 'commands', 'validation-01.log'), 'AssertionError: web smoke failed\n', 'utf8');
  await saveState(repo, state);
  await appendEvent(repo, state, { type: 'workflow.blocked', summary: 'Validation failed.' });

  const acceptedRunId = 'web-smoke-accepted';
  const acceptedState = createInitialState({
    runId: acceptedRunId,
    objective: 'Accepted Web smoke delivery',
    repoRoot: repo,
    baseRef: 'main',
    baseCommit,
    maxRepairs: 2,
  });
  acceptedState.startedAt = '2000-01-01T00:00:00.000Z';
  acceptedState.phase = 'accepted';
  acceptedState.finishedAt = now();
  acceptedState.integration = {
    branch: 'codex-delivery-integration/web-smoke-accepted/integration',
    worktreePath: repo,
    commit: baseCommit,
    attempts: [],
  };
  acceptedState.validation = {
    commands: ['node scripts/check.mjs'],
    runs: [{ command: 'node scripts/check.mjs', ok: true, exitCode: 0, durationMs: 24, logPath: `.codex/delivery-runs/${acceptedRunId}/commands/validation-01.log` }],
  };
  acceptedState.verification = { verdict: 'passed', criteria: [] };
  acceptedState.reviews = [{ role: 'reviewer', verdict: 'approved', summary: 'Approved.' }];
  acceptedState.final = {
    status: 'accepted',
    summary: 'Validation passed.',
    runId: acceptedRunId,
    integrationBranch: acceptedState.integration.branch,
    integrationCommit: baseCommit,
    integrationWorktree: repo,
    gate: { passed: true, failedCommands: [], failedCriteria: [], blockingFindings: [], reviewFailures: [] },
    finishedAt: now(),
  };
  await mkdir(path.join(repo, '.codex', 'delivery-runs', acceptedRunId, 'commands'), { recursive: true });
  await writeFile(path.join(repo, '.codex', 'delivery-runs', acceptedRunId, 'commands', 'validation-01.log'), 'ok\n', 'utf8');
  await saveState(repo, acceptedState);
  await appendEvent(repo, acceptedState, { type: 'workflow.accepted', summary: 'Validation passed.' });

  await mkdir(path.join(repo, '.codex', 'escaped-run'), { recursive: true });
  await writeFile(path.join(repo, '.codex', 'escaped-run', 'state.json'), `${JSON.stringify({
    ...acceptedState,
    runId: 'escaped-run',
    objective: 'Escaped run must not be reachable through encoded route traversal',
  }, null, 2)}\n`, 'utf8');
  await writeFile(path.join(repo, '.codex', 'escaped-run', 'events.jsonl'), '', 'utf8');

  const created = await createWebServer({ repo, token: 'web-smoke-token' });
  server = created.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const unauthorized = await fetchJson(base, '/api/health', { token: '' });
  assert.equal(unauthorized.response.status, 401);

  const health = await fetchJson(base, '/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.payload.ok, true);

  const runs = await fetchJson(base, '/api/runs');
  assert.equal(runs.payload.latestRunId, runId);
  assert.equal(runs.payload.runs[0].runId, runId);

  const run = await fetchJson(base, `/api/runs/${runId}`);
  assert.equal(run.payload.runId, runId);
  assert.equal(run.payload.inbox.items.length, 1);
  assert.equal(typeof run.payload.telemetry.progress.percent, 'number');

  const encodedTraversal = await fetchJson(base, `/api/runs/${encodeURIComponent('../escaped-run')}`);
  assert.equal(encodedTraversal.response.status, 400);
  assert.match(encodedTraversal.payload.error, /Invalid run id/);

  const malformedRunId = await fetchJson(base, '/api/runs/%E0%A4%A');
  assert.equal(malformedRunId.response.status, 400);
  assert.match(malformedRunId.payload.error, /Invalid run id/);

  const invalidReview = await fetchJson(base, `/api/runs/${runId}/review`, {
    method: 'POST',
    body: JSON.stringify({ decisions: [{ itemId: run.payload.inbox.items[0].id, decision: 'bogus' }] }),
  });
  assert.equal(invalidReview.response.status, 400);
  assert.match(invalidReview.payload.error, /Invalid decision/);

  const acceptedReview = await fetchJson(base, `/api/runs/${acceptedRunId}/review`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(acceptedReview.response.status, 400);
  assert.match(acceptedReview.payload.error, /blocked or failed/);

  const review = await fetchJson(base, `/api/runs/${runId}/review`, {
    method: 'POST',
    body: JSON.stringify({ decisions: [{ itemId: run.payload.inbox.items[0].id, decision: 'repair_requested', note: 'web smoke approval' }] }),
  });
  assert.equal(review.response.status, 200);
  assert.match(review.payload.artifactPath, /human-reviews/);

  const saved = JSON.parse(await readFile(path.join(repo, '.codex', 'delivery-runs', runId, 'state.json'), 'utf8'));
  assert.equal(saved.humanReviews.length, 1);
  assert.equal(saved.humanReviews[0].counts.byDecision.repair_requested, 1);

  console.log('web-smoke: OK');
} finally {
  await new Promise((resolve) => server?.close(resolve) ?? resolve());
  await rm(temp, { recursive: true, force: true });
}
