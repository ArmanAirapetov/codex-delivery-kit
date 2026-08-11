#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { lstat, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  appendJsonl,
  appendEvent,
  appendResult,
  attachEventSink,
  createInitialState,
  ensureDir,
  instantiateWorkstreams,
  loadState,
  newRunId,
  now,
  normalizeRelative,
  readJson,
  readyWorkstreams,
  redactText,
  runPaths,
  saveState,
  scopeMatches,
  serializeOverlappingWorkstreams,
  sha256,
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
  statusPorcelain,
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
import { runTerminalTui } from './lib/tui.mjs';

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_ROOT = path.join(KIT_ROOT, 'delivery', 'schemas');
const CLI_PATH = fileURLToPath(import.meta.url);
const BOOLEAN_OPTIONS = new Set([
  'allowDirty',
  'all',
  'background',
  'follow',
  'help',
  'h',
  'integration',
  'json',
  'keepWorktrees',
  'logs',
  'noColor',
  'noAutoInstallDeps',
  'quiet',
  'raw',
  'tui',
  'verbose',
]);
const BACKGROUND_TERMINAL_STATUSES = new Set(['exited', 'failed', 'stopped']);
const DELIVERY_TERMINAL_PHASES = new Set(['accepted', 'blocked', 'failed']);
const DEFAULT_FOLLOW_TAIL = 80;
const HUMAN_REVIEW_DECISION_VALUES = [
  'repair_requested',
  'environment_required',
  'manual_required',
  'acknowledged',
];
const HUMAN_REVIEW_DECISIONS = new Set(HUMAN_REVIEW_DECISION_VALUES);
const HUMAN_REVIEW_DECISION_SHORTCUTS = new Map([
  ['r', 'repair_requested'],
  ['repair', 'repair_requested'],
  ['e', 'environment_required'],
  ['env', 'environment_required'],
  ['environment', 'environment_required'],
  ['m', 'manual_required'],
  ['manual', 'manual_required'],
  ['a', 'acknowledged'],
  ['ack', 'acknowledged'],
]);
const HUMAN_REVIEW_DECISION_META = {
  repair_requested: {
    shortcut: 'r',
    label: 'Approve Codex repair',
    description: 'Let resume fix code/config/manifests and prepare project deps needed for validation.',
    color: 'cyan',
  },
  environment_required: {
    shortcut: 'e',
    label: 'Fix locally first',
    description: 'Use only for missing system tools, services, credentials, or setup Codex cannot change in the repo.',
    color: 'yellow',
  },
  manual_required: {
    shortcut: 'm',
    label: 'Manual work',
    description: 'Record that a human must handle or verify this outside automated repair.',
    color: 'magenta',
  },
  acknowledged: {
    shortcut: 'a',
    label: 'Acknowledge only',
    description: 'Record awareness without asking Codex to repair this item.',
    color: 'dim',
  },
};
const BLOCKING_FINDING_SEVERITIES = new Set(['critical', 'high', 'medium']);
export const DEFAULT_CONFIG = {
  codexBinary: 'codex',
  maxParallel: 4,
  maxRepairs: 2,
  timeoutMinutes: 60,
  capacityRetryAttempts: 2,
  capacityRetryDelaySeconds: 15,
  retainRawEvents: false,
  keepWorkerWorktrees: false,
  autoInstallProjectDependencies: true,
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
    'npm --prefix ',
    'pytest', 'python -m pytest', 'python3 -m pytest', 'python -m compileall ', 'python3 -m compileall ',
    'ruff ', 'mypy ',
    'cargo test', 'cargo check', 'cargo clippy', 'go test', 'go vet',
    'make', 'cmake --build', './gradlew ', 'gradle ', 'mvn ', 'dotnet test',
    'docker compose config ', 'docker-compose config ',
    'node ', 'bash scripts/', './scripts/',
  ],
};

const LEGACY_DEFAULT_ALLOWED_VALIDATION_PREFIXES = [
  'npm test', 'npm run ', 'npx ', 'pnpm ', 'yarn ', 'bun ',
  'pytest', 'python -m pytest', 'python3 -m pytest', 'ruff ', 'mypy ',
  'cargo test', 'cargo check', 'cargo clippy', 'go test', 'go vet',
  'make', 'cmake --build', './gradlew ', 'gradle ', 'mvn ', 'dotnet test',
  'node ', 'bash scripts/', './scripts/',
];

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

