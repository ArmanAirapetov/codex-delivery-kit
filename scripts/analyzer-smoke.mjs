#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyze } from '../.codex/delivery-kit/analyze-runs.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'codex-analyzer-'));
const runId = 'run-smoke';
const dir = path.join(root, '.codex', 'delivery-runs', runId);
await mkdir(dir, { recursive: true });
const state = {
  runId,
  phase: 'accepted',
  objective: 'smoke',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:10.000Z',
  repairIteration: 1,
  workstreams: [
    { id: 'W1', status: 'integrated' },
    { id: 'W2', status: 'integrated' },
  ],
  validation: { runs: [{ command: 'node test', ok: true }] },
  verification: { criteria: [{ id: 'AC-1', status: 'proven' }, { id: 'AC-2', status: 'proven' }] },
  reviews: [{ role: 'reviewer', findings: [], verdict: 'approved' }],
  final: { status: 'accepted' },
};
await writeFile(path.join(dir, 'state.json'), JSON.stringify(state));
const events = [
  { at: '2026-01-01T00:00:01.000Z', type: 'workstream.started', workstreamId: 'W1' },
  { at: '2026-01-01T00:00:01.500Z', type: 'workstream.started', workstreamId: 'W2' },
  { at: '2026-01-01T00:00:03.000Z', type: 'workstream.completed', workstreamId: 'W1' },
  { at: '2026-01-01T00:00:04.000Z', type: 'workstream.completed', workstreamId: 'W2' },
  { type: 'codex.run.completed', role: 'implementer', ok: true, durationMs: 2000, usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 10 } },
  { type: 'codex.run.completed', role: 'reviewer', ok: true, durationMs: 1000, usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 5 } },
  { type: 'codex.hook.subagent-start', agentType: 'reviewer' },
  { type: 'codex.hook.pre-tool-use', toolName: 'Bash', decision: 'deny' },
];
await writeFile(path.join(dir, 'events.jsonl'), events.map(JSON.stringify).join('\n') + '\n');
const results = [
  { kind: 'outcome', workstreamId: 'W1', criterionIds: ['AC-1'] },
  { kind: 'evidence', workstreamId: 'W2', criterionIds: ['AC-2'] },
];
await writeFile(path.join(dir, 'results.jsonl'), results.map(JSON.stringify).join('\n') + '\n');
const readJsonl = async (file) => (await readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const report = analyze(
  JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')),
  await readJsonl(path.join(dir, 'events.jsonl')),
  await readJsonl(path.join(dir, 'results.jsonl')),
);
assert.equal(report.codex.runs, 2);
assert.equal(report.codex.usage.input_tokens, 150);
assert.equal(report.workstreams.maxConcurrentWorkstreams, 2);
assert.equal(report.quality.criteriaProven, 2);
assert.equal(report.results.linkedToCriteria, 2);
assert.equal(report.hooks.events, 2);
assert.equal(report.hooks.deniedToolCalls, 1);
assert.equal(report.hooks.subagentStarts, 1);
console.log('analyzer-smoke: OK');
