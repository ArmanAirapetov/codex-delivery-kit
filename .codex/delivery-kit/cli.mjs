#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  appendEvent,
  appendResult,
  attachEventSink,
  createInitialState,
  ensureDir,
  instantiateWorkstreams,
  loadState,
  newRunId,
  now,
  readJson,
  readyWorkstreams,
  redactText,
  runPaths,
  saveState,
  scopeMatches,
  slugify,
  topologicalOrder,
  transition,
  validateWorkstreams,
  writeJsonAtomic,
} from './lib/core.mjs';
import {
  abortCherryPick,
  assertUsableRepository,
  changedPaths,
  cherryPick,
  commitAll,
  createWorktree,
  currentRef,
  git,
  hasConflicts,
  headCommit,
  removeWorktree,
  repoRoot as findRepoRoot,
  runProcess,
} from './lib/git.mjs';
import { codexAvailable, runCodex } from './lib/codex-runner.mjs';
import {
  conflictPrompt,
  discoveryPrompt,
  planPrompt,
  repairPlanPrompt,
  reviewPrompt,
  verificationPrompt,
  workerPrompt,
} from './lib/prompts.mjs';
import { createProgressLogger, isTerminalProgressEvent, renderProgressLine } from './lib/progress.mjs';

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_ROOT = path.join(KIT_ROOT, 'delivery', 'schemas');
const CLI_PATH = fileURLToPath(import.meta.url);
const BOOLEAN_OPTIONS = new Set([
  'allowDirty',
  'background',
  'follow',
  'help',
  'h',
  'integration',
  'keepWorktrees',
  'logs',
  'quiet',
  'raw',
  'verbose',
]);
const BACKGROUND_TERMINAL_STATUSES = new Set(['exited', 'failed', 'stopped']);
const DELIVERY_TERMINAL_PHASES = new Set(['accepted', 'blocked', 'failed']);
const DEFAULT_CONFIG = {
  codexBinary: 'codex',
  maxParallel: 4,
  maxRepairs: 2,
  timeoutMinutes: 60,
  retainRawEvents: false,
  keepWorkerWorktrees: false,
  allowDirty: false,
  model: null,
  reasoning: {
    discovery: 'medium',
    planning: 'high',
    implementation: 'high',
    verification: 'high',
    review: 'high',
  },
  models: {},
  discoveryTracks: [
    { role: 'explorer', focus: 'Map the affected execution paths, modules, tests, configuration, and existing conventions.' },
    { role: 'test_analyst', focus: 'Map current test coverage, validation commands, likely regressions, fixtures, and failure modes.' },
    { role: 'risk_analyst', focus: 'Identify architecture, compatibility, migration, security, and operational risks relevant to the objective.' },
  ],
  reviewTracks: [
    { role: 'reviewer', focus: 'Correctness, behavior regressions, maintainability, compatibility, and missing tests.' },
    { role: 'security', focus: 'Trust boundaries, authentication, authorization, secret handling, injection, unsafe defaults, and abuse paths.' },
  ],
  allowedValidationPrefixes: [
    'npm test', 'npm run ', 'npx ', 'pnpm ', 'yarn ', 'bun ',
    'pytest', 'python -m pytest', 'python3 -m pytest', 'ruff ', 'mypy ',
    'cargo test', 'cargo check', 'cargo clippy', 'go test', 'go vet',
    'make', 'cmake --build', './gradlew ', 'gradle ', 'mvn ', 'dotnet test',
    'node ', 'bash scripts/', './scripts/',
  ],
};

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() ?? 'help';
  const options = { _: [] };
  while (args.length) {
    const token = args.shift();
    if (!token.startsWith('--')) {
      options._.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (inlineValue !== undefined) options[key] = inlineValue;
    else if (BOOLEAN_OPTIONS.has(key)) options[key] = true;
    else if (args[0] && !args[0].startsWith('--')) options[key] = args.shift();
    else options[key] = true;
  }
  return { command, options };
}

class UserFacingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserFacingError';
  }
}

function resolveCliPath(value, base = process.cwd()) {
  return path.resolve(base, String(value));
}

function shellExample(command) {
  return `  ${command}`;
}

function missingObjectiveMessage(repo = null) {
  const target = repo ? ` after repository path '${repo}'` : '';
  return [
    `The run command requires an objective${target}.`,
    'Examples:',
    shellExample('./scripts/codex-delivery run "Fix issue #123"'),
    shellExample('./scripts/codex-delivery run --repo /path/to/repo "Fix issue #123"'),
    shellExample('./scripts/codex-delivery run /path/to/repo "Fix issue #123"'),
  ].join('\n');
}

function containsWhitespace(value) {
  const text = String(value ?? '');
  return /\s/.test(text);
}

function looksLikeRepoSelector(value) {
  const text = String(value ?? '');
  if (!text || containsWhitespace(text)) return false;
  return text.startsWith('/') || text.startsWith('./') || text.startsWith('../') || text === '.' || text === '..' || text.includes(path.sep);
}

function looksLikeMissingRepoSelector(value) {
  const text = String(value ?? '');
  if (!text || containsWhitespace(text)) return false;
  return text.startsWith('/') || text.startsWith('./') || text.startsWith('../') || text === '.' || text === '..';
}

async function isDirectory(value) {
  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}

async function repoCwdFromOptions(options) {
  if (!options.repo) return process.cwd();
  const repo = resolveCliPath(options.repo);
  if (!await isDirectory(repo)) throw new UserFacingError(`Repository path does not exist or is not a directory: ${repo}`);
  return repo;
}

async function parseRunTarget(options) {
  let repo = options.repo ? resolveCliPath(options.repo) : null;
  if (repo && !await isDirectory(repo)) throw new UserFacingError(`Repository path does not exist or is not a directory: ${repo}`);
  const objectiveParts = [...options._];
  if (!repo && objectiveParts.length) {
    const candidate = resolveCliPath(objectiveParts[0]);
    if (looksLikeRepoSelector(objectiveParts[0]) && await isDirectory(candidate)) {
      repo = candidate;
      objectiveParts.shift();
      if (!objectiveParts.join(' ').trim()) throw new UserFacingError(missingObjectiveMessage(candidate));
    } else if (looksLikeMissingRepoSelector(objectiveParts[0]) && objectiveParts.length === 1) {
      throw new UserFacingError(`'${objectiveParts[0]}' looks like a repository path, but it was not found from ${process.cwd()}.\n${missingObjectiveMessage()}`);
    }
  }
  const objective = objectiveParts.join(' ').trim();
  if (!objective) throw new UserFacingError(missingObjectiveMessage(repo));
  return { cwd: repo ?? process.cwd(), objective };
}

async function repositoryRootFor(cwd) {
  try {
    return await findRepoRoot(cwd);
  } catch {
    throw new UserFacingError(`No Git repository found from ${path.resolve(cwd)}. Run this command from a Git repository or pass --repo <path>.`);
  }
}

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    reasoning: { ...base.reasoning, ...(override?.reasoning ?? {}) },
    models: { ...base.models, ...(override?.models ?? {}) },
  };
}

async function loadConfig(repo, options) {
  const configured = await readJson(path.join(repo, 'codex-delivery.config.json'), {});
  const config = mergeConfig(DEFAULT_CONFIG, configured);
  if (options.maxParallel) config.maxParallel = Number(options.maxParallel);
  if (options.maxRepairs) config.maxRepairs = Number(options.maxRepairs);
  if (options.timeoutMinutes) config.timeoutMinutes = Number(options.timeoutMinutes);
  if (options.raw) config.retainRawEvents = true;
  if (options.allowDirty) config.allowDirty = true;
  if (options.keepWorktrees) config.keepWorkerWorktrees = true;
  if (options.model) config.model = options.model;
  return config;
}

function attachProgress(state, config) {
  attachEventSink(state, config?.progress?.event);
  return state;
}

function configureProgress(repo, options, stream = process.stderr) {
  return createProgressLogger({
    enabled: !options.quiet,
    verbose: Boolean(options.verbose),
    repo,
    stream,
  });
}

function roleModel(config, role) {
  return config.models?.[role] || config.model || null;
}

function roleReasoning(config, phase) {
  return config.reasoning?.[phase] || null;
}

function snapshotStamp() {
  return new Date().toISOString().replace(/[-:.]/g, '').replace('T', 'T');
}

