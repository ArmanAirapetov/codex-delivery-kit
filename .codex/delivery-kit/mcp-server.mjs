#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  appendEvent,
  appendResult,
  createInitialState,
  instantiateWorkstreams,
  loadState,
  newRunId,
  readJson,
  runPaths,
  saveState,
  scopeMatches,
  transition,
  validateWorkstreams,
  writeJsonAtomic,
} from './lib/core.mjs';
import { currentRef, headCommit, repoRoot } from './lib/git.mjs';

const tools = [
  {
    name: 'delivery_begin',
    description: 'Start a persisted interactive delivery run. Call before planning.',
    inputSchema: {
      type: 'object',
      properties: { objective: { type: 'string' }, maxRepairs: { type: 'integer', minimum: 0, maximum: 5 } },
      required: ['objective'], additionalProperties: false,
    },
  },
  {
    name: 'delivery_status',
    description: 'Return the authoritative state of the current interactive delivery run.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'delivery_record_result',
    description: 'Persist a material discovery, decision, assumption, risk, finding, evidence, or outcome.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' }, kind: { type: 'string', enum: ['discovery', 'decision', 'assumption', 'risk', 'finding', 'evidence', 'outcome'] },
        title: { type: 'string' }, summary: { type: 'string' }, details: { type: 'array', items: { type: 'string' } },
        paths: { type: 'array', items: { type: 'string' } }, criterionIds: { type: 'array', items: { type: 'string' } },
        workstreamId: { type: ['string', 'null'] }, role: { type: ['string', 'null'] }, confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['kind', 'title', 'summary'], additionalProperties: false,
    },
  },
  {
    name: 'delivery_define_contract',
    description: 'Persist objective acceptance criteria and non-goals after discovery.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' }, acceptanceCriteria: { type: 'array', minItems: 1, items: { type: 'string' } }, nonGoals: { type: 'array', items: { type: 'string' } } },
      required: ['acceptanceCriteria'], additionalProperties: false,
    },
  },
  {
    name: 'delivery_approve_plan',
    description: 'Approve a scoped acyclic workstream graph. Overlapping scopes must be dependency-ordered.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' }, summary: { type: 'string' }, affectedAreas: { type: 'array', items: { type: 'string' } },
        validationCommands: { type: 'array', items: { type: 'string' } }, parallelismRationale: { type: 'string' },
        workstreams: { type: 'array', minItems: 1, items: { type: 'object', properties: {
          id: { type: 'string' }, title: { type: 'string' }, kind: { type: 'string' }, role: { type: 'string' },
          scope: { type: 'array', minItems: 1, items: { type: 'string' } }, dependsOn: { type: 'array', items: { type: 'string' } },
          criterionIds: { type: 'array', items: { type: 'string' } }, required: { type: 'boolean' },
          instructions: { type: 'array', items: { type: 'string' } }, localValidationCommands: { type: 'array', items: { type: 'string' } }
        }, required: ['id', 'title', 'role', 'scope', 'dependsOn', 'criterionIds', 'required'], additionalProperties: false } }
      },
      required: ['summary', 'affectedAreas', 'validationCommands', 'parallelismRationale', 'workstreams'], additionalProperties: false,
    },
  },
  {
    name: 'delivery_claim',
    description: 'Claim one ready workstream. Returns a token required for result and completion calls.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' }, workstreamId: { type: 'string' }, worker: { type: 'string' } }, required: ['workstreamId', 'worker'], additionalProperties: false },
  },
  {
    name: 'delivery_complete',
    description: 'Complete a claimed workstream with explicit changed paths, checks, and a main result.',
    inputSchema: {
      type: 'object', properties: {
        runId: { type: 'string' }, workstreamId: { type: 'string' }, claimToken: { type: 'string' }, summary: { type: 'string' },
        changedPaths: { type: 'array', items: { type: 'string' } },
        checks: { type: 'array', minItems: 1, items: { type: 'object', properties: { command: { type: 'string' }, status: { type: 'string', enum: ['passed', 'failed', 'not_run'] }, summary: { type: 'string' } }, required: ['command', 'status', 'summary'], additionalProperties: false } }
      }, required: ['workstreamId', 'claimToken', 'summary', 'changedPaths', 'checks'], additionalProperties: false,
    },
  },
  {
    name: 'delivery_record_verification',
    description: 'Record independent criterion-level verification.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' }, verdict: { type: 'string', enum: ['passed', 'failed', 'inconclusive'] }, summary: { type: 'string' }, criteria: { type: 'array', items: { type: 'object' } }, failedCommands: { type: 'array', items: { type: 'string' } }, residualRisks: { type: 'array', items: { type: 'string' } } }, required: ['verdict', 'summary', 'criteria'], additionalProperties: false },
  },
  {
    name: 'delivery_record_review',
    description: 'Record an independent review track and its findings.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' }, role: { type: 'string' }, verdict: { type: 'string', enum: ['approved', 'changes_required', 'inconclusive'] }, summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object' } }, positiveEvidence: { type: 'array', items: { type: 'string' } } }, required: ['role', 'verdict', 'summary', 'findings'], additionalProperties: false },
  },
  {
    name: 'delivery_accept',
    description: 'Accept only when all required workstreams completed, all criteria are proven, validation passed, and reviews approved.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' }, summary: { type: 'string' } }, required: ['summary'], additionalProperties: false },
  },
  {
    name: 'delivery_block',
    description: 'Block the run with a concrete reason when human input or unresolved repair is required.',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' }, reason: { type: 'string' } }, required: ['reason'], additionalProperties: false },
  },
];

