import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { renderProgressLine } from './progress.mjs';

export const TUI_PANELS = ['overview', 'events', 'checkpoints', 'review', 'workspace'];
export const TUI_VIEW_MODES = ['simple', 'verbose', 'extended'];

const PANEL_LABELS = {
  overview: 'Overview',
  events: 'Timeline',
  checkpoints: 'Checkpoints',
  review: 'Review',
  workspace: 'Workspace',
};

const VIEW_LABELS = {
  simple: 'simple',
  verbose: 'verbose',
  extended: 'extended',
};

export const TUI_DECISIONS = {
  repair_requested: {
    key: 'r',
    label: 'Approve repair',
    description: 'approve Codex repair',
    color: 'cyan',
  },
  environment_required: {
    key: 'e',
    label: 'Fix environment',
    description: 'fix local environment',
    color: 'yellow',
  },
  manual_required: {
    key: 'm',
    label: 'Manual action',
    description: 'human action required',
    color: 'magenta',
  },
  acknowledged: {
    key: 'a',
    label: 'Acknowledge',
    description: 'acknowledge only',
    color: 'dim',
  },
};

const DECISION_BY_KEY = new Map(Object.entries(TUI_DECISIONS).map(([decision, meta]) => [meta.key, decision]));
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CHECKPOINT_EVENT_TYPES = new Set([
  'workflow.checkpoint',
  'workflow.accepted',
  'workflow.blocked',
  'workflow.failed',
  'integration.completed',
  'workstream.wave.completed',
  'quality.gate',
  'human.review.recorded',
]);
const SIMPLE_TIMELINE_EVENT_TYPES = new Set([
  'workflow.started',
  'workflow.resume.started',
  'workflow.checkpoint',
  'workflow.plan.approved',
  'workflow.plan.normalized',
  'workflow.accepted',
  'workflow.blocked',
  'workflow.failed',
  'workflow.error',
  'workstream.wave.started',
  'workstream.wave.completed',
  'workstream.wave.failed',
  'workstream.started',
  'workstream.completed',
  'workstream.failed',
  'integration.started',
  'integration.completed',
  'integration.conflict',
  'validation.started',
  'validation.completed',
  'validation.rejected',
  'validation.setup.plan',
  'validation.setup.started',
  'validation.setup.completed',
  'validation.setup.cleaned',
  'validation.setup.skipped',
  'inspection.started',
  'inspection.completed',
  'repair.plan.approved',
  'repair.plan.normalized',
  'quality.gate',
  'human.review.recorded',
  'background.started',
  'background.stopped',
  'background.exited',
]);

function ansiEnabled(noColor = false) {
  const force = process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0';
  return !noColor && !process.env.NO_COLOR && (force || process.env.TERM !== 'dumb');
}

function makeTheme(noColor = false) {
  const enabled = ansiEnabled(noColor);
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
    phase(phase) {
      if (phase === 'accepted') return paint('green', phase);
      if (phase === 'blocked' || phase === 'failed') return paint('red', phase);
      if (phase === 'review' || phase === 'repair') return paint('yellow', phase);
      return paint('cyan', phase ?? 'unknown');
    },
    decision(decision, value = decision) {
      return paint(TUI_DECISIONS[decision]?.color ?? 'bold', value);
    },
    status(ok, value) {
      return paint(ok ? 'green' : 'red', value);
    },
  };
}

export function stripAnsi(value) {
  return String(value ?? '').replace(ANSI_PATTERN, '');
}

export function visibleLength(value) {
  return stripAnsi(value).length;
}

export function truncate(value, width) {
  const text = String(value ?? '');
  if (width <= 0) return '';
  if (visibleLength(text) <= width) return text;
  const plain = stripAnsi(text);
  if (width <= 3) return '.'.repeat(width);
  return `${plain.slice(0, width - 3)}...`;
}