async function safeGitText(cwd, args, maxOutputBytes = 8 * 1024 * 1024) {
  const result = await git(cwd, args, { rejectOnError: false, maxOutputBytes });
  return redactText(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`, maxOutputBytes);
}

async function readJsonIfExists(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function flagForOption(key) {
  return `--${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
}

function childOptionArgs(options) {
  const keys = ['maxParallel', 'maxRepairs', 'timeoutMinutes', 'model', 'raw', 'allowDirty', 'keepWorktrees', 'quiet', 'verbose'];
  const args = [];
  for (const key of keys) {
    const value = options[key];
    if (value === undefined || value === false || value === null) continue;
    args.push(flagForOption(key));
    if (value !== true) args.push(String(value));
  }
  return args;
}

function processAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function backgroundSignalTarget(pid) {
  const numeric = Number(pid);
  if (process.platform === 'win32') return numeric;
  return -numeric;
}

async function readBackgroundRecord(repo, runId) {
  return readJsonIfExists(runPaths(repo, runId).background);
}

async function writeBackgroundRecord(repo, runId, record) {
  await writeJsonAtomic(runPaths(repo, runId).background, record);
  return record;
}

async function updateBackgroundRecord(repo, runId, patch) {
  const current = await readBackgroundRecord(repo, runId) ?? {};
  return writeBackgroundRecord(repo, runId, { ...current, ...patch, updatedAt: now() });
}

function backgroundPaths(repo, runId) {
  const paths = runPaths(repo, runId);
  return {
    statePath: paths.state,
    eventsPath: paths.events,
    backgroundPath: paths.background,
    backgroundLogPath: paths.backgroundLog,
  };
}

function backgroundOutput(repo, runId, record) {
  return {
    runId,
    pid: record.pid ?? null,
    repo,
    mode: record.mode,
    status: record.status,
    ...backgroundPaths(repo, runId),
  };
}

async function spawnBackgroundProcess({ repo, runId, mode, options }) {
  const paths = runPaths(repo, runId);
  await ensureDir(path.dirname(paths.backgroundLog));
  const logHandle = await open(paths.backgroundLog, 'a');
  try {
    const args = [
      CLI_PATH,
      '__background',
      '--repo', repo,
      '--run', runId,
      '--mode', mode,
      ...childOptionArgs(options),
    ];
    const child = spawn(process.execPath, args, {
      cwd: repo,
      detached: true,
      env: {
        ...process.env,
        CODEX_DELIVERY_BACKGROUND: '1',
        CODEX_DELIVERY_RUN_ID: runId,
        CODEX_DELIVERY_ROOT: repo,
      },
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    });
    child.unref();
    return { pid: child.pid, logPath: paths.backgroundLog };
  } finally {
    await logHandle.close();
  }
}

async function markBackgroundStarted(repo, state, mode, child) {
  const paths = runPaths(repo, state.runId);
  const record = {
    runId: state.runId,
    repo,
    mode,
    pid: child.pid,
    status: 'running',
    startedAt: now(),
    updatedAt: now(),
    lastHeartbeatAt: now(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    backgroundLogPath: paths.backgroundLog,
  };
  await writeBackgroundRecord(repo, state.runId, record);
  state.background = { ...record, backgroundLogPath: path.relative(repo, paths.backgroundLog) };
  await appendEvent(repo, state, { type: 'background.started', pid: child.pid, mode, backgroundLogPath: path.relative(repo, paths.backgroundLog) });
  await saveState(repo, state);
  return record;
}

async function assertNoActiveBackgroundForRun(repo, runId) {
  const current = await readBackgroundRecord(repo, runId);
  if (current?.pid && processAlive(current.pid) && !BACKGROUND_TERMINAL_STATUSES.has(current.status)) {
    throw new UserFacingError(`Run ${runId} already has an active Codex delivery process: pid ${current.pid}. Follow it with: ./scripts/codex-delivery logs --follow --run ${runId}`);
  }
}

export async function activeDeliveryRuns(repo, { excludeRunId = null } = {}) {
  const root = path.join(repo, '.codex', 'delivery-runs');
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const active = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === excludeRunId) continue;
    const runId = entry.name;
    const background = await readBackgroundRecord(repo, runId).catch(() => null);
    if (background?.pid && processAlive(background.pid) && !BACKGROUND_TERMINAL_STATUSES.has(background.status)) {
      active.push({
        runId,
        kind: 'background',
        pid: background.pid,
        mode: background.mode ?? 'unknown',
        status: background.status ?? 'running',
        phase: null,
        startedAt: background.startedAt ?? null,
        lastHeartbeatAt: background.lastHeartbeatAt ?? null,
      });
      continue;
    }
    const state = await readJsonIfExists(runPaths(repo, runId).state).catch(() => null);
    if (state && !DELIVERY_TERMINAL_PHASES.has(state.phase) && !state.finishedAt) {
      active.push({
        runId,
        kind: 'state',
        pid: null,
        mode: 'foreground-or-unknown',
        status: 'appears-active',
        phase: state.phase,
        startedAt: state.startedAt ?? null,
        lastHeartbeatAt: null,
      });
    }
  }
  return active.sort((left, right) => String(left.startedAt ?? '').localeCompare(String(right.startedAt ?? '')));
}

export function renderActiveDeliveryWarning(active, { max = 5 } = {}) {
  if (!active?.length) return '';
  const shown = active.slice(0, max);
  const lines = [
    `[codex-delivery] Notice: ${active.length === 1 ? 'another Codex delivery process appears' : `${active.length} Codex delivery processes appear`} active in this repository.`,
  ];
  for (const item of shown) {
    const fields = [
      `run=${item.runId}`,
      item.pid ? `pid=${item.pid}` : null,
      `mode=${item.mode}`,
      `status=${item.status}`,
      item.phase ? `phase=${item.phase}` : null,
      item.lastHeartbeatAt ? `heartbeat=${item.lastHeartbeatAt}` : null,
    ].filter(Boolean).join(' ');
    lines.push(`  - ${fields}`);
    lines.push(`    follow: ./scripts/codex-delivery logs --follow --run ${item.runId}`);
  }
  if (active.length > shown.length) lines.push(`  - ... ${active.length - shown.length} more active run(s) omitted`);
  lines.push('Starting another delivery process is allowed, but concurrent Codex agents may contend for worktrees, integration branches, and validation resources.');
  return `${lines.join('\n')}\n`;
}

async function notifyActiveDeliveryRuns(repo, { excludeRunId = null, stream = process.stderr } = {}) {
  const active = await activeDeliveryRuns(repo, { excludeRunId });
  const warning = renderActiveDeliveryWarning(active);
  if (warning) stream.write(warning);
  return active;
}

async function recordWorktreeSnapshot(repo, state, workstream, reason, run = null) {
  const worktreePath = workstream.worktreePath;
  if (!worktreePath) return null;
  const exists = await stat(worktreePath).catch(() => null);
  if (!exists?.isDirectory()) return null;

  const snapshotDir = path.join(
    runPaths(repo, state.runId).artifacts,
    'workstreams',
    workstream.id,
    'snapshots',
    `${snapshotStamp()}-${slugify(reason, 40)}`,
  );
  await ensureDir(snapshotDir);

  const head = (await git(worktreePath, ['rev-parse', 'HEAD'], { rejectOnError: false })).stdout.trim();
  const status = await safeGitText(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all']);
  const trackedDiff = await safeGitText(worktreePath, ['diff', '--binary', '--no-ext-diff'], 16 * 1024 * 1024);
  const stagedDiff = await safeGitText(worktreePath, ['diff', '--cached', '--binary', '--no-ext-diff'], 16 * 1024 * 1024);
  const trackedFiles = await safeGitText(worktreePath, ['ls-files']);
  const untrackedFiles = await safeGitText(worktreePath, ['ls-files', '--others', '--exclude-standard']);

  await writeFile(path.join(snapshotDir, 'status.txt'), status, 'utf8');
  await writeFile(path.join(snapshotDir, 'tracked.diff'), trackedDiff, 'utf8');
  await writeFile(path.join(snapshotDir, 'staged.diff'), stagedDiff, 'utf8');
  await writeFile(path.join(snapshotDir, 'tracked-files.txt'), trackedFiles, 'utf8');
  await writeFile(path.join(snapshotDir, 'untracked-files.txt'), untrackedFiles, 'utf8');
  if (run?.final) await writeJsonAtomic(path.join(snapshotDir, 'worker-final.json'), run.final);

  const archivePath = path.join(snapshotDir, 'source.tgz');
  const archive = await runProcess('tar', [
    '-C', worktreePath,
    '--exclude=.git',
    '--exclude=web/node_modules',
    '--exclude=web/dist',
    '--exclude=node_modules',
    '--exclude=dist',
    '-czf', archivePath,
    '.',
  ], { rejectOnError: false, timeoutMs: 120000, maxOutputBytes: 1024 * 1024 });
  await writeFile(path.join(snapshotDir, 'archive.log'), redactText(`${archive.stdout}${archive.stderr}`, 1024 * 1024), 'utf8');

  const record = {
    at: now(),
    reason,
    path: path.relative(repo, snapshotDir),
    archivePath: path.relative(repo, archivePath),
    worktreePath,
    branch: workstream.branch,
    head,
    status: workstream.status,
    changedPaths: workstream.changedPaths ?? [],
    archiveOk: archive.code === 0,
  };
  await writeJsonAtomic(path.join(snapshotDir, 'snapshot.json'), record);
  workstream.snapshots ??= [];
  workstream.snapshots.push(record);
  await appendEvent(repo, state, { type: 'workstream.snapshot.saved', workstreamId: workstream.id, reason, path: record.path, archiveOk: record.archiveOk });
  return record;
}

async function initRun(repo, objective, config) {
  const baseRef = await currentRef(repo);
  const baseCommit = await headCommit(repo);
  const runId = newRunId(objective);
  const state = attachProgress(createInitialState({
    runId,
    objective,
    repoRoot: repo,
    baseRef,
    baseCommit,
    maxRepairs: config.maxRepairs,
    config: {
      maxParallel: config.maxParallel,
      retainRawEvents: config.retainRawEvents,
      model: config.model,
    },
  }), config);
  const paths = runPaths(repo, runId);
  await Promise.all(Object.values(paths).filter((value) => typeof value === 'string' && !path.extname(value)).map(ensureDir));
  await ensureDir(paths.root);
  await writeFile(path.join(repo, '.codex', 'delivery-runs', 'latest'), `${runId}\n`, 'utf8');
  transition(state, 'discovery', 'run initialized');
  await saveState(repo, state);
  await appendEvent(repo, state, { type: 'workflow.started', baseRef, baseCommit, objectiveHash: objective.length });
  return state;
}

async function codexStep({ repo, state, config, label, role, prompt, schema, cwd = repo, sandbox = 'read-only', workstreamId = null, phase = 'discovery' }) {
  const agentsDir = runPaths(repo, state.runId).agents;
  let actualLabel = label;
  let suffix = 2;
  while (await stat(path.join(agentsDir, actualLabel)).catch(() => null)) {
    actualLabel = `${label}-attempt-${suffix}`;
    suffix += 1;
  }
  const outputDir = path.join(agentsDir, actualLabel);
  return runCodex({
    binary: config.codexBinary,
    cwd,
    prompt,
    schemaPath: path.join(SCHEMA_ROOT, schema),
    outputDir,
    repoRoot: repo,
    state,
    label: actualLabel,
    role,
    workstreamId,
    sandbox,
    model: roleModel(config, role),
    reasoningEffort: roleReasoning(config, phase),
    timeoutMs: config.timeoutMinutes * 60 * 1000,
    retainRaw: config.retainRawEvents,
  });
}

async function runDiscovery(repo, state, config) {
  const jobs = config.discoveryTracks.map((track, index) => codexStep({
    repo,
    state,
    config,
    label: `discovery-${index + 1}-${track.role}`,
    role: track.role,
    prompt: discoveryPrompt({ objective: state.objective, role: track.role, focus: track.focus }),
    schema: 'discovery.schema.json',
    phase: 'discovery',
  }));
  const completed = await Promise.all(jobs);
  const discoveries = [];
  for (let index = 0; index < completed.length; index += 1) {
    const track = config.discoveryTracks[index];
    const run = completed[index];
    if (!run.ok) throw new Error(`Discovery track '${track.role}' failed.`);
    discoveries.push({ role: track.role, ...run.final });
    for (const result of run.final.results ?? []) {
      await appendResult(repo, state, { ...result, role: track.role, tags: [...(result.tags ?? []), 'discovery'] });
    }
  }
  await writeJsonAtomic(path.join(runPaths(repo, state.runId).artifacts, 'discovery.json'), discoveries);
  await appendEvent(repo, state, { type: 'workflow.checkpoint', checkpoint: 'discovery-complete', tracks: discoveries.length });
  transition(state, 'planning', 'discovery completed');
  await saveState(repo, state);
  return discoveries;
}

function normalizePlan(plan) {
  const acceptanceCriteria = plan.acceptanceCriteria.map((text, index) => ({ id: `AC-${index + 1}`, text: redactText(text, 1200) }));
  const workstreams = plan.workstreams.map((item) => ({
    ...item,
    scope: [...new Set(item.scope.map(String))],
    dependsOn: [...new Set(item.dependsOn.map(String))],
    criterionIds: [...new Set(item.criterionIds.map(String))],
  }));
  validateWorkstreams(workstreams, new Set(acceptanceCriteria.map((item) => item.id)));
  const covered = new Set(workstreams.filter((item) => item.required !== false).flatMap((item) => item.criterionIds));
  const missing = acceptanceCriteria.filter((item) => !covered.has(item.id));
  if (missing.length) throw new Error(`Required workstreams do not cover: ${missing.map((item) => item.id).join(', ')}`);
  return { acceptanceCriteria, workstreams };
}

async function runPlanning(repo, state, config, discoveries) {
  const run = await codexStep({
    repo,
    state,
    config,
    label: 'planning-architect',
    role: 'architect',
    prompt: planPrompt({ objective: state.objective, discoveries, maxParallel: config.maxParallel }),
    schema: 'plan.schema.json',
    phase: 'planning',
  });
  if (!run.ok) throw new Error('Planning agent failed to produce a valid plan.');
  const normalized = normalizePlan(run.final);
  state.acceptanceCriteria = normalized.acceptanceCriteria;
  state.nonGoals = run.final.nonGoals;
  state.plan = {
    summary: run.final.summary,
    affectedAreas: run.final.affectedAreas,
    validationCommands: run.final.validationCommands,
    parallelismRationale: run.final.parallelismRationale,
    risks: run.final.risks,
    assumptions: run.final.assumptions,
  };
  state.validation.commands = [...new Set(run.final.validationCommands)];
  state.workstreams = instantiateWorkstreams(normalized.workstreams, 0);
  await writeJsonAtomic(path.join(runPaths(repo, state.runId).artifacts, 'plan.json'), run.final);
  for (const risk of run.final.risks ?? []) await appendResult(repo, state, { kind: 'risk', title: 'Planning risk', summary: risk, role: 'architect', confidence: 'medium', tags: ['planning'] });
  for (const assumption of run.final.assumptions ?? []) await appendResult(repo, state, { kind: 'assumption', title: 'Planning assumption', summary: assumption, role: 'architect', confidence: 'medium', tags: ['planning'] });
  transition(state, 'implementation', 'contract and workstream DAG approved');
  await appendEvent(repo, state, { type: 'workflow.plan.approved', workstreams: state.workstreams.length, criteria: state.acceptanceCriteria.length });
  await saveState(repo, state);
}

function criteriaFor(state, workstream) {
  const wanted = new Set(workstream.criterionIds);
  return state.acceptanceCriteria.filter((criterion) => wanted.has(criterion.id));
}

async function executeWorker(repo, state, config, workstream, baseCommit, repairContext = null) {
  const created = await createWorktree({ repo, runId: state.runId, id: workstream.id, baseCommit });
  workstream.attempts ??= [];
  workstream.snapshots ??= [];
  const attemptNumber = workstream.attempts.length + 1;
  const agentLabel = attemptNumber === 1 ? `workstream-${workstream.id}` : `workstream-${workstream.id}-attempt-${attemptNumber}`;
  const attempt = {
    number: attemptNumber,
    status: 'running',
    startedAt: now(),
    finishedAt: null,
    baseCommit,
    branch: created.branch,
    worktreePath: created.worktreePath,
    agentLabel,
    commit: null,
    error: null,
    changedPaths: [],
    snapshotPath: null,
  };
  workstream.attempts.push(attempt);
  Object.assign(workstream, created, { status: 'running', startedAt: attempt.startedAt, finishedAt: null, error: null });
  await saveState(repo, state);
  await appendEvent(repo, state, { type: 'workstream.started', workstreamId: workstream.id, attempt: attemptNumber, role: workstream.role, branch: created.branch, baseCommit, scope: workstream.scope });
  const run = await codexStep({
    repo,
    state,
    config,
    label: agentLabel,
    role: workstream.role,
    workstreamId: workstream.id,
    cwd: created.worktreePath,
    sandbox: 'workspace-write',
    schema: 'worker.schema.json',
    phase: workstream.repairIteration ? 'implementation' : 'implementation',
    prompt: workerPrompt({
      objective: state.objective,
      workstream,
      criteria: criteriaFor(state, workstream),
      planSummary: state.plan.summary,
      repairContext,
    }),
  });
  const actualPaths = await changedPaths(created.worktreePath, 'HEAD');
  const forbidden = actualPaths.filter((candidate) => !scopeMatches(candidate, workstream.scope));
  const failedChecks = run.final?.checks?.filter((check) => check.status === 'failed') ?? [];
  const hasEvidence = (run.final?.results?.length ?? 0) > 0 && (run.final?.checks?.length ?? 0) > 0;
  const completed = run.ok && run.final.status === 'completed' && forbidden.length === 0 && failedChecks.length === 0 && hasEvidence;
  if (!completed) {
    workstream.status = 'failed';
    workstream.finishedAt = now();
    workstream.changedPaths = actualPaths;
    workstream.result = run.final;
    workstream.error = forbidden.length
      ? `Out-of-scope paths: ${forbidden.join(', ')}`
      : failedChecks.length
        ? `Failed local checks: ${failedChecks.map((item) => item.command).join(', ')}`
        : run.final?.blockingReason || `Codex worker failed or returned status '${run.final?.status ?? 'invalid'}'.`;
    Object.assign(attempt, {
      status: 'failed',
      finishedAt: workstream.finishedAt,
      error: workstream.error,
      changedPaths: actualPaths,
      result: run.final,
    });
    const snapshot = await recordWorktreeSnapshot(repo, state, workstream, 'failed', run);
    if (snapshot) attempt.snapshotPath = snapshot.path;
    await appendEvent(repo, state, { type: 'workstream.failed', workstreamId: workstream.id, error: workstream.error, paths: actualPaths });
    await saveState(repo, state);
    if (!config.keepWorkerWorktrees) await removeWorktree(repo, created.worktreePath, created.branch);
    throw new Error(`Workstream '${workstream.id}' failed: ${workstream.error}`);
  }
  const commit = await commitAll(created.worktreePath, `codex-delivery(${workstream.id}): ${workstream.title}`);
  if (!commit && workstream.required) {
    workstream.status = 'failed';
    workstream.finishedAt = now();
    workstream.error = 'Required workstream produced no repository change.';
    Object.assign(attempt, {
      status: 'failed',
      finishedAt: workstream.finishedAt,
      error: workstream.error,
      changedPaths: actualPaths,
      result: run.final,
    });
    const snapshot = await recordWorktreeSnapshot(repo, state, workstream, 'no-change', run);
    if (snapshot) attempt.snapshotPath = snapshot.path;
    await saveState(repo, state);
    if (!config.keepWorkerWorktrees) await removeWorktree(repo, created.worktreePath, created.branch);
    throw new Error(`Workstream '${workstream.id}' produced no repository change.`);
  }
  workstream.status = 'completed';
  workstream.finishedAt = now();
  workstream.changedPaths = actualPaths;
  workstream.commit = commit;
  workstream.checks = run.final.checks;
  workstream.result = run.final;
  Object.assign(attempt, {
    status: 'completed',
    finishedAt: workstream.finishedAt,
    commit,
    changedPaths: actualPaths,
    result: run.final,
  });
  const snapshot = await recordWorktreeSnapshot(repo, state, workstream, 'completed', run);
  if (snapshot) attempt.snapshotPath = snapshot.path;
  for (const result of run.final.results) {
    await appendResult(repo, state, { ...result, workstreamId: workstream.id, role: workstream.role });
  }
  await appendEvent(repo, state, { type: 'workstream.completed', workstreamId: workstream.id, commit, paths: actualPaths, checks: workstream.checks.length });
  await saveState(repo, state);
  return workstream;
}

async function ensureIntegrationWorktree(repo, state) {
  if (state.integration.worktreePath && state.integration.commit) return state.integration;
  const created = await createWorktree({ repo, runId: state.runId, id: 'integration', baseCommit: state.baseCommit, branchPrefix: 'codex-delivery-integration' });
  state.integration = { ...state.integration, ...created, commit: state.baseCommit };
  await appendEvent(repo, state, { type: 'integration.created', branch: created.branch, worktreePath: created.worktreePath });
  await saveState(repo, state);
  return state.integration;
}

async function resolveConflict(repo, state, config, workstream, commit, conflicts) {
  const run = await codexStep({
    repo,
    state,
    config,
    label: `integration-conflict-${workstream.id}`,
    role: 'integrator',
    workstreamId: workstream.id,
    cwd: state.integration.worktreePath,
    sandbox: 'workspace-write',
    schema: 'worker.schema.json',
    phase: 'implementation',
    prompt: conflictPrompt({
      objective: state.objective,
      commit,
      conflicts,
      completedWorkstreams: state.workstreams.filter((item) => item.status === 'integrated').map((item) => ({ id: item.id, title: item.title, commit: item.commit, paths: item.changedPaths })),
    }),
  });
  if (!run.ok || run.final.status !== 'completed') return false;
  const remaining = await hasConflicts(state.integration.worktreePath);
  if (remaining.length) return false;
  const cherryState = await git(state.integration.worktreePath, ['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], { rejectOnError: false });
  if (cherryState.code === 0) {
    const continued = await git(state.integration.worktreePath, ['cherry-pick', '--continue'], { rejectOnError: false, timeoutMs: 180000 });
    if (continued.code !== 0) return false;
  }
  return true;
}

async function integrateWave(repo, state, config, wave) {
  const integration = await ensureIntegrationWorktree(repo, state);
  for (const workstream of wave.sort((a, b) => a.id.localeCompare(b.id))) {
    if (!workstream.commit) {
      workstream.status = 'integrated';
      continue;
    }
    const attempt = { at: now(), workstreamId: workstream.id, commit: workstream.commit, status: 'started' };
    integration.attempts.push(attempt);
    await appendEvent(repo, state, { type: 'integration.started', workstreamId: workstream.id, commit: workstream.commit });
    const picked = await cherryPick(integration.worktreePath, workstream.commit);
    if (picked.code !== 0) {
      const conflicts = await hasConflicts(integration.worktreePath);
      attempt.conflicts = conflicts;
      await appendEvent(repo, state, { type: 'integration.conflict', workstreamId: workstream.id, commit: workstream.commit, conflicts });
      const resolved = conflicts.length && await resolveConflict(repo, state, config, workstream, workstream.commit, conflicts);
      if (!resolved) {
        await abortCherryPick(integration.worktreePath);
        attempt.status = 'failed';
        await saveState(repo, state);
        throw new Error(`Failed to integrate '${workstream.id}'. Conflicts: ${conflicts.join(', ') || 'unknown'}`);
      }
      attempt.status = 'resolved';
    } else {
      attempt.status = 'completed';
    }
    integration.commit = await headCommit(integration.worktreePath);
    workstream.status = 'integrated';
    await appendEvent(repo, state, { type: 'integration.completed', workstreamId: workstream.id, integrationCommit: integration.commit, conflictResolved: attempt.status === 'resolved' });
    await saveState(repo, state);
    if (!config.keepWorkerWorktrees) await removeWorktree(repo, workstream.worktreePath, workstream.branch);
  }
  return integration.commit;
}

function completedReadyWorkstreams(workstreams, target) {
  const byId = new Map(workstreams.map((item) => [item.id, item]));
  return workstreams.filter((item) => {
    if (!target.has(item.id) || item.status !== 'completed') return false;
    return (item.dependsOn ?? []).every((id) => byId.get(id)?.status === 'integrated');
  });
}

async function executeWorkstreamGraph(repo, state, config, targetIds, repairContext = null) {
  const target = new Set(targetIds);
  await ensureIntegrationWorktree(repo, state);
  while (true) {
    const remaining = state.workstreams.filter((item) => target.has(item.id) && !['integrated', 'failed'].includes(item.status));
    if (!remaining.length) break;
    const completedReady = completedReadyWorkstreams(state.workstreams, target);
    if (completedReady.length) {
      await integrateWave(repo, state, config, completedReady);
      await appendEvent(repo, state, { type: 'workstream.completed-integrated', ids: completedReady.map((item) => item.id), integrationCommit: state.integration.commit });
      continue;
    }
    const ready = readyWorkstreams(state.workstreams).filter((item) => target.has(item.id));
    if (!ready.length) throw new Error(`No ready workstreams; graph is blocked: ${remaining.map((item) => `${item.id}:${item.status}`).join(', ')}`);
    const wave = ready.slice(0, config.maxParallel);
    const baseCommit = state.integration.commit;
    await appendEvent(repo, state, { type: 'workstream.wave.started', ids: wave.map((item) => item.id), baseCommit });
    const settled = await Promise.allSettled(wave.map((item) => executeWorker(repo, state, config, item, baseCommit, repairContext)));
    const completed = settled.filter((item) => item.status === 'fulfilled').map((item) => item.value);
    const failed = settled.filter((item) => item.status === 'rejected').map((item) => item.reason);
    if (completed.length) await integrateWave(repo, state, config, completed);
    if (failed.length) {
      await appendEvent(repo, state, { type: 'workstream.wave.failed', ids: wave.map((item) => item.id), completed: completed.map((item) => item.id), failures: failed.map((error) => redactText(error.message, 800)), integrationCommit: state.integration.commit });
      await saveState(repo, state);
      throw failed[0];
    }
    await appendEvent(repo, state, { type: 'workstream.wave.completed', ids: completed.map((item) => item.id), integrationCommit: state.integration.commit });
  }
}

function hasUnsafeShellSyntax(command) {
  return /[;&|><`\n\r]|\$\(|\$\{|\b(?:sudo|su|rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|curl\s+[^\n]*\|\s*(?:sh|bash)|wget\s+[^\n]*\|\s*(?:sh|bash))\b/i.test(command);
}

function safeValidationCommand(command, config) {
  const trimmed = command.trim();
  if (!trimmed || hasUnsafeShellSyntax(trimmed)) return false;
  return config.allowedValidationPrefixes.some((prefix) => trimmed === prefix.trim() || trimmed.startsWith(prefix));
}

async function runValidation(repo, state, config) {
  state.validation.runs = [];
  for (let index = 0; index < state.validation.commands.length; index += 1) {
    const command = state.validation.commands[index];
    const logPath = path.join(runPaths(repo, state.runId).commands, `validation-${String(index + 1).padStart(2, '0')}.log`);
    await appendEvent(repo, state, { type: 'validation.started', command, index: index + 1, total: state.validation.commands.length, logPath: path.relative(repo, logPath) });
    if (!safeValidationCommand(command, config)) {
      const record = { command, ok: false, exitCode: null, durationMs: 0, logPath, error: 'Command rejected by validation allowlist.' };
      state.validation.runs.push(record);
      await writeFile(logPath, `${record.error}\n`, 'utf8');
      await appendEvent(repo, state, { type: 'validation.rejected', command, reason: record.error });
      continue;
    }
    const result = await runProcess('bash', ['-lc', command], {
      cwd: state.integration.worktreePath,
      timeoutMs: config.timeoutMinutes * 60 * 1000,
      maxOutputBytes: 6 * 1024 * 1024,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    await writeFile(logPath, redactText(output, 6 * 1024 * 1024), 'utf8');
    const record = { command, ok: result.code === 0, exitCode: result.code, durationMs: result.durationMs, logPath: path.relative(repo, logPath) };
    state.validation.runs.push(record);
    await appendEvent(repo, state, { type: 'validation.completed', command, ok: record.ok, exitCode: record.exitCode, durationMs: record.durationMs, logPath: record.logPath });
  }
  await saveState(repo, state);
}

async function disposableInspection(repo, state, config, { id, role, prompt, schema, phase }) {
  const created = await createWorktree({ repo, runId: state.runId, id, baseCommit: state.integration.commit, branchPrefix: 'codex-delivery-inspection' });
  try {
    await appendEvent(repo, state, { type: 'inspection.started', id, role, inspectionPhase: phase, worktreePath: created.worktreePath });
    const run = await codexStep({
      repo,
      state,
      config,
      label: id,
      role,
      cwd: created.worktreePath,
      sandbox: 'workspace-write',
      schema,
      phase,
      prompt,
    });
    const mutations = await changedPaths(created.worktreePath, 'HEAD');
    if (mutations.length) await appendEvent(repo, state, { type: 'inspection.mutations.discarded', role, paths: mutations });
    await appendEvent(repo, state, { type: 'inspection.completed', id, role, inspectionPhase: phase, ok: run.ok, durationMs: run.durationMs });
    return run;
  } finally {
    await removeWorktree(repo, created.worktreePath, created.branch);
  }
}

async function runVerificationAndReviews(repo, state, config) {
  transition(state, 'verification', 'integration completed');
  await saveState(repo, state);
  await runValidation(repo, state, config);
  const verifier = await disposableInspection(repo, state, config, {
    id: `verification-${state.repairIteration}`,
    role: 'verifier',
    phase: 'verification',
    schema: 'verification.schema.json',
    prompt: verificationPrompt({
      objective: state.objective,
      criteria: state.acceptanceCriteria,
      validationRuns: state.validation.runs,
      baseCommit: state.baseCommit,
      integrationCommit: state.integration.commit,
    }),
  });
  if (!verifier.ok) throw new Error('Independent verifier failed.');
  const expected = new Set(state.acceptanceCriteria.map((item) => item.id));
  const actual = new Set((verifier.final.criteria ?? []).map((item) => item.id));
  const missing = [...expected].filter((id) => !actual.has(id));
  const extra = [...actual].filter((id) => !expected.has(id));
  if (missing.length || extra.length) throw new Error(`Verifier criterion mismatch. Missing=${missing.join(',')} Extra=${extra.join(',')}`);
  state.verification = verifier.final;
  for (const criterion of verifier.final.criteria) {
    await appendResult(repo, state, {
      kind: 'evidence',
      title: `Verification ${criterion.id}: ${criterion.status}`,
      summary: criterion.evidence.join(' | '),
      paths: criterion.paths,
      criterionIds: [criterion.id],
      role: 'verifier',
      confidence: criterion.status === 'proven' ? 'high' : 'medium',
      tags: ['verification', criterion.status],
    });
  }
  transition(state, 'review', 'verification recorded');
  await saveState(repo, state);
  const reviewRuns = await Promise.all(config.reviewTracks.map((track) => disposableInspection(repo, state, config, {
    id: `review-${state.repairIteration}-${track.role}`,
    role: track.role,
    phase: 'review',
    schema: 'review.schema.json',
    prompt: reviewPrompt({
      objective: state.objective,
      criteria: state.acceptanceCriteria,
      baseCommit: state.baseCommit,
      integrationCommit: state.integration.commit,
      role: track.role,
      focus: track.focus,
    }),
  })));
  state.reviews = reviewRuns.map((run, index) => ({ role: config.reviewTracks[index].role, ...(run.final ?? { verdict: 'inconclusive', summary: 'Review failed.', findings: [], positiveEvidence: [] }) }));
  for (const review of state.reviews) {
    for (const finding of review.findings ?? []) {
      await appendResult(repo, state, {
        kind: 'finding',
        title: finding.title,
        summary: finding.summary,
        details: [...(finding.reproduction ?? []), finding.recommendation],
        paths: finding.paths,
        criterionIds: finding.criterionIds,
        role: review.role,
        confidence: ['critical', 'high'].includes(finding.severity) ? 'high' : 'medium',
        tags: ['review', finding.severity],
      });
    }
  }
  await saveState(repo, state);
}

function qualityGate(state) {
  const failedCommands = state.validation.runs.filter((run) => !run.ok);
  const failedCriteria = (state.verification?.criteria ?? []).filter((item) => item.status !== 'proven');
  const blockingFindings = state.reviews.flatMap((review) => (review.findings ?? []).map((finding) => ({ ...finding, role: review.role }))).filter((finding) => ['critical', 'high', 'medium'].includes(finding.severity));
  const reviewFailures = state.reviews.filter((review) => review.verdict !== 'approved');
  return {
    passed: failedCommands.length === 0 && state.verification?.verdict === 'passed' && failedCriteria.length === 0 && blockingFindings.length === 0 && reviewFailures.length === 0,
    failedCommands,
    failedCriteria,
    blockingFindings,
    reviewFailures,
  };
}

async function planRepair(repo, state, config, gate) {
  state.repairIteration += 1;
  transition(state, 'repair', `quality gate failed; repair ${state.repairIteration}`);
  await saveState(repo, state);
  const run = await codexStep({
    repo,
    state,
    config,
    label: `repair-plan-${state.repairIteration}`,
    role: 'architect',
    cwd: state.integration.worktreePath,
    sandbox: 'read-only',
    schema: 'repair-plan.schema.json',
    phase: 'planning',
    prompt: repairPlanPrompt({
      objective: state.objective,
      criteria: state.acceptanceCriteria,
      verification: { verdict: state.verification?.verdict, failedCriteria: gate.failedCriteria, failedCommands: gate.failedCommands },
      reviews: state.reviews,
      iteration: state.repairIteration,
      maxParallel: config.maxParallel,
    }),
  });
  if (!run.ok) throw new Error('Repair planner failed.');
  validateWorkstreams(run.final.workstreams, new Set(state.acceptanceCriteria.map((item) => item.id)));
  const repairWorkstreams = instantiateWorkstreams(run.final.workstreams, state.repairIteration);
  state.workstreams.push(...repairWorkstreams);
  await writeJsonAtomic(path.join(runPaths(repo, state.runId).artifacts, `repair-plan-${state.repairIteration}.json`), run.final);
  await appendEvent(repo, state, { type: 'repair.plan.approved', iteration: state.repairIteration, workstreams: repairWorkstreams.map((item) => item.id) });
  await saveState(repo, state);
  return repairWorkstreams;
}

async function finalize(repo, state, status, summary, gate = null) {
  state.final = {
    status,
    summary: redactText(summary, 3000),
    runId: state.runId,
    integrationBranch: state.integration.branch,
    integrationCommit: state.integration.commit,
    integrationWorktree: state.integration.worktreePath,
    gate,
    finishedAt: now(),
  };
  transition(state, status === 'accepted' ? 'accepted' : 'blocked', summary);
  await writeJsonAtomic(runPaths(repo, state.runId).final, state.final);
  await appendEvent(repo, state, { type: `workflow.${status}`, summary: state.final.summary, integrationCommit: state.integration.commit });
  await saveState(repo, state);
  return state.final;
}

function setPhaseDirect(state, phase, reason) {
  if (state.phase === phase) return;
  state.transitions.push({ at: now(), from: state.phase, to: phase, reason: redactText(reason, 500) });
  state.phase = phase;
  state.finishedAt = null;
}

async function resumePhaseFor(state) {
  if (!state.plan || !state.workstreams.length) return state.phase === 'planning' ? 'planning' : 'discovery';
  if (state.workstreams.some((item) => item.status !== 'integrated')) return 'implementation';
  return 'integration';
}

async function archiveAndResetWorkstream(repo, state, workstream) {
  const previousStatus = workstream.status;
  const snapshot = await recordWorktreeSnapshot(repo, state, workstream, `resume-${previousStatus}`, workstream.result ? { final: workstream.result } : null);
  workstream.attempts ??= [];
  const lastAttempt = workstream.attempts.at(-1);
  if (lastAttempt && ['running', 'failed'].includes(lastAttempt.status) && (!lastAttempt.branch || lastAttempt.branch === workstream.branch)) {
    Object.assign(lastAttempt, {
      status: `archived-${previousStatus}`,
      finishedAt: lastAttempt.finishedAt ?? workstream.finishedAt ?? now(),
      error: lastAttempt.error ?? workstream.error,
      changedPaths: lastAttempt.changedPaths?.length ? lastAttempt.changedPaths : workstream.changedPaths,
      snapshotPath: lastAttempt.snapshotPath ?? snapshot?.path ?? null,
      archivedForResumeAt: now(),
    });
  } else {
    workstream.attempts.push({
      number: workstream.attempts.length + 1,
      status: `archived-${previousStatus}`,
      startedAt: workstream.startedAt,
      finishedAt: workstream.finishedAt ?? now(),
      branch: workstream.branch,
      worktreePath: workstream.worktreePath,
      commit: workstream.commit,
      error: workstream.error,
      changedPaths: workstream.changedPaths ?? [],
      snapshotPath: snapshot?.path ?? null,
      archivedForResumeAt: now(),
    });
  }
  if (workstream.worktreePath) await removeWorktree(repo, workstream.worktreePath, workstream.branch);
  Object.assign(workstream, {
    status: 'pending',
    branch: null,
    worktreePath: null,
    commit: null,
    startedAt: null,
    finishedAt: null,
    changedPaths: [],
    checks: [],
    result: null,
    error: null,
  });
  await appendEvent(repo, state, { type: 'workstream.resume.reset', workstreamId: workstream.id, fromStatus: previousStatus, snapshot: snapshot?.path ?? null });
}

async function normalizeStateForResume(repo, state, config) {
  if (state.phase === 'accepted') throw new UserFacingError(`Run ${state.runId} is already accepted; nothing to resume.`);
  state.resumes ??= [];
  for (const workstream of state.workstreams ?? []) {
    workstream.snapshots ??= [];
    workstream.attempts ??= [];
  }
  const resumeRecord = {
    at: now(),
    fromPhase: state.phase,
    previousFinal: state.final,
    maxRepairsBefore: state.maxRepairs,
    maxRepairsAfter: config.maxRepairs,
  };
  state.resumes.push(resumeRecord);
  state.maxRepairs = config.maxRepairs;
  state.config = {
    ...(state.config ?? {}),
    maxParallel: config.maxParallel,
    retainRawEvents: config.retainRawEvents,
    model: config.model,
  };
  for (const workstream of state.workstreams ?? []) {
    if (['running', 'failed'].includes(workstream.status)) await archiveAndResetWorkstream(repo, state, workstream);
  }
  const nextPhase = await resumePhaseFor(state);
  state.final = null;
  state.finishedAt = null;
  setPhaseDirect(state, nextPhase, `resume requested from ${resumeRecord.fromPhase}`);
  await writeJsonAtomic(path.join(runPaths(repo, state.runId).artifacts, `resume-${snapshotStamp()}.json`), resumeRecord);
  await appendEvent(repo, state, { type: 'workflow.resume.started', fromPhase: resumeRecord.fromPhase, toPhase: state.phase });
  await saveState(repo, state);
}

async function continueDelivery(repo, state, config) {
  try {
    if (!state.plan || !state.workstreams?.length) {
      let discoveries = await readJsonIfExists(path.join(runPaths(repo, state.runId).artifacts, 'discovery.json'));
      if (!discoveries) discoveries = await runDiscovery(repo, state, config);
      else if (state.phase === 'discovery') {
        transition(state, 'planning', 'reusing discovery artifact for resume');
        await saveState(repo, state);
      }
      await runPlanning(repo, state, config, discoveries);
    }
    const targetIds = state.workstreams.filter((item) => item.status !== 'integrated').map((item) => item.id);
    if (targetIds.length) {
      await executeWorkstreamGraph(repo, state, config, targetIds);
      transition(state, 'integration', 'all implementation workstreams integrated');
      await saveState(repo, state);
    } else if (state.phase === 'blocked') {
      setPhaseDirect(state, 'integration', 'resume requested from blocked terminal state');
      await saveState(repo, state);
    }
    while (true) {
      await runVerificationAndReviews(repo, state, config);
      const gate = qualityGate(state);
      await appendEvent(repo, state, { type: 'quality.gate', passed: gate.passed, failedCommands: gate.failedCommands.length, failedCriteria: gate.failedCriteria.length, blockingFindings: gate.blockingFindings.length });
      if (gate.passed) {
        return finalize(repo, state, 'accepted', 'All validation commands passed, every acceptance criterion is proven, and independent reviews approved the integrated change.', gate);
      }
      if (state.repairIteration >= state.maxRepairs) {
        return finalize(repo, state, 'blocked', `Quality gate failed after ${state.repairIteration} repair iteration(s). Human review is required.`, gate);
      }
      const repairs = await planRepair(repo, state, config, gate);
      await executeWorkstreamGraph(repo, state, config, repairs.map((item) => item.id), { verification: state.verification, reviews: state.reviews, validation: state.validation.runs });
      transition(state, 'integration', `repair ${state.repairIteration} integrated`);
      await saveState(repo, state);
    }
  } catch (error) {
    await appendEvent(repo, state, { type: 'workflow.error', error: redactText(error.stack ?? error.message, 3000) });
    if (!['accepted', 'blocked'].includes(state.phase)) {
      try {
        await finalize(repo, state, 'blocked', `Delivery stopped: ${error.message}`);
      } catch {
        // Preserve the original error when finalization itself fails.
      }
    }
    throw error;
  }
}

export async function executeDelivery({ cwd = process.cwd(), objective, options = {} }) {
  const initialRepo = await repositoryRootFor(cwd);
  const config = await loadConfig(initialRepo, options);
  config.progress = configureProgress(initialRepo, options);
  const repo = await assertUsableRepository(initialRepo, { allowDirty: config.allowDirty });
  const availability = await codexAvailable(config.codexBinary);
  if (!availability.available) throw new Error(`Codex CLI '${config.codexBinary}' is not available.`);
  await notifyActiveDeliveryRuns(repo);
  const state = await initRun(repo, objective, config);
  await appendEvent(repo, state, { type: 'environment.codex', version: availability.version });
  return continueDelivery(repo, state, config);
}

export async function continueInitializedDelivery({ cwd = process.cwd(), options = {} }) {
  const initialRepo = await repositoryRootFor(cwd);
  const config = await loadConfig(initialRepo, options);
  config.progress = configureProgress(initialRepo, options);
  const repo = await assertUsableRepository(initialRepo, { allowDirty: config.allowDirty });
  const availability = await codexAvailable(config.codexBinary);
  if (!availability.available) throw new Error(`Codex CLI '${config.codexBinary}' is not available.`);
  if (!options.run) throw new Error('No initialized delivery run selected.');
  if (!options.backgroundChild) await notifyActiveDeliveryRuns(repo, { excludeRunId: options.run });
  const state = attachProgress(await loadState(repo, options.run), config);
  await appendEvent(repo, state, { type: 'environment.codex', version: availability.version });
  return continueDelivery(repo, state, config);
}

export async function resumeDelivery({ cwd = process.cwd(), options = {} }) {
  const initialRepo = await repositoryRootFor(cwd);
  const config = await loadConfig(initialRepo, options);
  config.progress = configureProgress(initialRepo, options);
  const repo = await assertUsableRepository(initialRepo, { allowDirty: config.allowDirty });
  const availability = await codexAvailable(config.codexBinary);
  if (!availability.available) throw new Error(`Codex CLI '${config.codexBinary}' is not available.`);
  const runId = options.run || await latestRunId(repo);
  if (!runId) throw new Error('No delivery run selected.');
  if (!options.backgroundChild) {
    await assertNoActiveBackgroundForRun(repo, runId);
    await notifyActiveDeliveryRuns(repo, { excludeRunId: runId });
  }
  const state = attachProgress(await loadState(repo, runId), config);
  await appendEvent(repo, state, { type: 'environment.codex', version: availability.version });
  await normalizeStateForResume(repo, state, config);
  return continueDelivery(repo, state, config);
}

async function startBackgroundRun({ cwd = process.cwd(), objective, options = {} }) {
  const initialRepo = await repositoryRootFor(cwd);
  const config = await loadConfig(initialRepo, options);
  const repo = await assertUsableRepository(initialRepo, { allowDirty: config.allowDirty });
  const availability = await codexAvailable(config.codexBinary);
  if (!availability.available) throw new Error(`Codex CLI '${config.codexBinary}' is not available.`);
  await notifyActiveDeliveryRuns(repo);
  const state = await initRun(repo, objective, config);
  await writeBackgroundRecord(repo, state.runId, {
    runId: state.runId,
    repo,
    mode: 'run',
    status: 'starting',
    startedAt: now(),
    updatedAt: now(),
    pid: null,
    backgroundLogPath: runPaths(repo, state.runId).backgroundLog,
  });
  const child = await spawnBackgroundProcess({ repo, runId: state.runId, mode: 'run', options });
  const record = await markBackgroundStarted(repo, state, 'run', child);
  return backgroundOutput(repo, state.runId, record);
}

async function startBackgroundResume({ cwd = process.cwd(), options = {} }) {
  const initialRepo = await repositoryRootFor(cwd);
  const config = await loadConfig(initialRepo, options);
  const repo = await assertUsableRepository(initialRepo, { allowDirty: config.allowDirty });
  const availability = await codexAvailable(config.codexBinary);
  if (!availability.available) throw new Error(`Codex CLI '${config.codexBinary}' is not available.`);
  const runId = options.run || await latestRunId(repo);
  if (!runId) throw new Error('No delivery run selected.');
  await assertNoActiveBackgroundForRun(repo, runId);
  await notifyActiveDeliveryRuns(repo, { excludeRunId: runId });
  const state = await loadState(repo, runId);
  if (state.phase === 'accepted') throw new UserFacingError(`Run ${runId} is already accepted; nothing to resume.`);
  await writeBackgroundRecord(repo, runId, {
    runId,
    repo,
    mode: 'resume',
    status: 'starting',
    startedAt: now(),
    updatedAt: now(),
    pid: null,
    backgroundLogPath: runPaths(repo, runId).backgroundLog,
  });
  const child = await spawnBackgroundProcess({ repo, runId, mode: 'resume', options });
  const record = await markBackgroundStarted(repo, state, 'resume', child);
  return backgroundOutput(repo, runId, record);
}

async function backgroundChildCommand(options) {
  const repo = await repositoryRootFor(await repoCwdFromOptions(options));
  const runId = options.run;
  if (!runId) throw new Error('Background child requires --run <id>.');
  const mode = options.mode === 'resume' ? 'resume' : 'run';
  let exitCode = 0;
  let final = null;
  const heartbeat = setInterval(async () => {
    try {
      await updateBackgroundRecord(repo, runId, { status: 'running', pid: process.pid, lastHeartbeatAt: now() });
      const state = await loadState(repo, runId);
      await appendEvent(repo, state, { type: 'background.heartbeat', pid: process.pid, mode });
    } catch {
      // Heartbeat is best-effort and must not interrupt delivery.
    }
  }, 30_000);
  heartbeat.unref();
  try {
    await updateBackgroundRecord(repo, runId, { status: 'running', pid: process.pid, lastHeartbeatAt: now() });
    final = mode === 'resume'
      ? await resumeDelivery({ cwd: repo, options: { ...options, backgroundChild: true } })
      : await continueInitializedDelivery({ cwd: repo, options: { ...options, backgroundChild: true } });
    return final;
  } catch (error) {
    exitCode = 1;
    throw error;
  } finally {
    clearInterval(heartbeat);
    const finishedAt = now();
    try {
      const record = await updateBackgroundRecord(repo, runId, {
        status: exitCode === 0 ? 'exited' : 'failed',
        pid: process.pid,
        finishedAt,
        lastHeartbeatAt: finishedAt,
        exitCode,
        signal: null,
      });
      const state = await loadState(repo, runId);
      state.background = { ...record, backgroundLogPath: record.backgroundLogPath ? path.relative(repo, record.backgroundLogPath) : null };
      await appendEvent(repo, state, { type: 'background.exited', pid: process.pid, mode, exitCode, signal: null });
      await saveState(repo, state);
    } catch {
      // The process result is still represented by its exit code and background log.
    }
  }
}

async function latestRunId(repo) {
  const latest = path.join(repo, '.codex', 'delivery-runs', 'latest');
  try {
    return (await readFile(latest, 'utf8')).trim();
  } catch {
    const root = path.join(repo, '.codex', 'delivery-runs');
    const entries = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    return entries[0] ?? null;
  }
}

async function statusCommand(options) {
  const repo = await repositoryRootFor(await repoCwdFromOptions(options));
  const runId = options.run || await latestRunId(repo);
  if (!runId) throw new Error('No delivery runs found.');
  const state = await loadState(repo, runId);
  let output = `${await readFile(runPaths(repo, runId).summary, 'utf8')}\n`;
  const background = await readBackgroundRecord(repo, runId);
  if (background) {
    output += [
      '## Background',
      '',
      `- **Status:** ${background.status ?? 'unknown'}`,
      `- **PID:** ${background.pid ?? '—'}`,
      `- **Alive:** ${background.pid ? String(processAlive(background.pid)) : 'false'}`,
      `- **Mode:** ${background.mode ?? '—'}`,
      `- **Started:** ${background.startedAt ?? '—'}`,
      `- **Last heartbeat:** ${background.lastHeartbeatAt ?? '—'}`,
      `- **Finished:** ${background.finishedAt ?? '—'}`,
      `- **Log:** ${background.backgroundLogPath ? path.relative(repo, background.backgroundLogPath) : '—'}`,
      '',
    ].join('\n');
  }
  process.stdout.write(output);
  return state;
}

async function reportCommand(options) {
  const repo = await repositoryRootFor(await repoCwdFromOptions(options));
  const runId = options.run || await latestRunId(repo);
  if (!runId) throw new Error('No delivery runs found.');
  const paths = runPaths(repo, runId);
  const state = await loadState(repo, runId);
  const background = await readBackgroundRecord(repo, runId);
  process.stdout.write(`${JSON.stringify({ runId, phase: state.phase, ...paths, integration: state.integration, background, final: state.final }, null, 2)}\n`);
}

async function readEventsChunk(file, offset) {
  const info = await stat(file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return { offset, text: '' };
  const start = Math.min(offset, info.size);
  const length = info.size - start;
  if (length <= 0) return { offset: info.size, text: '' };
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { offset: info.size, text: buffer.toString('utf8') };
  } finally {
    await handle.close();
  }
}

async function logsCommand(options) {
  const repo = await repositoryRootFor(await repoCwdFromOptions(options));
  const runId = options.run || await latestRunId(repo);
  if (!runId) throw new Error('No delivery runs found.');
  const eventsPath = runPaths(repo, runId).events;
  let offset = 0;
  let pending = '';
  let terminalSeen = false;
  const printNew = async () => {
    const chunk = await readEventsChunk(eventsPath, offset);
    offset = chunk.offset;
    if (!chunk.text) return false;
    const lines = `${pending}${chunk.text}`.split(/\r?\n/);
    pending = lines.pop() ?? '';
    let printed = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        terminalSeen ||= isTerminalProgressEvent(event);
        const rendered = renderProgressLine(event, { verbose: Boolean(options.verbose), repo });
        if (rendered) {
          process.stdout.write(`${rendered}\n`);
          printed = true;
        }
      } catch {
        // Ignore partial or corrupt lines; durable files remain available for manual inspection.
      }
    }
    return printed;
  };
  await printNew();
  if (!options.follow) return;
  while (true) {
    await delay(1000);
    await printNew();
    if (terminalSeen) break;
    const state = await loadState(repo, runId).catch(() => null);
    if (state && ['accepted', 'blocked', 'failed'].includes(state.phase)) {
      await printNew();
      break;
    }
    const background = await readBackgroundRecord(repo, runId).catch(() => null);
    if (background && ['exited', 'failed', 'stopped'].includes(background.status) && !processAlive(background.pid)) {
      await printNew();
      break;
    }
  }
}

async function waitForProcessExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await delay(250);
  }
  return !processAlive(pid);
}

async function stopCommand(options) {
  const repo = await repositoryRootFor(await repoCwdFromOptions(options));
  const runId = options.run || await latestRunId(repo);
  if (!runId) throw new Error('No delivery run selected.');
  const state = await loadState(repo, runId);
  const background = await readBackgroundRecord(repo, runId);
  if (!background?.pid) throw new UserFacingError(`Run ${runId} has no background process metadata.`);
  await appendEvent(repo, state, { type: 'background.stop.requested', pid: background.pid, mode: background.mode });
  await updateBackgroundRecord(repo, runId, { status: 'stop_requested', stopRequestedAt: now() });
  let signalSent = false;
  let signalError = null;
  try {
    process.kill(backgroundSignalTarget(background.pid), 'SIGTERM');
    signalSent = true;
  } catch (error) {
    signalError = error?.code ?? error?.message ?? String(error);
  }
  const exited = signalSent ? await waitForProcessExit(background.pid) : !processAlive(background.pid);
  const finalRecord = await updateBackgroundRecord(repo, runId, {
    status: exited ? 'stopped' : 'stop_requested',
    finishedAt: exited ? now() : background.finishedAt ?? null,
    signal: signalSent ? 'SIGTERM' : null,
  });
  state.background = { ...finalRecord, backgroundLogPath: finalRecord.backgroundLogPath ? path.relative(repo, finalRecord.backgroundLogPath) : null };
  await saveState(repo, state);
  process.stdout.write(`${JSON.stringify({
    runId,
    pid: background.pid,
    signalSent,
    signalError,
    exited,
    status: finalRecord.status,
  }, null, 2)}\n`);
}

async function cleanupCommand(options) {
  const repo = await repositoryRootFor(await repoCwdFromOptions(options));
  const runId = options.run || await latestRunId(repo);
  if (!runId) throw new Error('No delivery run selected.');
  const state = await loadState(repo, runId);
  for (const item of state.workstreams) {
    if (item.worktreePath) await removeWorktree(repo, item.worktreePath, item.branch);
  }
  if (options.integration && state.integration.worktreePath) await removeWorktree(repo, state.integration.worktreePath, state.integration.branch);
  await git(repo, ['worktree', 'prune'], { rejectOnError: false });
  if (options.logs) await rm(runPaths(repo, runId).root, { recursive: true, force: true });
  process.stdout.write(`Cleaned run ${runId}. Integration worktree ${options.integration ? 'removed' : 'preserved'}.\n`);
}

function usage() {
  return `Codex Delivery Kit

Usage:
  node .codex/delivery-kit/cli.mjs run "<objective>" [options]
  node .codex/delivery-kit/cli.mjs run --repo <path> "<objective>" [options]
  node .codex/delivery-kit/cli.mjs run <path> "<objective>" [options]
  node .codex/delivery-kit/cli.mjs resume [--repo <path>] [--run <id>] [options]
  node .codex/delivery-kit/cli.mjs logs [--repo <path>] [--run <id>] [--follow] [--verbose]
  node .codex/delivery-kit/cli.mjs status [--repo <path>] [--run <id>]
  node .codex/delivery-kit/cli.mjs report [--repo <path>] [--run <id>]
  node .codex/delivery-kit/cli.mjs stop [--repo <path>] [--run <id>]
  node .codex/delivery-kit/cli.mjs cleanup [--repo <path>] [--run <id>] [--integration] [--logs]

Run/resume options:
  --max-parallel <n>    Maximum parallel writer worktrees
  --repo <path>         Git repository to run against or inspect
  --run <id>            Existing run to inspect, resume, or clean
  --max-repairs <n>     Maximum repair iterations
  --timeout-minutes <n> Per Codex turn and validation command timeout
  --model <name>        Override the default Codex model for all roles
  --background          Start run/resume in a detached background process
  --quiet               Suppress live progress output
  --verbose             Print additional sanitized progress details
  --raw                 Retain raw Codex JSONL in addition to sanitized events
  --allow-dirty         Allow starting from a dirty repository (not recommended)
  --keep-worktrees      Keep completed worker worktrees
`;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h' || options.help || options.h) {
    process.stdout.write(usage());
  } else if (command === 'run') {
    const { cwd, objective } = await parseRunTarget(options);
    if (options.background) {
      const started = await startBackgroundRun({ cwd, objective, options });
      process.stdout.write(`${JSON.stringify(started, null, 2)}\n`);
    } else {
      const final = await executeDelivery({ cwd, objective, options });
      process.stdout.write(`${JSON.stringify(final, null, 2)}\n`);
    }
  } else if (command === 'resume') {
    if (options.background) {
      const started = await startBackgroundResume({ cwd: await repoCwdFromOptions(options), options });
      process.stdout.write(`${JSON.stringify(started, null, 2)}\n`);
    } else {
      const final = await resumeDelivery({ cwd: await repoCwdFromOptions(options), options });
      process.stdout.write(`${JSON.stringify(final, null, 2)}\n`);
    }
  } else if (command === '__background') {
    const final = await backgroundChildCommand(options);
    process.stdout.write(`${JSON.stringify(final, null, 2)}\n`);
  } else if (command === 'logs') {
    await logsCommand(options);
  } else if (command === 'status') {
    await statusCommand(options);
  } else if (command === 'report') {
    await reportCommand(options);
  } else if (command === 'stop') {
    await stopCommand(options);
  } else if (command === 'cleanup') {
    await cleanupCommand(options);
  } else {
    process.stdout.write(usage());
  }
}

function formatError(error) {
  const message = error?.message ?? String(error);
  if (error instanceof UserFacingError) return message;
  if (message.startsWith('Repository has uncommitted changes.')) return message;
  if (/^Codex CLI '.+' is not available\.$/.test(message)) return message;
  if (/git rev-parse --show-toplevel failed/.test(message)) {
    return 'No Git repository found. Run this command from a Git repository or pass --repo <path>.';
  }
  return error?.stack ?? message;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`[codex-delivery] ${formatError(error)}\n`);
    process.exitCode = 1;
  });
}