async function getRepo() {
  return repoRoot(process.cwd());
}

async function latestRunId(repo) {
  try { return (await readFile(path.join(repo, '.codex', 'delivery-runs', 'latest-interactive'), 'utf8')).trim(); } catch { return null; }
}

async function getState(repo, runId = null) {
  const selected = runId || await latestRunId(repo);
  if (!selected) throw new Error('No interactive delivery run. Call delivery_begin.');
  return loadState(repo, selected);
}

function ready(item, state) {
  if (!['pending', 'ready'].includes(item.status)) return false;
  const byId = new Map(state.workstreams.map((entry) => [entry.id, entry]));
  return item.dependsOn.every((id) => ['completed', 'integrated'].includes(byId.get(id)?.status));
}

async function callTool(name, args) {
  const repo = await getRepo();
  if (name === 'delivery_begin') {
    const runId = `interactive-${newRunId(args.objective)}`;
    const baseRef = await currentRef(repo);
    const baseCommit = await headCommit(repo);
    const state = createInitialState({ runId, objective: args.objective, repoRoot: repo, baseRef, baseCommit, maxRepairs: args.maxRepairs ?? 2, config: { mode: 'interactive-mcp-hooks', enforcement: 'hook-guarded-shared-worktree' } });
    transition(state, 'discovery', 'interactive run initialized');
    await saveState(repo, state);
    await writeFile(path.join(repo, '.codex', 'delivery-runs', 'latest-interactive'), `${runId}\n`, 'utf8');
    await appendEvent(repo, state, { type: 'workflow.started', mode: 'interactive-mcp' });
    return { runId, phase: state.phase, warning: 'Interactive mode persists workflow state. Project hooks guard standard apply_patch paths and dangerous commands, but writers still share one worktree and some specialized tool paths may bypass hooks. Use the external harness for hard isolation and Git diff enforcement.' };
  }
  const state = await getState(repo, args.runId);
  if (name === 'delivery_status') return state;
  if (name === 'delivery_record_result') return appendResult(repo, state, args);
  if (name === 'delivery_define_contract') {
    if (!['discovery', 'planning'].includes(state.phase)) throw new Error(`Cannot define contract in phase ${state.phase}.`);
    state.acceptanceCriteria = args.acceptanceCriteria.map((text, index) => ({ id: `AC-${index + 1}`, text }));
    state.nonGoals = args.nonGoals ?? [];
    if (state.phase === 'discovery') transition(state, 'planning', 'acceptance contract defined');
    await saveState(repo, state);
    return { phase: state.phase, acceptanceCriteria: state.acceptanceCriteria };
  }
  if (name === 'delivery_approve_plan') {
    if (state.phase !== 'planning') throw new Error(`Cannot approve plan in phase ${state.phase}.`);
    validateWorkstreams(args.workstreams, new Set(state.acceptanceCriteria.map((item) => item.id)));
    state.plan = { summary: args.summary, affectedAreas: args.affectedAreas, validationCommands: args.validationCommands, parallelismRationale: args.parallelismRationale };
    state.validation.commands = args.validationCommands;
    state.workstreams = instantiateWorkstreams(args.workstreams);
    transition(state, 'implementation', 'interactive plan approved');
    await saveState(repo, state);
    return { phase: state.phase, ready: state.workstreams.filter((item) => ready(item, state)).map((item) => item.id) };
  }
  if (name === 'delivery_claim') {
    if (!['implementation', 'repair'].includes(state.phase)) throw new Error(`Cannot claim in phase ${state.phase}.`);
    const item = state.workstreams.find((entry) => entry.id === args.workstreamId);
    if (!item) throw new Error(`Unknown workstream ${args.workstreamId}.`);
    if (!ready(item, state)) throw new Error(`Workstream ${item.id} is not ready.`);
    item.status = 'running';
    item.worker = args.worker;
    item.claimToken = randomUUID();
    item.startedAt = new Date().toISOString();
    await saveState(repo, state);
    return { workstream: item, claimToken: item.claimToken, scope: item.scope, note: 'Include this token in delivery_complete.' };
  }
  if (name === 'delivery_complete') {
    const item = state.workstreams.find((entry) => entry.id === args.workstreamId);
    if (!item || item.status !== 'running' || item.claimToken !== args.claimToken) throw new Error('Invalid workstream claim token or status.');
    const outside = args.changedPaths.filter((candidate) => !scopeMatches(candidate, item.scope));
    if (outside.length) throw new Error(`Paths outside declared scope: ${outside.join(', ')}`);
    if (args.checks.some((check) => check.status === 'failed')) throw new Error('Cannot complete with a failed check.');
    item.status = 'completed';
    item.finishedAt = new Date().toISOString();
    item.changedPaths = args.changedPaths;
    item.checks = args.checks;
    item.result = { summary: args.summary };
    delete item.claimToken;
    await appendResult(repo, state, { kind: 'outcome', title: `${item.id} completed`, summary: args.summary, paths: args.changedPaths, criterionIds: item.criterionIds, workstreamId: item.id, role: item.role, confidence: 'high', tags: ['interactive'] });
    await saveState(repo, state);
    return { completed: item.id, newlyReady: state.workstreams.filter((entry) => ready(entry, state)).map((entry) => entry.id) };
  }
  if (name === 'delivery_record_verification') {
    if (!state.workstreams.filter((item) => item.required).every((item) => ['completed', 'integrated'].includes(item.status))) throw new Error('Required workstreams are incomplete.');
    if (state.phase === 'implementation') transition(state, 'integration', 'interactive implementation complete');
    if (state.phase === 'integration') transition(state, 'verification', 'interactive verification started');
    state.verification = { verdict: args.verdict, summary: args.summary, criteria: args.criteria, failedCommands: args.failedCommands ?? [], residualRisks: args.residualRisks ?? [] };
    transition(state, 'review', 'interactive verification recorded');
    await saveState(repo, state);
    return state.verification;
  }
  if (name === 'delivery_record_review') {
    if (state.phase !== 'review') throw new Error(`Cannot review in phase ${state.phase}.`);
    state.reviews.push({ role: args.role, verdict: args.verdict, summary: args.summary, findings: args.findings, positiveEvidence: args.positiveEvidence ?? [] });
    await saveState(repo, state);
    return { reviews: state.reviews.length };
  }
  if (name === 'delivery_accept') {
    const incomplete = state.workstreams.filter((item) => item.required && !['completed', 'integrated'].includes(item.status));
    const unproven = (state.verification?.criteria ?? []).filter((item) => item.status !== 'proven');
    const blocking = state.reviews.flatMap((review) => review.findings ?? []).filter((finding) => ['critical', 'high', 'medium'].includes(finding.severity));
    if (incomplete.length || state.verification?.verdict !== 'passed' || unproven.length || blocking.length || state.reviews.some((review) => review.verdict !== 'approved')) {
      throw new Error('Acceptance gate failed: incomplete work, unproven criteria, failed verification, or blocking review findings remain.');
    }
    state.final = { status: 'accepted', summary: args.summary, finishedAt: new Date().toISOString(), mode: 'interactive-mcp' };
    transition(state, 'accepted', args.summary);
    await writeJsonAtomic(runPaths(repo, state.runId).final, state.final);
    await saveState(repo, state);
    return state.final;
  }
  if (name === 'delivery_block') {
    state.final = { status: 'blocked', summary: args.reason, finishedAt: new Date().toISOString(), mode: 'interactive-mcp' };
    transition(state, 'blocked', args.reason);
    await writeJsonAtomic(runPaths(repo, state.runId).final, state.final);
    await saveState(repo, state);
    return state.final;
  }
  throw new Error(`Unknown tool ${name}`);
}