function countPhrase(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function previewText(value, max = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function countBy(values) {
  return values.reduce((acc, value) => {
    const key = String(value ?? 'unknown');
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function validationSummary(runs = []) {
  const total = runs.length;
  const passed = runs.filter((run) => run.ok).length;
  const failed = runs.filter((run) => !run.ok).length;
  return { total, passed, failed };
}

function reviewSummary(reviews = []) {
  const approved = reviews.filter((review) => review.verdict === 'approved').length;
  const failed = reviews.filter((review) => review.verdict && review.verdict !== 'approved').length;
  return { total: reviews.length, approved, failed };
}

function progressBar(done, total, { width = 22, failed = 0, theme = null } = {}) {
  const numericTotal = Math.max(0, Number(total) || 0);
  const numericDone = clamp(Math.max(0, Number(done) || 0), 0, numericTotal);
  const numericFailed = clamp(Math.max(0, Number(failed) || 0), 0, Math.max(0, numericTotal - numericDone));
  if (numericTotal === 0) return `[${'-'.repeat(width)}] 0/0`;
  const filled = Math.round((numericDone / numericTotal) * width);
  const failedWidth = Math.round((numericFailed / numericTotal) * width);
  const donePart = '#'.repeat(clamp(filled, 0, width));
  const failedPart = '!'.repeat(clamp(failedWidth, 0, Math.max(0, width - donePart.length)));
  const rest = '-'.repeat(Math.max(0, width - donePart.length - failedPart.length));
  const raw = `[${donePart}${failedPart}${rest}] ${numericDone}/${numericTotal}`;
  if (!theme) return raw;
  if (numericFailed > 0) return theme.red(raw);
  if (numericDone === numericTotal) return theme.green(raw);
  return theme.yellow(raw);
}

function normalizeViewMode(value) {
  return TUI_VIEW_MODES.includes(value) ? value : 'simple';
}

function nextViewMode(value) {
  const index = TUI_VIEW_MODES.indexOf(normalizeViewMode(value));
  return TUI_VIEW_MODES[(index + 1) % TUI_VIEW_MODES.length];
}

function initialDecisionMap(inbox) {
  return Object.fromEntries((inbox?.items ?? []).map((item) => [item.id, item.defaultDecision ?? 'repair_requested']));
}

function sortedReviewItemIds(inbox) {
  return (inbox?.items ?? []).map((item) => item.id).filter(Boolean).sort();
}

function reviewSignature(state, inbox) {
  return JSON.stringify({
    commit: state?.integration?.commit ?? null,
    itemIds: sortedReviewItemIds(inbox),
  });
}

function sameStringList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function latestMatchingHumanReview(state, inbox) {
  const itemIds = sortedReviewItemIds(inbox);
  if (!itemIds.length) return null;
  const integrationCommit = state?.integration?.commit ?? null;
  for (const review of [...(state?.humanReviews ?? [])].reverse()) {
    if ((review.integrationCommit ?? null) !== integrationCommit) continue;
    const decisionIds = (review.decisions ?? []).map((decision) => decision.itemId).filter(Boolean).sort();
    if (sameStringList(itemIds, decisionIds)) return review;
  }
  return null;
}

function savedDecisionMap(review, inbox) {
  const defaults = initialDecisionMap(inbox);
  if (!review) return {};
  return {
    ...defaults,
    ...Object.fromEntries((review.decisions ?? []).map((decision) => [decision.itemId, decision.decision])),
  };
}

function savedNoteMap(review) {
  if (!review) return {};
  return Object.fromEntries(
    (review.decisions ?? [])
      .filter((decision) => decision.itemId && decision.note)
      .map((decision) => [decision.itemId, String(decision.note)]),
  );
}

function reviewBaseline(state, inbox) {
  const savedReview = latestMatchingHumanReview(state, inbox);
  const defaultDecisions = initialDecisionMap(inbox);
  const savedDecisions = savedDecisionMap(savedReview, inbox);
  const savedNotes = savedNoteMap(savedReview);
  return {
    reviewSignature: reviewSignature(state, inbox),
    defaultDecisions,
    reviewSaved: Boolean(savedReview),
    savedReviewId: savedReview?.id ?? null,
    savedArtifactPath: savedReview?.artifactPath ?? null,
    lastSavedAt: savedReview?.at ?? null,
    savedDecisions,
    savedNotes,
    pendingDecisions: savedReview ? savedDecisions : defaultDecisions,
    pendingNotes: savedNotes,
  };
}

function decisionValue(map, item) {
  return map?.[item.id] ?? item.defaultDecision ?? 'repair_requested';
}

function noteValue(map, item) {
  return String(map?.[item.id] ?? '').trim();
}

function reviewDirty(model) {
  const items = model.inbox?.items ?? [];
  if (!items.length) return false;
  const baselineDecisions = model.reviewSaved ? model.savedDecisions : model.defaultDecisions;
  const baselineNotes = model.reviewSaved ? model.savedNotes : {};
  return items.some((item) => {
    return decisionValue(model.pendingDecisions, item) !== decisionValue(baselineDecisions, item)
      || noteValue(model.pendingNotes, item) !== noteValue(baselineNotes, item);
  });
}

function withReviewState(model, patch = {}) {
  const pendingDecisions = patch.pendingDecisions ?? model.pendingDecisions ?? model.decisions ?? initialDecisionMap(model.inbox);
  const pendingNotes = patch.pendingNotes ?? model.pendingNotes ?? model.notes ?? {};
  const next = {
    ...model,
    ...patch,
    pendingDecisions,
    pendingNotes,
    decisions: pendingDecisions,
    notes: pendingNotes,
  };
  return { ...next, dirty: reviewDirty(next) };
}

function hasRepairRequest(model) {
  return (model.inbox?.items ?? []).some((item) => decisionValue(model.pendingDecisions, item) === 'repair_requested');
}

function resumeRunning(model) {
  return ['starting', 'running'].includes(model.resumeState?.status);
}

function canResumeFromTui(model) {
  return resumeDisabledReason(model) === null;
}

function resumeDisabledReason(model) {
  if (!['blocked', 'failed'].includes(model.state?.phase)) return 'Resume is available only for blocked or failed runs.';
  if (!(model.inbox?.items ?? []).length) return 'No review items require a resume decision.';
  if (!model.reviewSaved) return 'Save review decisions before resume.';
  if (model.dirty) return 'Save unsaved review changes before resume.';
  if (!hasRepairRequest(model)) return 'No saved decision asks Codex to repair.';
  if (resumeRunning(model)) return 'Resume is already starting or running.';
  if (model.repoDirty && !model.allowDirty) return 'Repository has uncommitted changes. Press 5 for Workspace, press ! to allow dirty resume, or commit/stash changes.';
  return null;
}

function resumeStateFromBackground(background) {
  if (background?.mode === 'resume' && ['starting', 'running'].includes(background.status)) {
    return {
      status: background.status,
      pid: background.pid ?? null,
      logPath: background.backgroundLogPath ?? null,
      startedAt: background.startedAt ?? null,
      message: 'Background resume is active.',
    };
  }
  return { status: 'idle' };
}

function markReviewSaved(model, saved) {
  const session = saved?.session ?? {};
  const pendingDecisions = {
    ...initialDecisionMap(model.inbox),
    ...Object.fromEntries((session.decisions ?? []).map((decision) => [decision.itemId, decision.decision])),
  };
  const pendingNotes = Object.fromEntries(
    (session.decisions ?? [])
      .filter((decision) => decision.itemId && decision.note)
      .map((decision) => [decision.itemId, String(decision.note)]),
  );
  return withReviewState(model, {
    reviewSaved: true,
    savedReviewId: session.id ?? model.savedReviewId ?? null,
    savedArtifactPath: saved?.artifactPath ?? session.artifactPath ?? model.savedArtifactPath ?? null,
    lastSavedAt: session.at ?? model.lastSavedAt ?? null,
    savedDecisions: pendingDecisions,
    savedNotes: pendingNotes,
    pendingDecisions,
    pendingNotes,
    dirty: false,
    message: saved?.message ?? `Saved ${session.id ?? 'human review'}.`,
  });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function selectedIndex(model, panel = model.panel) {
  return Number(model.selected?.[panel] ?? 0);
}

function maxSelection(model, panel = model.panel) {
  if (panel === 'events') return Math.max(0, eventEntries(model).length - 1);
  if (panel === 'checkpoints') return Math.max(0, checkpointLines(model, null).length - 1);
  if (panel === 'review') return Math.max(0, (model.inbox?.items ?? []).length - 1);
  if (panel === 'workspace') return Math.max(0, (model.dirtyEntries ?? []).length - 1);
  return 0;
}

function setSelection(model, panel, value) {
  const selected = { ...model.selected };
  selected[panel] = clamp(value, 0, maxSelection(model, panel));
  return { ...model, selected };
}

function currentReviewItem(model) {
  const items = model.inbox?.items ?? [];
  return items[clamp(selectedIndex(model, 'review'), 0, Math.max(0, items.length - 1))] ?? null;
}

function checkpointEvents(model) {
  return (model.events ?? []).filter((event) => CHECKPOINT_EVENT_TYPES.has(event.type));
}

function formatDuration(ms) {
  const value = Number(ms ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '0ms';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(value / 60_000)}m${String(Math.round((value % 60_000) / 1000)).padStart(2, '0')}s`;
}

function shortSha(value) {
  return value ? String(value).slice(0, 12) : 'n/a';
}

export function createTuiModel({
  repo = null,
  runId = null,
  state,
  background = null,
  inbox = null,
  events = [],
  initialPanel = 'overview',
  viewMode = 'simple',
  dirtyEntries = [],
  allowDirty = false,
  noColor = false,
  message = null,
} = {}) {
  const panel = TUI_PANELS.includes(initialPanel) ? initialPanel : 'overview';
  const baseline = reviewBaseline(state, inbox);
  const pendingDecisions = { ...baseline.pendingDecisions };
  const pendingNotes = { ...baseline.pendingNotes };
  return {
    repo,
    runId: runId ?? state?.runId ?? inbox?.runId ?? null,
    state,
    background,
    inbox,
    events: events.slice(-300),
    panel,
    viewMode: normalizeViewMode(viewMode),
    selected: { overview: 0, events: 0, checkpoints: 0, review: 0 },
    ...baseline,
    pendingDecisions,
    pendingNotes,
    decisions: pendingDecisions,
    notes: pendingNotes,
    dirty: false,
    expandedDetails: {},
    noteEditing: null,
    noteBuffer: '',
    resumeState: resumeStateFromBackground(background),
    dirtyEntries: dirtyEntries.slice(0, 12),
    repoDirty: dirtyEntries.length > 0,
    allowDirty: Boolean(allowDirty),
    message,
    noColor: Boolean(noColor),
  };
}

function mergeModel(previous, next) {
  if (!previous) return next;
  const sameReview = previous.reviewSignature === next.reviewSignature;
  const pendingDecisions = sameReview && previous.dirty
    ? { ...initialDecisionMap(next.inbox), ...previous.pendingDecisions }
    : { ...next.pendingDecisions };
  const pendingNotes = sameReview && previous.dirty ? { ...previous.pendingNotes } : { ...next.pendingNotes };
  const selected = { ...previous.selected };
  const merged = withReviewState({
    ...next,
    panel: previous.panel,
    viewMode: previous.viewMode,
    selected,
    pendingDecisions,
    pendingNotes,
    expandedDetails: { ...previous.expandedDetails },
    noteEditing: sameReview ? previous.noteEditing : null,
    noteBuffer: sameReview ? previous.noteBuffer : '',
    resumeState: resumeRunning(previous) && next.resumeState?.status === 'idle' ? previous.resumeState : next.resumeState,
    allowDirty: previous.allowDirty,
    message: sameReview ? previous.message : 'Review inbox changed; pending decisions were reloaded.',
    noColor: previous.noColor,
  });
  for (const panel of TUI_PANELS) {
    merged.selected[panel] = clamp(Number(merged.selected[panel] ?? 0), 0, maxSelection(merged, panel));
  }
  return merged;
}

function lineBlock(lines, { width, height }) {
  const fitted = lines.map((line) => truncate(line, width));
  if (fitted.length <= height) return fitted;
  if (height <= 1) return fitted.slice(0, height);
  return [...fitted.slice(0, height - 1), truncate(`... ${fitted.length - height + 1} more line(s)`, width)];
}

function headerLines(model, theme) {
  const state = model.state ?? {};
  const backgroundStatus = model.background?.status ?? 'none';
  const alive = model.background?.alive === true || model.background?.pid ? ` pid=${model.background.pid ?? '?'}` : '';
  const tabs = TUI_PANELS.map((panel, index) => {
    const label = `${index + 1} ${PANEL_LABELS[panel]}`;
    return panel === model.panel ? theme.bold(theme.blue(`[${label}]`)) : theme.dim(label);
  }).join('  ');
  return [
    `${theme.bold('Codex Delivery TUI')} ${theme.dim('|')} ${model.runId ?? 'no-run'} ${theme.dim('|')} phase=${theme.phase(state.phase)} repair=${state.repairIteration ?? 0}/${state.maxRepairs ?? 0} view=${VIEW_LABELS[model.viewMode] ?? model.viewMode}`,
    `${tabs}  ${theme.dim(`background=${backgroundStatus}${alive}`)}`,
    '-'.repeat(80),
  ];
}

function footerLines(model, theme) {
  if (model.noteEditing) {
    return [
      '-'.repeat(80),
      `${theme.yellow('note:')} Enter save, Esc cancel, Backspace delete, typing edits note`,
      model.message ? `${theme.bold('status:')} ${model.message}` : null,
    ].filter(Boolean);
  }
  const common = '1 overview, 2 timeline, 3 checkpoints, 4 review, 5 workspace, v view, q quit';
  const navigation = ['events', 'checkpoints', 'review', 'workspace'].includes(model.panel) ? ', j/k or arrows move' : '';
  const resume = canResumeFromTui(model) ? ', R resume' : '';
  const dirty = model.repoDirty ? ', ! allow-dirty' : '';
  const note = model.panel === 'review'
    ? `${common}${navigation}, Enter suggested, n note, A approve all repair, s save${resume}${dirty}`
    : `${common}${navigation}${resume}${dirty}`;
  const reviewKeys = Object.entries(TUI_DECISIONS)
    .map(([decision, meta]) => `${theme.decision(decision, meta.key)} ${meta.description}`)
    .join(' | ');
  const message = model.message ? `${theme.bold('status:')} ${model.message}` : null;
  return [
    '-'.repeat(80),
    note,
    model.panel === 'review' ? `${reviewKeys} | x expand selected` : null,
    message,
  ].filter(Boolean);
}

function reviewPressureLine(items, theme) {
  if (!items.length) return theme.green('No human review items.');
  const severities = countBy(items.map((item) => item.severity ?? item.type));
  const severityText = ['critical', 'high', 'medium', 'low']
    .filter((severity) => severities[severity])
    .map((severity) => `${severities[severity]} ${severity}`)
    .join(', ');
  const byDefault = countBy(items.map((item) => item.defaultDecision ?? 'repair_requested'));
  const defaults = Object.entries(byDefault)
    .map(([decision, count]) => `${count} ${TUI_DECISIONS[decision]?.label ?? decision}`)
    .join(', ');
  const verb = items.length === 1 ? 'needs' : 'need';
  return `${theme.yellow(`${countPhrase(items.length, 'review item')} ${verb} a decision`)}${severityText ? ` (${severityText})` : ''}${defaults ? `; defaults: ${defaults}` : ''}`;
}

function reviewPersistenceLine(model, theme) {
  const items = model.inbox?.items ?? [];
  if (!items.length) return theme.green('No review decisions required.');
  if (model.dirty) return theme.red('Unsaved changes');
  if (model.reviewSaved) {
    const time = model.lastSavedAt ? ` at ${model.lastSavedAt}` : '';
    return theme.green(`Saved as ${model.savedReviewId ?? 'human review'}${time}`);
  }
  return theme.yellow('Not saved yet');
}

function reviewResumeLine(model, theme) {
  if (resumeRunning(model)) {
    const pid = model.resumeState?.pid ? ` pid=${model.resumeState.pid}` : '';
    return theme.cyan(`Resume ${model.resumeState.status}${pid}. Watch Timeline or logs for progress.`);
  }
  const disabled = resumeDisabledReason(model);
  if (!disabled) return theme.cyan('Resume ready. Press R to start background resume.');
  return theme.dim(`Resume disabled: ${disabled}`);
}

function workspaceStateLine(model, theme) {
  if (!model.repoDirty) return theme.green('Working tree clean.');
  if (model.allowDirty) return theme.yellow(`Dirty working tree: allowed for this TUI session (${model.dirtyEntries.length} shown).`);
  return theme.red(`Dirty working tree: resume blocked by default (${model.dirtyEntries.length} shown).`);
}

function nextActionLines(model, validation, reviews, theme) {
  const state = model.state ?? {};
  const items = model.inbox?.items ?? [];
  const runId = model.runId ?? '<run-id>';
  if (['blocked', 'failed'].includes(state.phase) && items.length) {
    if (resumeRunning(model)) {
      return [
        reviewResumeLine(model, theme),
        `Follow logs: ./scripts/codex-delivery logs --follow --run ${runId}`,
      ];
    }
    const allRepair = items.every((item) => decisionValue(model.pendingDecisions, item) === 'repair_requested');
    if (model.dirty) {
      return [
        reviewPersistenceLine(model, theme),
        'Recommended: press 4 to review pending choices, then s to save them.',
      ];
    }
    if (model.reviewSaved) {
      const resumeDisabled = resumeDisabledReason(model);
      if (model.repoDirty && !model.allowDirty) {
        return [
          reviewPersistenceLine(model, theme),
          theme.yellow('Repository has uncommitted changes, so background resume is blocked by default.'),
          `Recommended: press 5 to inspect Workspace, then commit/stash changes or press ! to allow dirty resume.`,
        ];
      }
      return [
        reviewPersistenceLine(model, theme),
        !resumeDisabled && allRepair
          ? 'Recommended: press R to resume in background with approved repair decisions.'
          : reviewResumeLine(model, theme),
      ];
    }
    return [
      reviewPressureLine(items, theme),
      allRepair
        ? 'Recommended: open Review, inspect if needed, then press s to save default repair approvals.'
        : 'Recommended: finish Review decisions, then press s to save.',
      `Resume after save: ./scripts/codex-delivery resume --run ${runId} --background`,
    ];
  }
  if (validation.failed > 0) {
    return [
      theme.red(`${validation.failed} validation command failed.`),
      'Recommended: open Review for failure classification or inspect Timeline/Checkpoints for the failing command.',
    ];
  }
  if (reviews.failed > 0) {
    return [
      theme.yellow(`${reviews.failed} review track${reviews.failed === 1 ? '' : 's'} not approved.`),
      'Recommended: wait for the review inbox or inspect Timeline for reviewer/security output.',
    ];
  }
  if (state.phase === 'accepted') return [theme.green('Accepted. The integration branch is ready for your normal Git merge flow.')];
  if (state.phase === 'repair') return [theme.yellow('Repair is in progress. Watch Timeline for active workstreams and validation.')];
  return ['No operator action is required right now.'];
}

function renderOverview(model, theme) {
  const state = model.state ?? {};
  const validation = validationSummary(state.validation?.runs ?? []);
  const reviews = reviewSummary(state.reviews ?? []);
  const humanReviews = state.humanReviews?.length ?? 0;
  const final = state.final?.summary ?? 'No final summary yet.';
  const workstreams = state.workstreams ?? [];
  const integrated = workstreams.filter((item) => item.status === 'integrated').length;
  const active = workstreams.filter((item) => ['pending', 'running'].includes(item.status)).length;
  const setupRuns = state.validation?.setupRuns ?? [];
  const setupSummary = setupRuns.length
    ? `${setupRuns.filter((run) => run.ok).length}/${setupRuns.length} setup passed`
    : 'no validation setup';
  const nextAction = nextActionLines(model, validation, reviews, theme);
  return [
    theme.bold('Next Action'),
    ...nextAction,
    '',
    theme.bold('Run'),
    `Objective: ${state.objective ?? 'n/a'}`,
    `Base: ${state.baseRef ?? 'n/a'} (${shortSha(state.baseCommit)})`,
    `Integration: ${state.integration?.branch ?? 'n/a'} @ ${shortSha(state.integration?.commit)}`,
    '',
    theme.bold('Progress'),
    `Workstreams ${progressBar(integrated, workstreams.length, { theme })} integrated, ${active} active`,
    `Validation  ${progressBar(validation.passed, validation.total, { failed: validation.failed, theme })} passed, ${validation.failed} failed`,
    `Setup       ${setupRuns.length ? progressBar(setupRuns.filter((run) => run.ok).length, setupRuns.length, { failed: setupRuns.filter((run) => !run.ok).length, theme }) : progressBar(0, 0, { theme })}`,
    `Reviews     ${progressBar(reviews.approved, reviews.total, { failed: reviews.failed, theme })} approved, ${reviews.failed} not approved`,
    '',
    theme.bold('Control Points'),
    `Workstreams: ${integrated}/${workstreams.length} integrated, ${active} active`,
    `Validation: ${theme.status(validation.failed === 0, `${validation.passed}/${validation.total} passed`)} (${validation.failed} failed)`,
    `Setup: ${setupSummary}`,
    `Review tracks: ${theme.status(reviews.failed === 0, `${reviews.approved}/${reviews.total} approved`)} (${reviews.failed} not approved)`,
    `Review inbox: ${reviewPressureLine(model.inbox?.items ?? [], theme)}`,
    `Review state: ${reviewPersistenceLine(model, theme)}`,
    `Resume: ${reviewResumeLine(model, theme)}`,
    `Workspace: ${workspaceStateLine(model, theme)}`,
    `Human reviews: ${humanReviews}`,
    '',
    theme.bold('Current Result'),
    final,
  ];
}

function renderedEventLine(event, model, { verbose = false, rawFallback = false } = {}) {
  const line = renderProgressLine(event, { verbose, repo: model.repo });
  if (!line && rawFallback) return `[event] ${event.type ?? 'unknown'}`;
  return line;
}

function renderSelectableList(lines, selected, theme) {
  if (!lines.length) return [theme.dim('No records yet.')];
  return lines.map((line, index) => `${index === selected ? theme.cyan('>') : ' '} ${line}`);
}

function eventEntries(model) {
  const mode = normalizeViewMode(model.viewMode);
  const events = model.events ?? [];
  return events.flatMap((event, index) => {
    if (mode === 'simple' && !SIMPLE_TIMELINE_EVENT_TYPES.has(event.type)) return [];
    const line = mode === 'extended'
      ? renderedEventLine(event, model, { verbose: true, rawFallback: true })
      : renderProgressLine(event, { verbose: mode === 'verbose', repo: model.repo });
    return line ? [{ event, index, line }] : [];
  });
}

function renderEvents(model, theme) {
  const entries = eventEntries(model);
  const selected = clamp(selectedIndex(model, 'events'), 0, Math.max(0, entries.length - 1));
  const total = model.events?.length ?? 0;
  const mode = normalizeViewMode(model.viewMode);
  const title = mode === 'extended' ? `Raw Events (${total})` : `Timeline (${entries.length}/${total})`;
  const hint = mode === 'simple'
    ? 'Operator timeline. Press v for verbose progress, again for raw extended events.'
    : mode === 'verbose'
      ? 'Verbose progress. Press v for raw events.'
      : 'Extended raw stream. Press v to return to simple timeline.';
  return [
    theme.bold(title),
    theme.dim(hint),
    '',
    ...renderSelectableList(entries.map((entry) => entry.line), selected, theme),
  ];
}

function checkpointLines(model, theme) {
  const state = model.state ?? {};
  const paint = theme ?? {
    green: (value) => value,
    red: (value) => value,
    yellow: (value) => value,
    dim: (value) => value,
  };
  const lines = [];
  if (state.baseRef || state.baseCommit) lines.push(`[base] ${state.baseRef ?? 'base'} @ ${shortSha(state.baseCommit)}`);
  if (state.integration?.commit) lines.push(`[integration] ${state.integration.branch ?? 'integration'} @ ${shortSha(state.integration.commit)}`);
  if (state.workstreams?.length) {
    const integrated = state.workstreams.filter((item) => item.status === 'integrated').length;
    const active = state.workstreams.filter((item) => ['pending', 'running'].includes(item.status)).length;
    lines.push(`[workstreams] ${progressBar(integrated, state.workstreams.length, { theme: paint })} integrated, ${active} active`);
  }
  const setup = state.validation?.setupRuns ?? [];
  if (setup.length) {
    const passed = setup.filter((run) => run.ok).length;
    const failed = setup.filter((run) => !run.ok).length;
    lines.push(`[validation-setup] ${progressBar(passed, setup.length, { failed, theme: paint })} passed`);
  }
  const validation = validationSummary(state.validation?.runs ?? []);
  if (validation.total) {
    const text = `[validation] ${progressBar(validation.passed, validation.total, { failed: validation.failed, theme: paint })} passed, ${validation.failed} failed`;
    lines.push(validation.failed ? paint.red(text) : paint.green(text));
  }
  const reviews = reviewSummary(state.reviews ?? []);
  if (reviews.total) {
    const text = `[reviews] ${progressBar(reviews.approved, reviews.total, { failed: reviews.failed, theme: paint })} approved, ${reviews.failed} not approved`;
    lines.push(reviews.failed ? paint.yellow(text) : paint.green(text));
  }
  for (const review of state.reviews ?? []) {
    const findingCount = review.findings?.length ?? 0;
    const verdict = review.verdict ?? 'unknown';
    const text = `[review] ${review.role ?? 'review'} ${verdict}${findingCount ? ` findings=${findingCount}` : ''}`;
    lines.push(verdict === 'approved' ? paint.green(text) : paint.yellow(text));
  }
  for (const review of state.humanReviews ?? []) {
    lines.push(`[human-review] ${review.id ?? 'recorded'} decisions=${JSON.stringify(review.counts?.byDecision ?? review.decisions ?? {})}`);
  }
  if (state.final?.summary) lines.push(`[final] ${state.final.status ?? state.phase ?? 'result'} commit=${shortSha(state.integration?.commit)} summary=${state.final.summary}`);
  const recent = checkpointEvents(model)
    .map((event) => renderProgressLine(event, { verbose: normalizeViewMode(model.viewMode) !== 'simple', repo: model.repo }))
    .filter(Boolean);
  if (recent.length && normalizeViewMode(model.viewMode) !== 'simple') {
    lines.push('', 'Recent checkpoint events', ...recent);
  }
  if (!lines.length) lines.push('[checkpoint] no checkpoint state yet');
  return lines;
}

function renderCheckpoints(model, theme) {
  const lines = checkpointLines(model, theme);
  const selected = clamp(selectedIndex(model, 'checkpoints'), 0, Math.max(0, lines.length - 1));
  return [
    theme.bold(`Checkpoints (${lines.filter((line) => line !== '').length})`),
    theme.dim('Version and gate summary. Press v for recent checkpoint events.'),
    '',
    ...renderSelectableList(lines, selected, theme),
  ];
}

function renderWorkspace(model, theme) {
  const entries = model.dirtyEntries ?? [];
  const selected = clamp(selectedIndex(model, 'workspace'), 0, Math.max(0, entries.length - 1));
  const lines = [
    theme.bold('Workspace'),
    workspaceStateLine(model, theme),
    '',
  ];
  if (!entries.length) {
    lines.push(theme.green('No uncommitted changes were reported by git status --short.'));
    return lines;
  }
  lines.push(
    theme.bold('Dirty Entries'),
    ...renderSelectableList(entries, selected, theme),
    '',
    theme.bold('Safe Options'),
    'Commit the operator/tooling changes before resuming:',
    '  git status --short',
    '  git add <paths>',
    '  git commit -m "Update Codex Delivery Kit"',
    '',
    'Or stash them before resuming:',
    '  git stash push -u -m "codex delivery local changes"',
    '',
    theme.bold('TUI Option'),
    model.allowDirty
      ? theme.yellow('Dirty resume is enabled for this TUI session. Press ! to disable it.')
      : theme.yellow('Press ! to allow dirty resume for this TUI session. The TUI will not modify Git files.'),
  );
  if (model.allowDirty && canResumeFromTui(model)) {
    lines.push('Press R to start background resume with --allow-dirty semantics.');
  }
  return lines;
}

function decisionLabel(decision, theme) {
  const meta = TUI_DECISIONS[decision];
  if (!meta) return decision ?? 'unset';
  return `${theme.decision(decision, meta.label)} ${theme.dim(`(${decision}; ${meta.description})`)}`;
}

function reviewItemLine(item, decision, hasNote, index, selected, theme) {
  const marker = index === selected ? theme.cyan('>') : ' ';
  const severity = item.severity ? severityBadge(item.severity, theme) : theme.dim(item.type);
  const source = item.role ?? item.criterionId ?? item.type;
  const action = theme.decision(decision, TUI_DECISIONS[decision]?.label ?? decision);
  const note = hasNote ? theme.yellow(' note') : '';
  return `${marker} ${String(index + 1).padStart(2, ' ')}. ${severity} ${source} -> ${action}${note} :: ${item.title}`;
}

function severityBadge(severity, theme) {
  const text = String(severity ?? 'info').toUpperCase();
  if (['critical', 'high'].includes(String(severity))) return theme.red(text);
  if (String(severity) === 'medium') return theme.yellow(text);
  if (String(severity) === 'low') return theme.dim(text);
  return theme.cyan(text);
}

function renderDetailLine(lines, label, value, { expanded = false, mode = 'simple', max = 260 } = {}) {
  if (!value) return;
  const text = expanded || mode === 'extended' ? String(value) : previewText(value, max);
  lines.push(`${label}: ${text}`);
}

function renderReview(model, theme) {
  const inbox = model.inbox ?? {};
  const items = inbox.items ?? [];
  const selected = clamp(selectedIndex(model, 'review'), 0, Math.max(0, items.length - 1));
  const currentDecisions = countBy(items.map((item) => decisionValue(model.pendingDecisions, item)));
  const mode = normalizeViewMode(model.viewMode);
  const lines = [
    theme.bold(`Review Inbox (${items.length})`),
    `Phase: ${inbox.phase ?? model.state?.phase ?? 'unknown'} | items: ${inbox.counts?.total ?? items.length} total, ${inbox.counts?.validation ?? 0} validation, ${inbox.counts?.criteria ?? 0} criteria, ${inbox.counts?.findings ?? 0} findings`,
    `Review state: ${reviewPersistenceLine(model, theme)}`,
    `Resume: ${reviewResumeLine(model, theme)}`,
    `Current decisions: ${Object.entries(currentDecisions).map(([decision, count]) => `${count} ${TUI_DECISIONS[decision]?.label ?? decision}`).join(', ') || 'none'}`,
  ];
  if (!items.length) {
    lines.push('', theme.dim('No human review items for this run.'));
    return lines;
  }
  const allRepair = items.every((item) => decisionValue(model.pendingDecisions, item) === 'repair_requested');
  lines.push(
    '',
    model.reviewSaved && !model.dirty && allRepair
      ? theme.cyan('Saved repair approvals are ready. Press R to resume or inspect items with j/k.')
      : allRepair
        ? theme.cyan('All pending decisions approve Codex repair. Press s to save, or inspect items with j/k first.')
        : theme.yellow('Some pending decisions are not repair approvals. Save only if that is intentional.'),
    '',
    theme.bold('Items'),
  );
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    lines.push(reviewItemLine(item, decisionValue(model.pendingDecisions, item), Boolean(noteValue(model.pendingNotes, item)), index, selected, theme));
  }
  const item = items[selected];
  const expanded = Boolean(model.expandedDetails?.[item.id]);
  lines.push('', theme.bold(`Selected ${selected + 1}/${items.length}${expanded || mode === 'extended' ? ' expanded' : ''}`));
  lines.push(`${severityBadge(item.severity ?? item.type, theme)} ${item.title}`);
  lines.push(`ID: ${item.id}`);
  lines.push(`Suggested: ${decisionLabel(item.defaultDecision, theme)}`);
  lines.push(`Chosen: ${decisionLabel(decisionValue(model.pendingDecisions, item), theme)}`);
  renderDetailLine(lines, 'Summary', item.summary, { expanded, mode });
  renderDetailLine(lines, 'Recommendation', item.recommendation, { expanded, mode });
  if (item.command) lines.push(`Command: ${item.command}`);
  if (item.logPath) lines.push(`Log: ${item.logPath}`);
  if (item.paths?.length) lines.push(`Paths: ${item.paths.join(', ')}`);
  if (item.criterionIds?.length) lines.push(`Criteria: ${item.criterionIds.join(', ')}`);
  if (item.reproduction?.length) lines.push(`Reproduce: ${item.reproduction.join(' | ')}`);
  if (!expanded && mode !== 'extended' && (visibleLength(item.summary ?? '') > 260 || visibleLength(item.recommendation ?? '') > 260)) {
    lines.push(theme.dim('Press x to expand full selected details.'));
  }
  const note = model.noteEditing === item.id ? model.noteBuffer : model.pendingNotes[item.id];
  if (model.noteEditing === item.id) lines.push(`${theme.yellow('Editing note:')} ${note}`);
  else if (note) lines.push(`Note: ${note}`);
  return lines;
}

function bodyLines(model, theme) {
  if (model.panel === 'events') return renderEvents(model, theme);
  if (model.panel === 'checkpoints') return renderCheckpoints(model, theme);
  if (model.panel === 'review') return renderReview(model, theme);
  if (model.panel === 'workspace') return renderWorkspace(model, theme);
  return renderOverview(model, theme);
}

export function renderTuiScreen(model, { width = 100, height = 30 } = {}) {
  const safeWidth = Math.max(40, Number(width) || 100);
  const safeHeight = Math.max(12, Number(height) || 30);
  const theme = makeTheme(model.noColor);
  const header = headerLines(model, theme);
  const footer = footerLines(model, theme);
  const availableBody = Math.max(1, safeHeight - header.length - footer.length);
  return [
    ...lineBlock(header, { width: safeWidth, height: header.length }),
    ...lineBlock(bodyLines(model, theme), { width: safeWidth, height: availableBody }),
    ...lineBlock(footer, { width: safeWidth, height: footer.length }),
  ].join('\n');
}

function normalizedKey(input) {
  if (typeof input === 'string') {
    if (input === '\u0003') return 'ctrl-c';
    if (input === '\r' || input === '\n') return 'enter';
    if (input === '\u001b') return 'escape';
    if (input === '\b' || input === '\u007f') return 'backspace';
    if (input === '\u001b[A') return 'up';
    if (input === '\u001b[B') return 'down';
    if (input.length === 1) return input;
    return input;
  }
  if (input?.ctrl && input.name === 'c') return 'ctrl-c';
  if (input?.name === 'return') return 'enter';
  if (input?.name) return input.name;
  if (input?.sequence) return normalizedKey(input.sequence);
  return '';
}

function applyNoteKey(model, key) {
  const item = currentReviewItem(model);
  if (!item) return { model: { ...model, noteEditing: null, noteBuffer: '', message: 'No review item selected.' }, action: null };
  if (key === 'enter') {
    const pendingNotes = { ...model.pendingNotes, [item.id]: model.noteBuffer };
    return {
      model: withReviewState(model, {
        pendingNotes,
        noteEditing: null,
        noteBuffer: '',
        message: `Note saved for ${item.id}.`,
      }),
      action: null,
    };
  }
  if (key === 'escape') {
    return { model: { ...model, noteEditing: null, noteBuffer: '', message: `Note edit cancelled for ${item.id}.` }, action: null };
  }
  if (key === 'backspace') {
    return { model: { ...model, noteBuffer: model.noteBuffer.slice(0, -1) }, action: null };
  }
  if (typeof key === 'string' && key.length === 1 && key >= ' ') {
    return { model: { ...model, noteBuffer: `${model.noteBuffer}${key}` }, action: null };
  }
  return { model, action: null };
}

export function applyTuiKey(model, keyInput) {
  const key = normalizedKey(keyInput);
  if (model.noteEditing) return applyNoteKey(model, key);
  if (key === 'q' || key === 'ctrl-c') return { model: { ...model, message: 'Closing TUI.' }, action: 'quit' };
  if (key === 'R') {
    const disabled = resumeDisabledReason(model);
    if (disabled) return { model: { ...model, message: disabled }, action: null };
    return { model: { ...model, message: 'Starting background resume...', resumeState: { status: 'starting' } }, action: 'resume' };
  }
  if (key === '!') {
    if (!model.repoDirty) return { model: { ...model, message: 'Working tree is clean; allow-dirty is not needed.' }, action: null };
    const allowDirty = !model.allowDirty;
    return {
      model: {
        ...model,
        allowDirty,
        panel: 'workspace',
        message: allowDirty
          ? 'Dirty resume allowed for this TUI session. Press R to resume if review decisions are saved.'
          : 'Dirty resume disabled. Commit/stash changes or press ! to allow it again.',
      },
      action: null,
    };
  }
  if (key === 'v') {
    const viewMode = nextViewMode(model.viewMode);
    return { model: { ...model, viewMode, selected: { ...model.selected, events: 0 }, message: `View mode: ${viewMode}.` }, action: null };
  }
  if (/^[1-5]$/.test(key)) {
    const panel = TUI_PANELS[Number(key) - 1];
    return { model: { ...model, panel, message: `${PANEL_LABELS[panel]} panel.` }, action: null };
  }
  if (key === 'j' || key === 'down') {
    return { model: setSelection(model, model.panel, selectedIndex(model) + 1), action: null };
  }
  if (key === 'k' || key === 'up') {
    return { model: setSelection(model, model.panel, selectedIndex(model) - 1), action: null };
  }
  if (model.panel === 'review') {
    const item = currentReviewItem(model);
    if (key === 's') {
      if (!(model.inbox?.items ?? []).length) return { model: { ...model, message: 'No review items to save.' }, action: null };
      if (!['blocked', 'failed'].includes(model.state?.phase)) return { model: { ...model, message: 'Review decisions can be saved only for blocked or failed runs.' }, action: null };
      return { model: { ...model, message: 'Saving review decisions...' }, action: 'save' };
    }
    if (key === 'A') {
      const pendingDecisions = { ...model.pendingDecisions };
      for (const reviewItem of model.inbox?.items ?? []) pendingDecisions[reviewItem.id] = 'repair_requested';
      return {
        model: withReviewState(model, { pendingDecisions, message: 'All review items set to approve Codex repair.' }),
        action: null,
      };
    }
    if (key === 'x') {
      if (!item) return { model: { ...model, message: 'No review item selected.' }, action: null };
      const expandedDetails = { ...model.expandedDetails, [item.id]: !model.expandedDetails?.[item.id] };
      return {
        model: { ...model, expandedDetails, message: `${item.id}: details ${expandedDetails[item.id] ? 'expanded' : 'collapsed'}.` },
        action: null,
      };
    }
    if (key === 'n') {
      if (!item) return { model: { ...model, message: 'No review item selected.' }, action: null };
      return { model: { ...model, noteEditing: item.id, noteBuffer: model.pendingNotes[item.id] ?? '', message: `Editing note for ${item.id}.` }, action: null };
    }
    if (key === 'enter') {
      if (!item) return { model: { ...model, message: 'No review item selected.' }, action: null };
      const decision = item.defaultDecision ?? 'repair_requested';
      return {
        model: withReviewState(model, { pendingDecisions: { ...model.pendingDecisions, [item.id]: decision }, message: `${item.id}: ${decision}.` }),
        action: null,
      };
    }
    const decision = DECISION_BY_KEY.get(key);
    if (decision && item) {
      return {
        model: withReviewState(model, { pendingDecisions: { ...model.pendingDecisions, [item.id]: decision }, message: `${item.id}: ${decision}.` }),
        action: null,
      };
    }
  }
  return { model, action: null };
}

export function reviewDecisionCounts(model) {
  return countBy((model.inbox?.items ?? []).map((item) => decisionValue(model.pendingDecisions, item)));
}

function frameText(outputStream, model) {
  const width = outputStream.columns || 100;
  const height = outputStream.rows || 30;
  return `\u001b[H\u001b[2J${renderTuiScreen(model, { width, height })}`;
}

function assertInteractiveTty(inputStream, outputStream) {
  if (!inputStream?.isTTY || !outputStream?.isTTY) {
    throw new Error('TUI mode requires an interactive terminal. Use status, status --json, review, or review --json in non-TTY contexts.');
  }
}

export async function runTerminalTui({
  inputStream = process.stdin,
  outputStream = process.stdout,
  load,
  saveReview = null,
  resumeRun = null,
  initialPanel = 'overview',
  viewMode = 'simple',
  noColor = false,
  refreshMs = 1000,
  once = false,
} = {}) {
  if (typeof load !== 'function') throw new Error('TUI load callback is required.');
  if (!once) assertInteractiveTty(inputStream, outputStream);

  let model = createTuiModel({ ...await load(), initialPanel, viewMode, noColor });
  if (once) {
    outputStream.write(renderTuiScreen(model, { width: outputStream.columns || 100, height: outputStream.rows || 30 }));
    return model;
  }

  outputStream.write('\u001b[?1049h\u001b[?25l');
  const previousRawMode = inputStream.isRaw ?? false;
  if (typeof inputStream.setRawMode === 'function') inputStream.setRawMode(true);
  inputStream.resume?.();
  readline.emitKeypressEvents(inputStream);

  let closed = false;
  let saving = false;
  let resuming = false;
  let reloadInFlight = false;
  let lastFrame = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const close = () => {
    if (closed) return;
    closed = true;
    resolveDone();
  };

  const redraw = (force = false) => {
    const frame = frameText(outputStream, model);
    if (force || frame !== lastFrame) {
      outputStream.write(frame);
      lastFrame = frame;
    }
  };
  const onKey = async (str, key) => {
    if (saving || resuming) {
      model = { ...model, message: saving ? 'Save is already in progress.' : 'Resume is already starting.' };
      redraw();
      return;
    }
    const result = applyTuiKey(model, str && str.length ? str : key);
    model = result.model;
    if (result.action === 'save') {
      if (!saveReview) {
        model = { ...model, message: 'This TUI session cannot save review decisions.' };
      } else if (!saving) {
        saving = true;
        redraw();
        try {
          const saved = await saveReview(model);
          model = markReviewSaved(model, saved);
        } catch (error) {
          model = { ...model, message: `Save failed: ${error?.message ?? String(error)}` };
        } finally {
          saving = false;
        }
      }
    } else if (result.action === 'resume') {
      if (!resumeRun) {
        model = { ...model, message: 'This TUI session cannot resume delivery.' };
      } else {
        resuming = true;
        redraw();
        try {
          const started = await resumeRun(model);
          model = {
            ...model,
            resumeState: {
              status: started?.status ?? 'running',
              pid: started?.pid ?? null,
              logPath: started?.backgroundLogPath ?? started?.logPath ?? null,
              startedAt: new Date().toISOString(),
              message: 'Background resume started.',
            },
            message: `Resume started${started?.pid ? ` pid=${started.pid}` : ''}.`,
          };
        } catch (error) {
          model = {
            ...model,
            resumeState: { status: 'failed', error: error?.message ?? String(error) },
            message: `Resume failed: ${error?.message ?? String(error)}`,
          };
        } finally {
          resuming = false;
        }
      }
    }
    redraw();
    if (result.action === 'quit') close();
  };

  const refresh = async () => {
    if (closed || reloadInFlight || saving || resuming || model.noteEditing) return;
    reloadInFlight = true;
    try {
      const next = createTuiModel({ ...await load(), initialPanel, viewMode, noColor });
      model = mergeModel(model, next);
      redraw();
    } catch (error) {
      model = { ...model, message: `Refresh failed: ${error?.message ?? String(error)}` };
      redraw();
    } finally {
      reloadInFlight = false;
    }
  };

  inputStream.on('keypress', onKey);
  redraw(true);
  const timer = setInterval(refresh, Math.max(250, Number(refreshMs) || 1000));

  try {
    while (!closed) await Promise.race([done, delay(250)]);
    return model;
  } finally {
    clearInterval(timer);
    inputStream.off?.('keypress', onKey);
    if (typeof inputStream.setRawMode === 'function') inputStream.setRawMode(previousRawMode);
    outputStream.write('\u001b[?25h\u001b[?1049l');
  }
}
