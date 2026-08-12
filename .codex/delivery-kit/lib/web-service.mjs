import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  buildHumanReviewInbox,
  cleanupDeliveryRun,
  decisionCounts,
  DEFAULT_CONFIG,
  latestRunId,
  meaningfulStatusEntries,
  processAlive,
  backgroundIsStale,
  readBackgroundRecord,
  recordHumanReview,
  reviewItemDecisionSeed,
  startBackgroundResume,
  stopDeliveryRun,
  UserFacingError,
} from '../cli.mjs';
import { loadState, now, redactText, runPaths } from './core.mjs';
import { repoRoot } from './git.mjs';
import { computeRunTelemetry } from './time-progress.mjs';

const REVIEW_DECISIONS = new Set([
  'repair_requested',
  'environment_required',
  'manual_required',
  'acknowledged',
]);

export async function resolveWebRepo(cwd = process.cwd()) {
  return repoRoot(cwd);
}

function relativeToRepo(repo, value) {
  if (!value) return null;
  const absolute = path.isAbsolute(value) ? value : path.join(repo, value);
  return path.relative(repo, absolute).split(path.sep).join('/');
}

function decoratedBackground(background) {
  if (!background) return null;
  const alive = background.pid ? processAlive(background.pid) : false;
  return {
    ...background,
    alive,
    effectiveStatus: backgroundIsStale(background) ? 'stale' : background.status ?? 'unknown',
  };
}

async function readJsonl(file) {
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export async function readRunEvents(repo, runId, { tail = 300 } = {}) {
  const events = await readJsonl(runPaths(repo, runId).events);
  if (tail === null) return events;
  const numericTail = Math.max(0, Number(tail) || 0);
  return numericTail ? events.slice(-numericTail) : [];
}

function runPathsPayload(repo, runId) {
  const paths = runPaths(repo, runId);
  return {
    state: relativeToRepo(repo, paths.state),
    events: relativeToRepo(repo, paths.events),
    summary: relativeToRepo(repo, paths.summary),
    final: relativeToRepo(repo, paths.final),
    background: relativeToRepo(repo, paths.background),
    backgroundLog: relativeToRepo(repo, paths.backgroundLog),
  };
}

function runSummary(repo, runId, state, background, events) {
  const telemetry = computeRunTelemetry(state, events, background);
  const validationRuns = state.validation?.runs ?? [];
  const reviews = state.reviews ?? [];
  return {
    runId,
    objective: state.objective,
    phase: state.phase,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt ?? null,
    repairIteration: state.repairIteration ?? 0,
    maxRepairs: state.maxRepairs ?? DEFAULT_CONFIG.maxRepairs,
    progress: telemetry.progress,
    timing: telemetry.timing,
    eta: telemetry.eta,
    background: decoratedBackground(background),
    validation: {
      total: validationRuns.length,
      failed: validationRuns.filter((run) => !run.ok).length,
      passed: validationRuns.filter((run) => run.ok).length,
    },
    reviews: {
      total: reviews.length,
      notApproved: reviews.filter((review) => review.verdict && review.verdict !== 'approved').length,
      approved: reviews.filter((review) => review.verdict === 'approved').length,
    },
    integration: {
      branch: state.integration?.branch ?? null,
      commit: state.integration?.commit ?? null,
      worktreePath: state.integration?.worktreePath ? relativeToRepo(repo, state.integration.worktreePath) : null,
    },
    paths: runPathsPayload(repo, runId),
  };
}

export async function listRuns(repo, { limit = 50 } = {}) {
  const root = path.join(repo, '.codex', 'delivery-runs');
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    const state = await loadState(repo, runId).catch(() => null);
    if (!state) continue;
    const background = await readBackgroundRecord(repo, runId).catch(() => null);
    const events = await readRunEvents(repo, runId, { tail: 120 }).catch(() => []);
    runs.push(runSummary(repo, runId, state, background, events));
  }
  runs.sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')));
  const numericLimit = Math.max(1, Number(limit) || 50);
  return {
    repo,
    latestRunId: await latestRunId(repo),
    runs: runs.slice(0, numericLimit),
  };
}

export async function getRun(repo, runId, { eventTail = 300, includeInbox = true } = {}) {
  const state = await loadState(repo, runId);
  const background = await readBackgroundRecord(repo, runId).catch(() => null);
  const events = await readRunEvents(repo, runId, { tail: eventTail });
  const telemetry = computeRunTelemetry(state, events, background);
  const inbox = includeInbox ? await buildHumanReviewInbox(repo, state, { background }) : null;
  const dirtyEntries = await meaningfulStatusEntries(repo).catch(() => []);
  return {
    repo,
    runId,
    state,
    background: decoratedBackground(background),
    telemetry,
    inbox,
    events,
    dirtyEntries,
    summary: runSummary(repo, runId, state, background, events),
    paths: runPathsPayload(repo, runId),
  };
}

export async function getReviewInbox(repo, runId) {
  const state = await loadState(repo, runId);
  const background = await readBackgroundRecord(repo, runId).catch(() => null);
  return buildHumanReviewInbox(repo, state, { background });
}

function webReviewId() {
  return `HR-web-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${randomUUID().slice(0, 8)}`;
}

function normalizeReviewDecisions(inbox, payload = {}) {
  const requested = new Map((payload.decisions ?? []).map((decision) => [decision.itemId, decision]));
  return (inbox.items ?? []).map((item) => {
    const input = requested.get(item.id) ?? {};
    const decision = input.decision ?? item.defaultDecision ?? 'repair_requested';
    if (!REVIEW_DECISIONS.has(decision)) {
      throw new UserFacingError(`Invalid decision '${decision}' for review item ${item.id}.`);
    }
    return {
      ...reviewItemDecisionSeed(item),
      itemId: item.id,
      decision,
      defaultDecision: item.defaultDecision,
      note: redactText(input.note ?? '', 2000).trim(),
    };
  });
}

export async function saveReview(repo, runId, payload = {}) {
  const state = await loadState(repo, runId);
  if (!['blocked', 'failed'].includes(state.phase)) {
    throw new UserFacingError(`Run ${runId} is in phase '${state.phase}'. Review decisions can be saved only for blocked or failed runs.`);
  }
  const background = await readBackgroundRecord(repo, runId).catch(() => null);
  const inbox = await buildHumanReviewInbox(repo, state, { background });
  if (!inbox.items.length) throw new UserFacingError(`Run ${runId} has no human review inbox items.`);
  const decisions = normalizeReviewDecisions(inbox, payload);
  const session = {
    id: payload.id || webReviewId(),
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
  return {
    session,
    artifactPath: recorded.artifactPath,
    repairContext: recorded.repairContext,
  };
}

export async function resumeRun(repo, runId, payload = {}) {
  const state = await loadState(repo, runId);
  if (state.phase === 'accepted') throw new UserFacingError(`Run ${runId} is already accepted; nothing to resume.`);
  const background = await readBackgroundRecord(repo, runId).catch(() => null);
  const inbox = await buildHumanReviewInbox(repo, state, { background });
  return startBackgroundResume({
    cwd: repo,
    options: {
      run: runId,
      background: true,
      maxRepairs: inbox.recommendedMaxRepairs,
      allowDirty: Boolean(payload.allowDirty),
    },
  });
}

export async function stopRun(repo, runId) {
  return stopDeliveryRun({ repo, runId });
}

export async function cleanupRun(repo, runId, payload = {}) {
  return cleanupDeliveryRun({
    repo,
    runId,
    integration: payload.integration !== false,
    logs: false,
  });
}