function response(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function errorResponse(id, error) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: error.message } })}\n`);
}

let buffer = '';
const keepAlive = setInterval(() => {}, 60000);
let inputClosed = false;
const pending = new Set();

function maybeClose() {
  if (inputClosed && pending.size === 0) clearInterval(keepAlive);
}

function handleRequest(request) {
  const task = Promise.resolve().then(async () => {
    if (request.method === 'initialize') {
      response(request.id, { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'codex-delivery-workflow', version: '1.0.0' } });
    } else if (request.method === 'tools/list') {
      response(request.id, { tools });
    } else if (request.method === 'tools/call') {
      try {
        const result = await callTool(request.params.name, request.params.arguments ?? {});
        response(request.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
      } catch (error) {
        response(request.id, { content: [{ type: 'text', text: error.message }], structuredContent: { error: error.message }, isError: true });
      }
    } else if (request.id !== undefined && request.method === 'ping') {
      response(request.id, {});
    }
  }).catch((error) => errorResponse(request.id, error)).finally(() => {
    pending.delete(task);
    maybeClose();
  });
  pending.add(task);
}

process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdin.on('end', () => {
  inputClosed = true;
  maybeClose();
});
process.stdin.on('close', () => {
  inputClosed = true;
  maybeClose();
});
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    handleRequest(request);
  }
});