function createCliTheme(stream = process.stdout, options = {}) {
  const force = process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0';
  const enabled = !options.noColor && !process.env.NO_COLOR && process.env.TERM !== 'dumb' && (force || stream?.isTTY);
  const codes = {
    reset: '\u001b[0m',
    bold: '\u001b[1m',
    dim: '\u001b[2m',
    red: '\u001b[31m',
    green: '\u001b[32m',
    yellow: '\u001b[33m',
    blue: '\u001b[34m',
    magenta: '\u001b[35m',
    cyan: '\u001b[36m',
    gray: '\u001b[90m',
  };
  const paint = (style, value) => {
    const text = String(value ?? '');
    return enabled && codes[style] ? `${codes[style]}${text}${codes.reset}` : text;
  };
  return {
    enabled,
    bold: (value) => paint('bold', value),
    dim: (value) => paint('dim', value),
    red: (value) => paint('red', value),
    green: (value) => paint('green', value),
    yellow: (value) => paint('yellow', value),
    blue: (value) => paint('blue', value),
    magenta: (value) => paint('magenta', value),
    cyan: (value) => paint('cyan', value),
    gray: (value) => paint('gray', value),
    decision(decision, value = decision) {
      const meta = HUMAN_REVIEW_DECISION_META[decision];
      return paint(meta?.color ?? 'bold', value);
    },
  };
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

function mergeAllowedValidationPrefixes(base, override) {
  if (!Array.isArray(override?.allowedValidationPrefixes)) return base.allowedValidationPrefixes;
  const configured = override.allowedValidationPrefixes;
  const knownManagedDefaults = new Set([...base.allowedValidationPrefixes, ...LEGACY_DEFAULT_ALLOWED_VALIDATION_PREFIXES]);
  const looksManaged = configured.every((prefix) => knownManagedDefaults.has(prefix));
  if (!looksManaged) return configured;
  return [...new Set([...base.allowedValidationPrefixes, ...configured])];
}

export function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    reasoning: { ...base.reasoning, ...(override?.reasoning ?? {}) },
    models: { ...base.models, ...(override?.models ?? {}) },
    allowedValidationPrefixes: mergeAllowedValidationPrefixes(base, override),
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
  if (options.noAutoInstallDeps) config.autoInstallProjectDependencies = false;
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

function backgroundIsStale(record) {
  return Boolean(record?.pid && !processAlive(record.pid) && !BACKGROUND_TERMINAL_STATUSES.has(record.status));
}

function renderBackgroundStaleLine(record) {
  return `[background] stale pid=${record.pid} status=${record.status ?? 'unknown'}; process is not alive. Resume can archive running workstreams and retry.`;
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
    if (backgroundIsStale(background)) continue;
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
    maxCapacityRetries: config.capacityRetryAttempts,
    capacityRetryDelayMs: Number(config.capacityRetryDelaySeconds) * 1000,
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
  const serialized = serializeOverlappingWorkstreams(workstreams);
  validateWorkstreams(serialized.workstreams, new Set(acceptanceCriteria.map((item) => item.id)));
  const covered = new Set(workstreams.filter((item) => item.required !== false).flatMap((item) => item.criterionIds));
  const missing = acceptanceCriteria.filter((item) => !covered.has(item.id));
  if (missing.length) throw new Error(`Required workstreams do not cover: ${missing.map((item) => item.id).join(', ')}`);
  return { acceptanceCriteria, workstreams: serialized.workstreams, addedDependencies: serialized.addedDependencies };
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
  await writeJsonAtomic(path.join(runPaths(repo, state.runId).artifacts, 'plan.json'), { ...run.final, workstreams: normalized.workstreams });
  if (normalized.addedDependencies.length) {
    await appendEvent(repo, state, { type: 'workflow.plan.normalized', addedDependencies: normalized.addedDependencies });
  }
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

function normalizedCommand(command) {
  return String(command ?? '').trim().replace(/\s+/g, ' ');
}

function isDeliveryWorkflowCommand(command) {
  return /^delivery_[a-z_]+(?:\s|$)/.test(normalizedCommand(command));
}

function isDependencySetupCommand(command) {
  const normalized = normalizedCommand(command);
  return [
    /^python(?:3)? -m pip install(?:\s|$)/,
    /^python(?:3)? -m ensurepip(?:\s|$)/,
    /^pip(?:3)? install(?:\s|$)/,
    /^npm install(?:\s|$)/,
    /^pnpm install(?:\s|$)/,
    /^yarn install(?:\s|$)/,
    /^bun install(?:\s|$)/,
  ].some((pattern) => pattern.test(normalized));
}

function localValidationCommandsFor(workstream) {
  return new Set((workstream.localValidationCommands ?? []).map(normalizedCommand).filter(Boolean));
}

function isToolUnavailableFailure(check) {
  const command = normalizedCommand(check?.command);
  const summary = String(check?.summary ?? '');
  if (/^python(?:3)? -m pytest(?:\s|$)/.test(command)) {
    return /No module named pytest|pytest[^.]*not installed|pytest[^.]*unavailable|pytest[^.]*not found/i.test(summary);
  }
  if (/^npm --prefix \S+ run(?:\s|$)/.test(command)) {
    return /(?:tsc|vite|vitest|eslint|prettier|webpack|rollup): not found|Cannot find module/i.test(summary);
  }
  if (/^node\s+.*validate.*\.mjs(?:\s|$)/.test(command)) {
    return /(?:NOT RUN|No module named|dependency-backed|frontend dependencies|web\/node_modules|tsc: not found|vite: not found|vitest: not found|pytest)/i.test(summary);
  }
  return /command not found|executable not found|tool(?:ing)? unavailable|dependency unavailable/i.test(summary);
}

function isProjectDependencyBlockedCheck(check) {
  const summary = String(check?.summary ?? '');
  if (isToolUnavailableFailure(check)) return true;
  return projectDependencyFailure({ command: check?.command, error: summary }, summary);
}

export function dependencySetupDeferredWorkstream(workstream, final) {
  if ((workstream.repairIteration ?? 0) <= 0) return false;
  if (final?.status !== 'blocked') return false;
  if ((final?.results?.length ?? 0) === 0) return false;
  const checks = final?.checks ?? [];
  const incomplete = checks.filter((check) => ['failed', 'not_run'].includes(check?.status));
  if (!incomplete.length) return false;
  return incomplete.every(isProjectDependencyBlockedCheck);
}

function isNonBlockingWorkerFailedCheck(workstream, check) {
  if (check?.status !== 'failed') return false;
  const command = normalizedCommand(check.command);
  if (isDeliveryWorkflowCommand(command)) return true;
  if (isDependencySetupCommand(command)) return true;
  if (localValidationCommandsFor(workstream).has(command) && isToolUnavailableFailure(check)) return true;
  return false;
}

function blockingWorkerFailedChecks(workstream, checks = []) {
  return checks.filter((check) => check?.status === 'failed' && !isNonBlockingWorkerFailedCheck(workstream, check));
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
  const blockingFailedChecks = blockingWorkerFailedChecks(workstream, run.final?.checks ?? []);
  const nonBlockingFailedChecks = failedChecks.filter((check) => !blockingFailedChecks.includes(check));
  if (nonBlockingFailedChecks.length) {
    await appendEvent(repo, state, {
      type: 'workstream.checks.nonblocking',
      workstreamId: workstream.id,
      commands: nonBlockingFailedChecks.map((item) => item.command),
    });
  }
  const hasEvidence = (run.final?.results?.length ?? 0) > 0 && (run.final?.checks?.length ?? 0) > 0;
  const deferredDependencySetup = run.ok && forbidden.length === 0 && dependencySetupDeferredWorkstream(workstream, run.final);
  const completed = (run.ok && run.final.status === 'completed' && forbidden.length === 0 && blockingFailedChecks.length === 0 && hasEvidence)
    || deferredDependencySetup;
  if (!completed) {
    workstream.status = 'failed';
    workstream.finishedAt = now();
    workstream.changedPaths = actualPaths;
    workstream.result = run.final;
    workstream.error = forbidden.length
      ? `Out-of-scope paths: ${forbidden.join(', ')}`
      : blockingFailedChecks.length
        ? `Failed local checks: ${blockingFailedChecks.map((item) => item.command).join(', ')}`
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
  if (!commit && workstream.required && !deferredDependencySetup) {
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
  if (deferredDependencySetup) {
    await appendEvent(repo, state, {
      type: 'workstream.dependency-setup.deferred',
      workstreamId: workstream.id,
      checks: (run.final?.checks ?? [])
        .filter((check) => ['failed', 'not_run'].includes(check?.status))
        .map((check) => check.command),
    });
  }
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

export function safeValidationCommand(command, config) {
  const trimmed = command.trim();
  if (!trimmed || hasUnsafeShellSyntax(trimmed)) return false;
  return config.allowedValidationPrefixes.some((prefix) => trimmed === prefix.trim() || trimmed.startsWith(prefix));
}

async function runValidation(repo, state, config) {
  state.validation.runs = [];
  const setup = await prepareProjectDependencySetup(repo, state, config);
  await setup.runInitial();
  for (let index = 0; index < state.validation.commands.length; index += 1) {
    const command = state.validation.commands[index];
    await setup.runBeforeCommand(command);
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
      env: setup.env,
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

function countBy(values) {
  return values.reduce((acc, value) => {
    const key = String(value ?? 'unknown');
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function stableReviewItemId(prefix, seed, length = 10) {
  return `${prefix}-${sha256(JSON.stringify(seed)).slice(0, length)}`;
}

function relativeToRepo(repo, value) {
  if (!value) return null;
  const text = String(value);
  if (!path.isAbsolute(text)) return text.split(path.sep).join('/');
  const relative = path.relative(repo, text).split(path.sep).join('/');
  return relative && !relative.startsWith('../') ? relative : text;
}

function resolveArtifactPath(repo, value) {
  if (!value) return null;
  return path.isAbsolute(String(value)) ? String(value) : path.join(repo, String(value));
}

async function readLogExcerpt(repo, run, max = 2400) {
  const logPath = resolveArtifactPath(repo, run?.logPath);
  if (!logPath) return '';
  try {
    return redactText(await readFile(logPath, 'utf8'), max);
  } catch {
    return '';
  }
}

function projectDependencyFailure(run, logText = '') {
  const text = `${run?.error ?? ''}\n${logText ?? ''}`;
  const command = normalizedCommand(run?.command);
  if (/^python(?:3)? -m pytest(?:\s|$)/.test(command) && /pytest/i.test(text) && /(?:not installed|not available|not found|No module named)/i.test(text)) return true;
  if (/^python(?:3)? -m pytest(?:\s|$)/.test(command) && /No module named [A-Za-z0-9_.-]+/i.test(text)) return true;
  if (/^npm --prefix \S+ run /.test(command) && /(?:sh: \d+: (?:tsc|vite|vitest|eslint|prettier|webpack|rollup): not found|Cannot find module)/i.test(text)) return true;
  return false;
}

function localEnvironmentFailure(run, logText = '') {
  const text = `${run?.error ?? ''}\n${logText ?? ''}`;
  const command = normalizedCommand(run?.command);
  if (/(?:^|\s)(?:node|npm|pnpm|yarn|bun|python|python3|docker|docker-compose): command not found/i.test(text)) return true;
  if (/(?:executable not found|ENOENT)/i.test(text)) return true;
  if (/^docker compose(?:\s|$)|^docker-compose(?:\s|$)/.test(command)) {
    return /(?:docker: command not found|docker-compose: command not found|Cannot connect to the Docker daemon|Docker daemon)/i.test(text);
  }
  if (Number(run?.exitCode) === 127) {
    if (/^npm(?:\s|$)/.test(command) && /npm: not found|npm: command not found/i.test(text)) return true;
    if (/^python(?:3)?(?:\s|$)/.test(command) && /python(?:3)?: not found|python(?:3)?: command not found/i.test(text)) return true;
  }
  return false;
}

function defaultDecisionForValidation(run, logText = '') {
  if (/allowlist/i.test(String(run?.error ?? ''))) return 'repair_requested';
  if (projectDependencyFailure(run, logText)) return 'repair_requested';
  if (localEnvironmentFailure(run, logText)) return 'environment_required';
  return 'repair_requested';
}

function shellQuoteArg(value) {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function formatArgv(argv) {
  return argv.map(shellQuoteArg).join(' ');
}

async function fileExists(file) {
  try {
    const info = await stat(file);
    return info.isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function pythonBinaryForPytest(command) {
  const match = normalizedCommand(command).match(/^(python3?|python\d+(?:\.\d+)?) -m pytest(?:\s|$)/);
  return match?.[1] ?? null;
}

function npmPrefixForValidationCommand(command) {
  const normalized = normalizedCommand(command);
  const prefixed = normalized.match(/^npm --prefix ([^\s]+) run(?:\s|$)/);
  if (prefixed) return prefixed[1];
  if (/^npm (?:test|run)(?:\s|$)/.test(normalized)) return '.';
  return null;
}

async function pythonRequirementFiles(worktreePath) {
  const rootDev = 'requirements-dev.txt';
  if (await fileExists(path.join(worktreePath, rootDev))) return [rootDev];
  const rootRuntime = 'requirements.txt';
  if (await fileExists(path.join(worktreePath, rootRuntime))) return [rootRuntime];
  const candidates = [
    'backend/requirements-dev.txt',
    'backend/requirements.txt',
    'worker-agent/requirements.txt',
    'mcp-server/requirements.txt',
  ];
  const existing = [];
  for (const candidate of candidates) {
    if (await fileExists(path.join(worktreePath, candidate))) existing.push(candidate);
  }
  return existing;
}

function projectDependencyRepairApprovedFromContext(context) {
  return (context?.repairRequests ?? []).some((request) => {
    if (request.type !== 'validation') return false;
    return projectDependencyFailure(
      { command: request.command, error: request.summary ?? request.note ?? '' },
      `${request.summary ?? ''}\n${request.note ?? ''}`,
    );
  });
}

export async function projectDependencySetupApprovalContext(repo, state) {
  for (const review of [...(state.humanReviews ?? [])].reverse()) {
    const full = await readHumanReviewArtifact(repo, review);
    const context = full
      ? buildHumanRepairContext(full, { includeProjectDependencyEnvironment: true })
      : review?.repairContext;
    if (projectDependencyRepairApprovedFromContext(context)) return context;
  }
  return null;
}

async function projectDependencySetupApproved(repo, state, config) {
  if (!config.autoInstallProjectDependencies) return { approved: false, reason: 'disabled by config' };
  const context = await projectDependencySetupApprovalContext(repo, state);
  if (!context) return { approved: false, reason: 'no human-approved project dependency repair request' };
  return { approved: true, reason: `human review ${context.reviewId} approved project dependency repair`, context };
}

export async function buildProjectDependencySetupPlan(repo, state) {
  const worktreePath = state.integration?.worktreePath;
  const commands = [...new Set((state.validation?.commands ?? []).map(normalizedCommand).filter(Boolean))];
  const steps = [];
  const env = {};
  if (!worktreePath) return { worktreePath: null, commands, steps, env };

  const pythonBinary = commands.map(pythonBinaryForPytest).find(Boolean);
  if (pythonBinary) {
    const requirements = await pythonRequirementFiles(worktreePath);
    if (requirements.length) {
      const venvPath = path.join(runPaths(repo, state.runId).artifacts, 'validation-env', 'python');
      const binDir = path.join(venvPath, process.platform === 'win32' ? 'Scripts' : 'bin');
      const venvPython = path.join(binDir, process.platform === 'win32' ? 'python.exe' : 'python');
      steps.push({
        id: 'python-venv',
        kind: 'python-venv',
        cwd: worktreePath,
        argv: [pythonBinary, '-m', 'venv', venvPath],
      });
      for (const requirement of requirements) {
        steps.push({
          id: `python-install-${slugify(requirement, 40)}`,
          kind: 'python-install',
          dependsOn: 'python-venv',
          cwd: worktreePath,
          argv: [venvPython, '-m', 'pip', 'install', '-r', requirement],
        });
      }
      env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
      env.VIRTUAL_ENV = venvPath;
      env.PYTHONDONTWRITEBYTECODE = '1';
    }
  }

  const npmPrefixes = [...new Set(commands.map(npmPrefixForValidationCommand).filter(Boolean))];
  for (const prefix of npmPrefixes) {
    let relativePrefix;
    try {
      relativePrefix = normalizeRelative(prefix, worktreePath);
    } catch {
      continue;
    }
    if (!await fileExists(path.join(worktreePath, relativePrefix, 'package.json'))) continue;
    const hasLock = await fileExists(path.join(worktreePath, relativePrefix, 'package-lock.json'));
    const npmInstallArgs = hasLock ? ['npm', '--prefix', relativePrefix, 'ci'] : ['npm', '--prefix', relativePrefix, 'install', '--no-package-lock'];
    steps.push({
      id: `npm-${slugify(relativePrefix, 40)}`,
      kind: 'npm-install',
      cwd: worktreePath,
      argv: npmInstallArgs,
    });
  }

  return {
    worktreePath,
    commands,
    steps: steps.map((step) => ({ ...step, command: formatArgv(step.argv) })),
    env,
  };
}

function validationCommandNeedsNpmSetup(command) {
  const normalized = normalizedCommand(command);
  return Boolean(npmPrefixForValidationCommand(normalized)) || /^node\s+.*validate-product.*\.mjs(?:\s|$)/.test(normalized);
}

async function pathExists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function removeStaleNpmArtifacts(repo, state, plan) {
  const removed = [];
  for (const step of plan.steps.filter((candidate) => candidate.kind === 'npm-install')) {
    const prefixIndex = step.argv.indexOf('--prefix');
    if (prefixIndex === -1) continue;
    const prefix = step.argv[prefixIndex + 1];
    if (!prefix) continue;
    let nodeModulesRelative;
    try {
      nodeModulesRelative = normalizeRelative(path.join(prefix, 'node_modules'), step.cwd);
    } catch {
      continue;
    }
    const nodeModulesPath = path.join(step.cwd, nodeModulesRelative);
    if (!await pathExists(nodeModulesPath)) continue;
    await rm(nodeModulesPath, { recursive: true, force: true });
    removed.push(nodeModulesRelative);
  }
  if (removed.length) {
    await appendEvent(repo, state, { type: 'validation.setup.cleaned', paths: removed });
  }
}

async function prepareProjectDependencySetup(repo, state, config) {
  state.validation.setupRuns = [];
  const approval = await projectDependencySetupApproved(repo, state, config);
  if (!approval.approved) {
    state.validation.setup = { enabled: false, reason: approval.reason, steps: [] };
    return { env: process.env, runInitial: async () => {}, runBeforeCommand: async () => {} };
  }

  const plan = await buildProjectDependencySetupPlan(repo, state);
  state.validation.setup = {
    enabled: true,
    reason: approval.reason,
    steps: plan.steps.map((step) => ({ id: step.id, kind: step.kind, command: step.command })),
  };
  if (!plan.steps.length) {
    await appendEvent(repo, state, { type: 'validation.setup.skipped', reason: 'no dependency setup commands could be derived from validation commands and checked-in manifests' });
    return { env: { ...process.env, ...plan.env }, runInitial: async () => {}, runBeforeCommand: async () => {} };
  }

  let planAnnounced = false;
  const failedStepIds = new Set();
  const finishedStepIds = new Set();
  const setupEnv = { ...process.env, ...plan.env };
  let staleNpmArtifactsRemoved = false;

  const runSteps = async (predicate) => {
    const selected = plan.steps.filter((step) => predicate(step));
    if (!selected.some((step) => !finishedStepIds.has(step.id))) return;
    if (!planAnnounced) {
      planAnnounced = true;
      await appendEvent(repo, state, { type: 'validation.setup.plan', steps: plan.steps.length, reason: approval.reason });
    }
    for (const step of selected) {
      if (finishedStepIds.has(step.id)) continue;
      const index = plan.steps.findIndex((candidate) => candidate.id === step.id);
      const logPath = path.join(runPaths(repo, state.runId).commands, `validation-setup-${String(index + 1).padStart(2, '0')}.log`);
      if (step.dependsOn && failedStepIds.has(step.dependsOn)) {
        const record = {
          command: step.command,
          kind: step.kind,
          ok: false,
          skipped: true,
          exitCode: null,
          durationMs: 0,
          logPath: path.relative(repo, logPath),
          error: `Skipped because setup step '${step.dependsOn}' failed.`,
        };
        await writeFile(logPath, `${record.error}\n`, 'utf8');
        state.validation.setupRuns.push(record);
        await appendEvent(repo, state, { type: 'validation.setup.skipped', command: step.command, reason: record.error, index: index + 1, total: plan.steps.length });
        finishedStepIds.add(step.id);
        continue;
      }

      await appendEvent(repo, state, { type: 'validation.setup.started', command: step.command, kind: step.kind, index: index + 1, total: plan.steps.length, logPath: path.relative(repo, logPath) });
      let result;
      try {
        result = await runProcess(step.argv[0], step.argv.slice(1), {
          cwd: step.cwd,
          env: setupEnv,
          timeoutMs: config.timeoutMinutes * 60 * 1000,
          maxOutputBytes: 6 * 1024 * 1024,
        });
      } catch (error) {
        result = { code: -1, signal: null, stdout: '', stderr: error.message, durationMs: 0 };
      }
      const output = `${result.stdout}\n${result.stderr}`;
      await writeFile(logPath, redactText(output, 6 * 1024 * 1024), 'utf8');
      const record = {
        command: step.command,
        kind: step.kind,
        ok: result.code === 0,
        exitCode: result.code,
        durationMs: result.durationMs,
        logPath: path.relative(repo, logPath),
      };
      state.validation.setupRuns.push(record);
      if (!record.ok) failedStepIds.add(step.id);
      finishedStepIds.add(step.id);
      await appendEvent(repo, state, { type: 'validation.setup.completed', command: step.command, kind: step.kind, ok: record.ok, exitCode: record.exitCode, durationMs: record.durationMs, logPath: record.logPath });
    }
    await saveState(repo, state);
  };

  return {
    env: setupEnv,
    runInitial: async () => {
      if (!staleNpmArtifactsRemoved) {
        staleNpmArtifactsRemoved = true;
        await removeStaleNpmArtifacts(repo, state, plan);
      }
      await runSteps((step) => step.kind.startsWith('python-'));
    },
    runBeforeCommand: async (command) => {
      if (!validationCommandNeedsNpmSetup(command)) return;
      await runSteps((step) => step.kind === 'npm-install');
    },
  };
}

function itemCounts(items) {
  return {
    total: items.length,
    validation: items.filter((item) => item.type === 'validation').length,
    criteria: items.filter((item) => item.type === 'criterion').length,
    findings: items.filter((item) => item.type === 'finding').length,
    byDefaultDecision: countBy(items.map((item) => item.defaultDecision)),
  };
}

function decisionCounts(decisions) {
  return {
    total: decisions.length,
    byDecision: countBy(decisions.map((item) => item.decision)),
  };
}

function reviewItemDecisionSeed(item) {
  return {
    itemId: item.id,
    type: item.type,
    title: item.title,
    command: item.command ?? null,
    criterionId: item.criterionId ?? null,
    role: item.role ?? null,
    severity: item.severity ?? null,
    paths: item.paths ?? [],
    criterionIds: item.criterionIds ?? [],
  };
}

function recommendedMaxRepairsFor(state, items) {
  if (!items.length) return Number(state.maxRepairs ?? DEFAULT_CONFIG.maxRepairs);
  return Math.max(Number(state.maxRepairs ?? DEFAULT_CONFIG.maxRepairs), Number(state.repairIteration ?? 0) + 1);
}

export async function buildHumanReviewInbox(repo, state, { includeLogExcerpts = true, background = null } = {}) {
  const gate = state.final?.gate ?? qualityGate(state);
  const items = [];

  const failedCommands = gate.failedCommands?.length
    ? gate.failedCommands
    : (state.validation?.runs ?? []).filter((run) => !run.ok);
  for (const run of failedCommands) {
    const logExcerpt = includeLogExcerpts ? await readLogExcerpt(repo, run) : '';
    const summaryParts = [
      run?.error,
      run?.exitCode !== null && run?.exitCode !== undefined && Number.isFinite(Number(run.exitCode)) ? `exit=${run.exitCode}` : null,
      logExcerpt ? `log excerpt: ${logExcerpt.replace(/\s+/g, ' ').trim()}` : null,
    ].filter(Boolean);
    const defaultDecision = defaultDecisionForValidation(run, logExcerpt);
    items.push({
      id: stableReviewItemId('VAL', [normalizedCommand(run?.command)]),
      type: 'validation',
      status: 'failed',
      title: `Validation failed: ${normalizedCommand(run?.command) || 'unknown command'}`,
      summary: redactText(summaryParts.join(' | ') || 'Validation command failed.', 1200),
      defaultDecision,
      command: normalizedCommand(run?.command),
      exitCode: run?.exitCode ?? null,
      durationMs: run?.durationMs ?? null,
      logPath: relativeToRepo(repo, run?.logPath),
      logExcerpt,
    });
  }

  const criteriaById = new Map((state.acceptanceCriteria ?? []).map((item) => [item.id, item]));
  const failedCriteria = gate.failedCriteria?.length
    ? gate.failedCriteria
    : (state.verification?.criteria ?? []).filter((item) => item.status !== 'proven');
  for (const criterion of failedCriteria) {
    const criterionId = String(criterion.id ?? 'unknown');
    const text = criteriaById.get(criterionId)?.text ?? criterion.text ?? 'Acceptance criterion is not proven.';
    items.push({
      id: `AC-${criterionId.replace(/^AC-/, '')}`,
      type: 'criterion',
      status: criterion.status ?? 'unknown',
      title: `${criterionId}: ${criterion.status ?? 'unknown'}`,
      summary: redactText(text, 1200),
      defaultDecision: 'repair_requested',
      criterionId,
      evidence: (criterion.evidence ?? []).map((item) => redactText(item, 800)),
      paths: [...new Set((criterion.paths ?? []).map(String))],
      commands: [...new Set((criterion.commands ?? []).map(String))],
    });
  }

  const blockingFindings = gate.blockingFindings?.length
    ? gate.blockingFindings
    : (state.reviews ?? [])
      .flatMap((review) => (review.findings ?? []).map((finding) => ({ ...finding, role: review.role })))
      .filter((finding) => BLOCKING_FINDING_SEVERITIES.has(finding.severity));
  for (const finding of blockingFindings) {
    const role = finding.role ?? 'review';
    items.push({
      id: stableReviewItemId(`F-${slugify(role, 20)}`, [finding.title, finding.summary, finding.paths, finding.criterionIds]),
      type: 'finding',
      status: 'blocking',
      title: finding.title ?? `${finding.severity ?? 'review'} finding`,
      summary: redactText(finding.summary ?? finding.recommendation ?? 'Blocking review finding.', 1200),
      defaultDecision: 'repair_requested',
      role,
      severity: finding.severity ?? 'medium',
      recommendation: finding.recommendation ? redactText(finding.recommendation, 1200) : null,
      reproduction: (finding.reproduction ?? []).map((item) => redactText(item, 800)),
      paths: [...new Set((finding.paths ?? []).map(String))],
      criterionIds: [...new Set((finding.criterionIds ?? []).map(String))],
    });
  }

  const findingRoles = new Set(blockingFindings.map((finding) => finding.role ?? 'review'));
  for (const review of gate.reviewFailures ?? []) {
    const role = review.role ?? 'review';
    if (findingRoles.has(role)) continue;
    items.push({
      id: stableReviewItemId(`F-${slugify(role, 20)}`, ['review-verdict', review.verdict, review.summary]),
      type: 'finding',
      status: 'blocking',
      title: `${role} review verdict: ${review.verdict ?? 'not approved'}`,
      summary: redactText(review.summary ?? 'Review did not approve the integrated change.', 1200),
      defaultDecision: 'repair_requested',
      role,
      severity: 'medium',
      recommendation: 'Repair or re-run review until this review track approves.',
      reproduction: [],
      paths: [],
      criterionIds: [],
    });
  }

  const counts = itemCounts(items);
  return {
    runId: state.runId,
    generatedAt: now(),
    phase: state.phase,
    terminal: ['blocked', 'failed', 'accepted'].includes(state.phase),
    objective: state.objective,
    baseCommit: state.baseCommit,
    integrationCommit: state.integration?.commit ?? null,
    integrationWorktree: state.integration?.worktreePath ?? null,
    repairIteration: state.repairIteration ?? 0,
    maxRepairs: state.maxRepairs ?? DEFAULT_CONFIG.maxRepairs,
    recommendedMaxRepairs: recommendedMaxRepairsFor(state, items),
    finalSummary: state.final?.summary ?? null,
    background,
    counts,
    items,
  };
}

function shouldTreatEnvironmentDecisionAsRepair(decision, item) {
  if (decision.decision !== 'environment_required') return false;
  if (decision.defaultDecision !== 'environment_required') return false;
  if (item?.type !== 'validation') return false;
  return projectDependencyFailure(item, item.logExcerpt ?? item.summary ?? '');
}

function buildHumanRepairContext(session, { includeProjectDependencyEnvironment = false } = {}) {
  const repairRequests = session.decisions
    .map((decision) => {
      const item = session.items.find((candidate) => candidate.id === decision.itemId) ?? {};
      const include = decision.decision === 'repair_requested'
        || (includeProjectDependencyEnvironment && shouldTreatEnvironmentDecisionAsRepair(decision, item));
      return include ? { decision, item } : null;
    })
    .filter(Boolean)
    .map((decision) => {
      const item = decision.item;
      const record = decision.decision;
      return {
        itemId: record.itemId,
        type: record.type,
        title: record.title,
        summary: item.summary ?? null,
        command: item.command ?? null,
        criterionId: item.criterionId ?? null,
        role: item.role ?? null,
        severity: item.severity ?? null,
        paths: item.paths ?? [],
        criterionIds: item.criterionIds ?? [],
        note: record.note || null,
        operatorDecision: record.decision,
        defaultDecision: record.defaultDecision ?? null,
        reroutedFromEnvironment: record.decision === 'environment_required',
      };
    });
  if (!repairRequests.length) return null;
  return {
    reviewId: session.id,
    reviewedAt: session.at,
    phase: session.phase,
    integrationCommit: session.integrationCommit,
    repairRequests,
  };
}

async function readHumanReviewArtifact(repo, review) {
  if (!review?.artifactPath) return null;
  const artifactPath = path.isAbsolute(review.artifactPath) ? review.artifactPath : path.join(repo, review.artifactPath);
  return readJsonIfExists(artifactPath);
}

export async function humanRepairContextForState(repo, state) {
  for (const review of [...(state.humanReviews ?? [])].reverse()) {
    const full = await readHumanReviewArtifact(repo, review);
    const rebuilt = full ? buildHumanRepairContext(full, { includeProjectDependencyEnvironment: true }) : null;
    if (rebuilt?.repairRequests?.length) return rebuilt;
    if (review?.repairContext?.repairRequests?.length) return review.repairContext;
  }
  return null;
}

async function meaningfulStatusEntries(repo) {
  const status = await statusPorcelain(repo);
  return status
    .split('\n')
    .filter(Boolean)
    .filter((line) => !line.slice(3).startsWith('.codex/delivery-runs/'));
}

async function recordHumanReview(repo, state, session) {
  const paths = runPaths(repo, state.runId);
  const reviewDir = path.join(paths.artifacts, 'human-reviews');
  await ensureDir(reviewDir);
  const artifact = path.join(reviewDir, `${snapshotStamp()}-${slugify(session.id, 40)}.json`);
  const relativeArtifact = relativeToRepo(repo, artifact);
  const repairContext = buildHumanRepairContext(session);
  const full = { ...session, artifactPath: relativeArtifact, repairContext };
  await writeJsonAtomic(artifact, full);

  const compactDecisions = session.decisions.map((decision) => ({
    itemId: decision.itemId,
    type: decision.type,
    decision: decision.decision,
    title: decision.title,
    note: decision.note || undefined,
  }));
  const compact = {
    id: session.id,
    at: session.at,
    runId: state.runId,
    phase: state.phase,
    integrationCommit: state.integration?.commit ?? null,
    artifactPath: relativeArtifact,
    counts: session.counts,
    decisions: compactDecisions,
  };
  await appendJsonl(path.join(paths.root, 'human-reviews.jsonl'), compact);
  state.humanReviews ??= [];
  state.humanReviews.push({ ...compact, repairContext });
  await appendEvent(repo, state, {
    type: 'human.review.recorded',
    reviewId: session.id,
    artifactPath: relativeArtifact,
    decisions: session.counts.byDecision,
    items: session.items.length,
  });
  await saveState(repo, state);
  return { artifactPath: relativeArtifact, repairContext };
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
      humanReview: await humanRepairContextForState(repo, state),
      iteration: state.repairIteration,
      maxParallel: config.maxParallel,
    }),
  });
  if (!run.ok) throw new Error('Repair planner failed.');
  const serialized = serializeOverlappingWorkstreams(run.final.workstreams);
  validateWorkstreams(serialized.workstreams, new Set(state.acceptanceCriteria.map((item) => item.id)));
  const repairWorkstreams = instantiateWorkstreams(serialized.workstreams, state.repairIteration);
  state.workstreams.push(...repairWorkstreams);
  await writeJsonAtomic(path.join(runPaths(repo, state.runId).artifacts, `repair-plan-${state.repairIteration}.json`), { ...run.final, workstreams: serialized.workstreams });
  if (serialized.addedDependencies.length) {
    await appendEvent(repo, state, { type: 'repair.plan.normalized', iteration: state.repairIteration, addedDependencies: serialized.addedDependencies });
  }
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

function decisionLabel(decision, theme = createCliTheme()) {
  const meta = HUMAN_REVIEW_DECISION_META[decision];
  if (!meta) return decision;
  return `${theme.decision(decision, decision)} ${theme.dim(`(${meta.label})`)}`;
}

function renderDecisionHelp(theme = createCliTheme()) {
  const lines = [
    theme.bold('Actions'),
    ...HUMAN_REVIEW_DECISION_VALUES.map((decision) => {
      const meta = HUMAN_REVIEW_DECISION_META[decision];
      return `  ${theme.decision(decision, `[${meta.shortcut}] ${decision}`)} - ${meta.description}`;
    }),
  ];
  return lines.join('\n');
}

function reviewTypeLabel(item, theme) {
  if (item.type === 'validation') return theme.yellow('validation');
  if (item.type === 'criterion') return theme.blue('criterion');
  if (item.type === 'finding') {
    if (item.severity === 'critical' || item.severity === 'high') return theme.red('finding');
    return theme.magenta('finding');
  }
  return item.type;
}

function defaultActionReason(item) {
  if (item.defaultDecision === 'environment_required') return 'This looks like missing system tooling, services, credentials, or local setup outside the repo.';
  if (item.type === 'validation' && projectDependencyFailure(item, item.logExcerpt ?? '')) return 'This looks like a missing project dependency; Codex can update manifests and resume can prepare checked-in deps.';
  if (item.type === 'validation') return 'This command failed as a repository validation check and likely needs a repair or safer validation entrypoint.';
  if (item.type === 'criterion') return 'This acceptance criterion is not proven by the current integrated result.';
  if (item.type === 'finding') return 'A reviewer marked this as a blocking correctness or security finding.';
  return HUMAN_REVIEW_DECISION_META[item.defaultDecision]?.description ?? 'This action is suggested from the quality gate.';
}

function renderReviewItem(item, index, total, theme = createCliTheme()) {
  const fields = [
    theme.bold(`${index + 1}/${total}`),
    theme.gray(item.id),
    reviewTypeLabel(item, theme),
    item.status,
    item.severity ? `severity=${item.severity}` : null,
    item.role ? `role=${item.role}` : null,
  ].filter(Boolean).join(' ');
  const lines = [
    `[${fields}]`,
    theme.bold(item.title),
    item.defaultDecision ? `Suggested action: ${decisionLabel(item.defaultDecision, theme)} - ${defaultActionReason(item)}` : null,
    item.summary ? `Summary: ${item.summary}` : null,
    item.command ? `Command: ${item.command}` : null,
    item.exitCode !== null && item.exitCode !== undefined ? `Exit: ${item.exitCode}` : null,
    item.criterionId ? `Criterion: ${item.criterionId}` : null,
    item.paths?.length ? `Paths: ${item.paths.join(', ')}` : null,
    item.criterionIds?.length ? `Criteria: ${item.criterionIds.join(', ')}` : null,
    item.logPath ? `Log: ${item.logPath}` : null,
    item.recommendation ? `Recommendation: ${item.recommendation}` : null,
  ].filter(Boolean);
  return `${lines.join('\n')}\n`;
}

function normalizeHumanDecision(value, fallback) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (!normalized) return fallback;
  if (HUMAN_REVIEW_DECISIONS.has(normalized)) return normalized;
  if (HUMAN_REVIEW_DECISION_SHORTCUTS.has(normalized)) return HUMAN_REVIEW_DECISION_SHORTCUTS.get(normalized);
  return null;
}

async function promptHumanReviewDecisions(inbox, { inputStream = process.stdin, outputStream = process.stdout, theme = createCliTheme(outputStream) } = {}) {
  const scriptedAnswers = inputStream.isTTY === true ? null : await readPipedAnswers(inputStream);
  const rl = scriptedAnswers ? null : createInterface({ input: inputStream, output: outputStream });
  const decisions = [];
  try {
    outputStream.write([
      theme.bold('Human Review'),
      `Run: ${inbox.runId}`,
      `Phase: ${theme.yellow(inbox.phase)}`,
      `Inbox: ${inbox.counts.total} item(s) - ${inbox.counts.validation} validation, ${inbox.counts.criteria} criteria, ${inbox.counts.findings} findings`,
      '',
      'Choose an action first. The note prompt comes after the action.',
      'Press Enter at the action prompt to accept the suggested action for that item.',
      'This command records review decisions only; it never resumes the run.',
      '',
      renderDecisionHelp(theme),
      '',
    ].join('\n'));

    for (let index = 0; index < inbox.items.length; index += 1) {
      const item = inbox.items[index];
      outputStream.write(`${renderReviewItem(item, index, inbox.items.length, theme)}\n`);
      let decision = null;
      while (!decision) {
        const answer = await reviewQuestion({
          rl,
          scriptedAnswers,
          outputStream,
          prompt: `Action [r/e/m/a or full name] Enter=${item.defaultDecision}: `,
        });
        decision = normalizeHumanDecision(answer, item.defaultDecision);
        if (!decision) {
          outputStream.write(`${theme.red('Invalid action.')} Choose r, e, m, a, or a full action name. Notes are entered at the next prompt.\n`);
        }
      }
      const note = redactText(await reviewQuestion({ rl, scriptedAnswers, outputStream, prompt: 'Note (optional): ' }), 2000).trim();
      decisions.push({
        ...reviewItemDecisionSeed(item),
        itemId: item.id,
        decision,
        defaultDecision: item.defaultDecision,
        note,
      });
      outputStream.write('\n');
    }
  } finally {
    rl?.close();
  }
  return decisions;
}

async function readPipedAnswers(inputStream) {
  let text = '';
  for await (const chunk of inputStream) text += chunk.toString();
  return text.split(/\r?\n/);
}

async function reviewQuestion({ rl, scriptedAnswers, outputStream, prompt }) {
  if (!scriptedAnswers) return rl.question(prompt);
  outputStream.write(prompt);
  if (!scriptedAnswers.length) throw new UserFacingError('Not enough piped input for human review.');
  return scriptedAnswers.shift();
}

function resumeCommandForReview(runId, maxRepairs, allowDirty = false) {
  return `./scripts/codex-delivery resume --run ${runId} --max-repairs ${maxRepairs} --background${allowDirty ? ' --allow-dirty' : ''}`;
}

export async function reviewCommand(options, { inputStream = process.stdin, outputStream = process.stdout } = {}) {
  const repo = await repositoryRootFor(await repoCwdFromOptions(options));
  const runId = options.run || await latestRunId(repo);
  if (!runId) throw new Error('No delivery run selected.');
  const state = await loadState(repo, runId);
  const background = await readBackgroundRecord(repo, runId);
  const inbox = await buildHumanReviewInbox(repo, state, { background });
  const theme = createCliTheme(outputStream, options);
  if (options.json) {
    outputStream.write(`${JSON.stringify(inbox, null, 2)}\n`);
    return inbox;
  }
  if (options.tui) {
    return tuiCommand(options, { inputStream, outputStream, initialPanel: 'review' });
  }
  if (!['blocked', 'failed'].includes(state.phase)) {
    throw new UserFacingError(`Run ${runId} is in phase '${state.phase}'. Human review decisions can be recorded only for blocked or failed runs. Use review --json for read-only inspection.`);
  }
  if (!inbox.items.length) {
    outputStream.write(`Run ${runId} has no human review inbox items.\n`);
    return inbox;
  }

  const decisions = await promptHumanReviewDecisions(inbox, { inputStream, outputStream, theme });
  const session = {
    id: `HR-${snapshotStamp()}`,
    at: now(),
    runId,
    phase: state.phase,
    objective: state.objective,
    baseCommit: state.baseCommit,
    integrationCommit: state.integration?.commit ?? null,
    repairIteration: state.repairIteration ?? 0,
    maxRepairs: state.maxRepairs ?? DEFAULT_CONFIG.maxRepairs,
    recommendedMaxRepairs: inbox.recommendedMaxRepairs,
    items: inbox.items,
    decisions,
    counts: decisionCounts(decisions),
  };
  const recorded = await recordHumanReview(repo, state, session);
  const dirty = await meaningfulStatusEntries(repo);
  const hasRepairRequests = decisions.some((decision) => decision.decision === 'repair_requested');
  const hasEnvironmentItems = decisions.some((decision) => decision.decision === 'environment_required');
  const hasManualItems = decisions.some((decision) => decision.decision === 'manual_required');
  const hasProjectDependencyRepair = projectDependencyRepairApprovedFromContext(recorded.repairContext);

  const lines = [
    `${theme.green('Human review saved')} for run ${runId}.`,
    `Artifact: ${recorded.artifactPath}`,
    `Decisions: ${JSON.stringify(session.counts.byDecision)}`,
    hasRepairRequests ? `${theme.cyan('Repair requested:')} these items will be included in the next repair-planning prompt.` : `${theme.dim('No repair requests were recorded for repair planning.')}`,
    hasProjectDependencyRepair ? `${theme.cyan('Project dependencies:')} resume may prepare checked-in Python/npm dependencies in the integration worktree before validation.` : null,
    hasEnvironmentItems ? `${theme.yellow('Environment required:')} resolve missing tools, dependencies, services, or credentials before resuming.` : null,
    hasManualItems ? `${theme.magenta('Manual required:')} complete or verify manual work before resuming.` : null,
    theme.bold('Next resume command:'),
    shellExample(resumeCommandForReview(runId, inbox.recommendedMaxRepairs)),
  ].filter(Boolean);
  if (dirty.length) {
    lines.push(
      '',
      theme.yellow('Warning: repository has uncommitted changes outside delivery run artifacts; normal resume will refuse to start.'),
      ...dirty.slice(0, 12).map((entry) => `  ${entry}`),
      theme.bold('Allow-dirty variant:'),
      shellExample(resumeCommandForReview(runId, inbox.recommendedMaxRepairs, true)),
    );
  }
  outputStream.write(`${lines.join('\n')}\n`);
  return session;
}

async function readRunEventHistory(repo, runId, limit = 300) {
  const eventsPath = runPaths(repo, runId).events;
  let text = '';
  try {
    text = await readFile(eventsPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-limit)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function buildTuiReviewSession({ state, inbox, model }) {
  const decisions = (inbox.items ?? []).map((item) => ({
    ...reviewItemDecisionSeed(item),
    itemId: item.id,
    decision: model.decisions?.[item.id] ?? item.defaultDecision,
    defaultDecision: item.defaultDecision,
    note: redactText(model.notes?.[item.id] ?? '', 2000).trim(),
  }));
  return {
    id: `HR-${snapshotStamp()}`,
    at: now(),
    runId: state.runId,
    phase: state.phase,
    objective: state.objective,
    baseCommit: state.baseCommit,
    integrationCommit: state.integration?.commit ?? null,
    repairIteration: state.repairIteration ?? 0,
    maxRepairs: state.maxRepairs ?? DEFAULT_CONFIG.maxRepairs,
    recommendedMaxRepairs: inbox.recommendedMaxRepairs,
    items: inbox.items,
    decisions,
    counts: decisionCounts(decisions),
  };
}

export async function tuiCommand(options, { inputStream = process.stdin, outputStream = process.stdout, initialPanel = options.panel ?? 'overview' } = {}) {
  const repo = await repositoryRootFor(await repoCwdFromOptions(options));
  const runId = options.run || await latestRunId(repo);
  if (!runId) throw new Error('No delivery run selected.');

  const load = async () => {
    const state = await loadState(repo, runId);
    const background = await readBackgroundRecord(repo, runId);
    const inbox = await buildHumanReviewInbox(repo, state, { background });
    const events = await readRunEventHistory(repo, runId);
    return { repo, runId, state, background, inbox, events };
  };

  const saveReview = async (model) => {
    const state = await loadState(repo, runId);
    if (!['blocked', 'failed'].includes(state.phase)) {
      throw new UserFacingError(`Run ${runId} is in phase '${state.phase}'. Review decisions can be saved only for blocked or failed runs.`);
    }
    const background = await readBackgroundRecord(repo, runId);
    const inbox = await buildHumanReviewInbox(repo, state, { background });
    if (!inbox.items.length) throw new UserFacingError(`Run ${runId} has no human review inbox items.`);
    const session = buildTuiReviewSession({ state, inbox, model });
    const recorded = await recordHumanReview(repo, state, session);
    const dirty = await meaningfulStatusEntries(repo);
    const allowDirtyHint = dirty.length ? ' Repository has uncommitted changes; resume may need --allow-dirty.' : '';
    return {
      session,
      artifactPath: recorded.artifactPath,
      message: `Human review saved: ${recorded.artifactPath}. Resume: ${resumeCommandForReview(runId, inbox.recommendedMaxRepairs)}.${allowDirtyHint}`,
    };
  };

  return runTerminalTui({
    inputStream,
    outputStream,
    load,
    saveReview,
    initialPanel,
    noColor: Boolean(options.noColor),
  });
}

function statusJsonPayload(repo, runId, state, background) {
  const criteriaEvidence = new Map((state.verification?.criteria ?? []).map((item) => [item.id, item]));
  const backgroundStale = backgroundIsStale(background);
  return {
    runId,
    phase: state.phase,
    objective: state.objective,
    baseRef: state.baseRef,
    baseCommit: state.baseCommit,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    repairIteration: state.repairIteration,
    maxRepairs: state.maxRepairs,
    integration: state.integration,
    acceptanceCriteria: (state.acceptanceCriteria ?? []).map((criterion) => {
      const evidence = criteriaEvidence.get(criterion.id);
      return {
        ...criterion,
        status: evidence?.status ?? 'unverified',
        evidence: evidence?.evidence ?? [],
        paths: evidence?.paths ?? [],
        commands: evidence?.commands ?? [],
      };
    }),
    workstreams: (state.workstreams ?? []).map((item) => ({
      id: item.id,
      title: item.title,
      role: item.role,
      kind: item.kind,
      status: item.status,
      repairIteration: item.repairIteration,
      commit: item.commit,
      changedPaths: item.changedPaths ?? [],
      error: item.error ?? null,
    })),
    validation: state.validation,
    verification: state.verification,
    reviews: state.reviews,
    humanReviews: state.humanReviews ?? [],
    final: state.final,
    background: background ? {
      ...background,
      effectiveStatus: backgroundStale ? 'stale' : background.status ?? 'unknown',
      alive: background.pid ? processAlive(background.pid) : false,
      backgroundLogPath: background.backgroundLogPath ? relativeToRepo(repo, background.backgroundLogPath) : null,
    } : null,
    paths: {
      state: relativeToRepo(repo, runPaths(repo, runId).state),
      events: relativeToRepo(repo, runPaths(repo, runId).events),
      summary: relativeToRepo(repo, runPaths(repo, runId).summary),
      final: relativeToRepo(repo, runPaths(repo, runId).final),
    },
  };
}

export async function statusCommand(options, { inputStream = process.stdin, outputStream = process.stdout } = {}) {
  const repo = await repositoryRootFor(await repoCwdFromOptions(options));
  const runId = options.run || await latestRunId(repo);
  if (!runId) throw new Error('No delivery runs found.');
  const state = await loadState(repo, runId);
  const background = await readBackgroundRecord(repo, runId);
  if (options.json) {
    outputStream.write(`${JSON.stringify(statusJsonPayload(repo, runId, state, background), null, 2)}\n`);
    return state;
  }
  if (options.tui) {
    return tuiCommand(options, { inputStream, outputStream, initialPanel: 'overview' });
  }
  let output = `${await readFile(runPaths(repo, runId).summary, 'utf8')}\n`;
  if (background) {
    const stale = backgroundIsStale(background);
    const stopped = ['stopped', 'stop_requested'].includes(background.status);
    output += [
      '## Background',
      '',
      `- **Status:** ${background.status ?? 'unknown'}`,
      `- **Effective status:** ${stale ? 'stale' : background.status ?? 'unknown'}`,
      `- **PID:** ${background.pid ?? '—'}`,
      `- **Alive:** ${background.pid ? String(processAlive(background.pid)) : 'false'}`,
      `- **Mode:** ${background.mode ?? '—'}`,
      `- **Started:** ${background.startedAt ?? '—'}`,
      `- **Last heartbeat:** ${background.lastHeartbeatAt ?? '—'}`,
      `- **Finished:** ${background.finishedAt ?? '—'}`,
      `- **Log:** ${background.backgroundLogPath ? path.relative(repo, background.backgroundLogPath) : '—'}`,
      stale ? '- **Notice:** background process is not alive; use `resume --run <id>` to archive running workstreams and retry.' : '',
      !stale && stopped ? '- **Notice:** background process was stopped or stop was requested; use `resume --run <id>` to archive running workstreams and retry.' : '',
      '',
    ].filter((line) => line !== '').join('\n');
  }
  outputStream.write(output);
  return state;
}

export async function reportCommand(options, { outputStream = process.stdout } = {}) {
  const repo = await repositoryRootFor(await repoCwdFromOptions(options));
  const runId = options.run || await latestRunId(repo);
  if (!runId) throw new Error('No delivery runs found.');
  const paths = runPaths(repo, runId);
  const state = await loadState(repo, runId);
  const background = await readBackgroundRecord(repo, runId);
  outputStream.write(`${JSON.stringify({ runId, phase: state.phase, ...paths, integration: state.integration, background, humanReviews: state.humanReviews ?? [], final: state.final }, null, 2)}\n`);
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

async function readEventsSnapshot(file) {
  const info = await stat(file).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return { offset: 0, text: '' };
  const text = info.size ? await readFile(file, 'utf8') : '';
  return { offset: info.size, text };
}

function parseTailOption(options) {
  if (options.all) return null;
  if (options.tail === undefined) return options.follow ? DEFAULT_FOLLOW_TAIL : null;
  const value = Number(options.tail);
  if (!Number.isInteger(value) || value < 0) throw new UserFacingError('--tail must be a non-negative integer.');
  return value;
}

function renderEventLines(text, { verbose, repo, tail = null } = {}) {
  let lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (tail !== null) lines = tail === 0 ? [] : lines.slice(-tail);
  let terminalSeen = false;
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      terminalSeen ||= isTerminalProgressEvent(event);
      const rendered = renderProgressLine(event, { verbose, repo });
      if (rendered) process.stdout.write(`${rendered}\n`);
    } catch {
      // Ignore corrupt event records; raw artifacts remain available for manual inspection.
    }
  }
  return terminalSeen;
}

async function logsCommand(options) {
  const repo = await repositoryRootFor(await repoCwdFromOptions(options));
  const runId = options.run || await latestRunId(repo);
  if (!runId) throw new Error('No delivery runs found.');
  const eventsPath = runPaths(repo, runId).events;
  const verbose = Boolean(options.verbose);
  const tail = parseTailOption(options);
  let offset = 0;
  let pending = '';
  const printNew = async () => {
    const chunk = await readEventsChunk(eventsPath, offset);
    offset = chunk.offset;
    if (!chunk.text) return false;
    const lines = `${pending}${chunk.text}`.split(/\r?\n/);
    pending = lines.pop() ?? '';
    let terminalSeen = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        terminalSeen ||= isTerminalProgressEvent(event);
        const rendered = renderProgressLine(event, { verbose, repo });
        if (rendered) {
          process.stdout.write(`${rendered}\n`);
        }
      } catch {
        // Ignore partial or corrupt lines; durable files remain available for manual inspection.
      }
    }
    return terminalSeen;
  };
  if (tail === null) {
    await printNew();
  } else {
    const snapshot = await readEventsSnapshot(eventsPath);
    offset = snapshot.offset;
    renderEventLines(snapshot.text, { verbose, repo, tail });
  }
  if (!options.follow) return;
  while (true) {
    await delay(1000);
    const terminalSeen = await printNew();
    if (terminalSeen) break;
    const state = await loadState(repo, runId).catch(() => null);
    if (state && ['accepted', 'blocked', 'failed'].includes(state.phase)) {
      await printNew();
      break;
    }
    const background = await readBackgroundRecord(repo, runId).catch(() => null);
    if (backgroundIsStale(background)) {
      process.stdout.write(`${renderBackgroundStaleLine(background)}\n`);
      break;
    }
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
  await appendEvent(repo, state, exited
    ? { type: 'background.stopped', pid: background.pid, mode: background.mode, signal: signalSent ? 'SIGTERM' : null, signalError }
    : { type: 'background.stop.pending', pid: background.pid, mode: background.mode, signal: signalSent ? 'SIGTERM' : null, signalError });
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
  node .codex/delivery-kit/cli.mjs logs [--repo <path>] [--run <id>] [--follow] [--tail <n>] [--all] [--verbose]
  node .codex/delivery-kit/cli.mjs review [--repo <path>] [--run <id>] [--json]
  node .codex/delivery-kit/cli.mjs review [--repo <path>] [--run <id>] --tui
  node .codex/delivery-kit/cli.mjs status [--repo <path>] [--run <id>] [--json]
  node .codex/delivery-kit/cli.mjs status [--repo <path>] [--run <id>] --tui
  node .codex/delivery-kit/cli.mjs tui [--repo <path>] [--run <id>] [--panel overview|events|checkpoints|review]
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
  --tail <n>            Show only the last n event records before exiting or following
  --all                 With logs --follow, print full history before following
  --json                Print machine-readable output for review/status
  --tui                 Open the interactive terminal UI for status or review
  --panel <name>        Initial TUI panel: overview, events, checkpoints, review
  --quiet               Suppress live progress output
  --verbose             Print additional sanitized progress details
  --no-color            Disable colorized terminal output
  --no-auto-install-deps
                        Do not auto-prepare checked-in project deps after human approval
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
  } else if (command === 'tui') {
    await tuiCommand(options);
  } else if (command === 'review') {
    await reviewCommand(options);
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
