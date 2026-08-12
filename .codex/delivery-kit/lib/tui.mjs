import React from 'react';
import { Box, Text, render as renderInk, renderToString, useApp, useInput, useWindowSize } from 'ink';
import { renderProgressLine } from './progress.mjs';
import { computeRunTelemetry, formatAge, formatDuration as formatRunDuration, timestampMs } from './time-progress.mjs';

const { useEffect, useRef, useState } = React;
const h = React.createElement;

export const TUI_PANELS = ['cockpit', 'review', 'timeline', 'workspace', 'diagnostics'];
export const TUI_PANEL_ALIASES = {
  overview: 'cockpit',
  events: 'timeline',
  checkpoints: 'diagnostics',
};
export const TUI_VIEW_MODES = ['simple', 'verbose', 'extended'];
export const TUI_VIEW_ALIASES = {
  normal: 'simple',
  detail: 'verbose',
  raw: 'extended',
};

const PANEL_LABELS = {
  cockpit: 'Cockpit',
  timeline: 'Timeline',
  diagnostics: 'Diagnostics',
  review: 'Review',
  workspace: 'Workspace',
};

const VIEW_LABELS = {
  simple: 'normal',
  verbose: 'detail',
  extended: 'raw',
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
  const mode = TUI_VIEW_ALIASES[value] ?? value;
  return TUI_VIEW_MODES.includes(mode) ? mode : 'simple';
}

function normalizePanel(value) {
  const panel = TUI_PANEL_ALIASES[value] ?? value;
  return TUI_PANELS.includes(panel) ? panel : 'cockpit';
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

function withDerivedTuiFields(model) {
  const telemetry = computeRunTelemetry(model.state, model.events ?? [], model.background);
  const enriched = { ...model, telemetry };
  return { ...enriched, interventionItems: buildInterventionItems(enriched) };
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
  return withDerivedTuiFields({ ...next, dirty: reviewDirty(next) });
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
  if (model.repoDirty && !model.allowDirty) return 'Repository has uncommitted changes. Press 4 for Workspace, press ! to allow dirty resume, or commit/stash changes.';
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
  return Number(model.selected?.[normalizePanel(panel)] ?? 0);
}

function maxSelection(model, panel = model.panel) {
  const normalized = normalizePanel(panel);
  if (normalized === 'cockpit') return Math.max(0, (model.interventionItems ?? []).length - 1);
  if (normalized === 'timeline') return Math.max(0, eventEntries(model).length - 1);
  if (normalized === 'diagnostics') return Math.max(0, diagnosticsLines(model, null).length - 1);
  if (normalized === 'review') return Math.max(0, (model.inbox?.items ?? []).length - 1);
  if (normalized === 'workspace') return Math.max(0, (model.dirtyEntries ?? []).length - 1);
  return 0;
}

function setSelection(model, panel, value) {
  const normalized = normalizePanel(panel);
  const selected = { ...model.selected };
  selected[normalized] = clamp(value, 0, maxSelection(model, normalized));
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
  initialPanel = 'cockpit',
  viewMode = 'simple',
  dirtyEntries = [],
  allowDirty = false,
  noColor = false,
  noTime = false,
  message = null,
} = {}) {
  const panel = normalizePanel(initialPanel);
  const baseline = reviewBaseline(state, inbox);
  const pendingDecisions = { ...baseline.pendingDecisions };
  const pendingNotes = { ...baseline.pendingNotes };
  return withDerivedTuiFields({
    repo,
    runId: runId ?? state?.runId ?? inbox?.runId ?? null,
    state,
    background,
    inbox,
    events: events.slice(-300),
    panel,
    viewMode: normalizeViewMode(viewMode),
    selected: { cockpit: 0, review: 0, timeline: 0, workspace: 0, diagnostics: 0 },
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
    noTime: Boolean(noTime),
    confirmAction: null,
    helpVisible: false,
  });
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
    noTime: previous.noTime,
    confirmAction: sameReview ? previous.confirmAction : null,
    helpVisible: previous.helpVisible,
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
  const telemetry = model.telemetry ?? computeRunTelemetry(state, model.events ?? [], model.background);
  const timing = model.noTime
    ? ''
    : ` elapsed=${durationText(telemetry.timing?.elapsedMs)} phase=${durationText(telemetry.timing?.phaseElapsedMs)} ${etaText(telemetry.eta)}`;
  const tabs = TUI_PANELS.map((panel, index) => {
    const label = `${index + 1} ${PANEL_LABELS[panel]}`;
    return panel === model.panel ? theme.bold(theme.blue(`[${label}]`)) : theme.dim(label);
  }).join('  ');
  return [
    `${theme.bold('Codex Delivery TUI')} ${theme.dim('|')} ${model.runId ?? 'no-run'} ${theme.dim('|')} phase=${theme.phase(state.phase)} repair=${state.repairIteration ?? 0}/${state.maxRepairs ?? 0} progress=${telemetry.progress?.percent ?? 0}% view=${VIEW_LABELS[model.viewMode] ?? model.viewMode}${timing}`,
    `${tabs}  ${theme.dim(`background=${backgroundStatus}${alive}`)}`,
    '-'.repeat(80),
  ];
}

function footerLines(model, theme) {
  if (model.confirmAction) {
    return [
      '-'.repeat(80),
      `${theme.yellow('confirm:')} ${model.confirmAction.prompt}  y confirm, Esc/n cancel`,
      model.message ? `${theme.bold('status:')} ${model.message}` : null,
    ].filter(Boolean);
  }
  if (model.noteEditing) {
    return [
      '-'.repeat(80),
      `${theme.yellow('note:')} Enter save, Esc cancel, Backspace delete, typing edits note`,
      model.message ? `${theme.bold('status:')} ${model.message}` : null,
    ].filter(Boolean);
  }
  const common = '1 cockpit, 2 review, 3 timeline, 4 workspace, 5 diagnostics, v view, ? help, q quit';
  const navigation = ['cockpit', 'timeline', 'diagnostics', 'review', 'workspace'].includes(model.panel) ? ', j/k or arrows move' : '';
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
        'Recommended: press 2 to review pending choices, then s to save them.',
      ];
    }
    if (model.reviewSaved) {
      const resumeDisabled = resumeDisabledReason(model);
      if (model.repoDirty && !model.allowDirty) {
        return [
          reviewPersistenceLine(model, theme),
          theme.yellow('Repository has uncommitted changes, so background resume is blocked by default.'),
          `Recommended: press 4 to inspect Workspace, then commit/stash changes or press ! to allow dirty resume.`,
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
      'Recommended: open Review for failure classification or inspect Timeline/Diagnostics for the failing command.',
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

function decisionCountsText(items, decisions) {
  const counts = countBy(items.map((item) => decisionValue(decisions, item)));
  return Object.entries(counts)
    .map(([decision, count]) => `${count} ${TUI_DECISIONS[decision]?.label ?? decision}`)
    .join(', ');
}

function buildInterventionItems(model) {
  const queue = [];
  const state = model.state ?? {};
  const items = model.inbox?.items ?? [];
  const validation = validationSummary(state.validation?.runs ?? []);
  const reviews = reviewSummary(state.reviews ?? []);
  const blocked = ['blocked', 'failed'].includes(state.phase);
  const allRepair = items.length > 0 && items.every((item) => decisionValue(model.pendingDecisions, item) === 'repair_requested');
  if (blocked && items.length) {
    if (!model.reviewSaved || model.dirty) {
      queue.push({
        id: 'save-review',
        severity: model.dirty ? 'high' : 'medium',
        title: model.dirty ? 'Save review changes' : allRepair ? 'Save default repair approvals' : 'Save review decisions',
        summary: `${countPhrase(items.length, 'review item')} selected as ${decisionCountsText(items, model.pendingDecisions) || 'none'}.`,
        panel: 'review',
        action: 'save',
      });
    } else if (canResumeFromTui(model)) {
      queue.push({
        id: 'resume',
        severity: 'medium',
        title: 'Resume automation',
        summary: 'Saved repair decisions are durable; background resume can continue the run.',
        panel: 'review',
        action: 'resume',
      });
    } else {
      const reason = resumeDisabledReason(model);
      queue.push({
        id: 'resume-blocked',
        severity: model.repoDirty && !model.allowDirty ? 'high' : 'medium',
        title: 'Resume is blocked',
        summary: reason ?? 'Resume is not available for this run state.',
        panel: model.repoDirty && !model.allowDirty ? 'workspace' : 'review',
      });
    }
  }
  if (model.repoDirty && !model.allowDirty) {
    queue.push({
      id: 'workspace-dirty',
      severity: 'high',
      title: 'Resolve dirty workspace',
      summary: 'Commit or stash local changes, or explicitly allow dirty resume for this TUI session.',
      panel: 'workspace',
    });
  }
  const environmentCount = items.filter((item) => decisionValue(model.pendingDecisions, item) === 'environment_required').length;
  const manualCount = items.filter((item) => decisionValue(model.pendingDecisions, item) === 'manual_required').length;
  if (environmentCount) {
    queue.push({
      id: 'environment-required',
      severity: 'medium',
      title: 'Environment action selected',
      summary: `${countPhrase(environmentCount, 'item')} require local tools, services, credentials, or setup before automation can finish.`,
      panel: 'review',
    });
  }
  if (manualCount) {
    queue.push({
      id: 'manual-required',
      severity: 'medium',
      title: 'Manual action selected',
      summary: `${countPhrase(manualCount, 'item')} require human work or verification outside automated repair.`,
      panel: 'review',
    });
  }
  if (!blocked && validation.failed > 0) {
    queue.push({
      id: 'validation-failed',
      severity: 'high',
      title: 'Validation failed',
      summary: `${countPhrase(validation.failed, 'command')} failed; review classification will be available when the run blocks.`,
      panel: 'timeline',
    });
  }
  if (!blocked && reviews.failed > 0) {
    queue.push({
      id: 'review-failed',
      severity: 'medium',
      title: 'Review findings pending',
      summary: `${countPhrase(reviews.failed, 'review track')} did not approve the integrated result.`,
      panel: 'diagnostics',
    });
  }
  return queue;
}

function durationText(ms) {
  return ms === null || ms === undefined ? 'n/a' : formatRunDuration(ms);
}

function etaText(eta) {
  if (!eta || eta.remainingMs === null || eta.remainingMs === undefined) {
    return `ETA unknown${eta?.reason ? ` (${eta.reason})` : ''}`;
  }
  return `ETA ~${formatRunDuration(eta.remainingMs)} (${eta.confidence ?? 'low'})`;
}

function phaseProgressLine(phase, theme) {
  const percent = Math.round((phase.fraction ?? 0) * 100);
  const bar = progressBar(percent, 100, { width: 14, theme });
  return `${phase.label.padEnd(14, ' ')} ${bar} ${String(percent).padStart(3, ' ')}%`;
}

function ageText(at, model) {
  const started = timestampMs(at);
  if (started === null) return 'age=n/a';
  return `age=${formatRunDuration(Math.max(0, Date.now() - started))}`;
}

function activeEventItems(model) {
  const active = new Map();
  for (const event of model.events ?? []) {
    if (event.type === 'codex.run.started') {
      active.set(`agent:${event.label}`, {
        kind: 'agent',
        title: event.label ?? event.role ?? 'agent',
        detail: `role=${event.role ?? 'unknown'}${event.workstreamId ? ` workstream=${event.workstreamId}` : ''}`,
        at: event.at,
      });
    } else if (event.type === 'codex.run.completed' || event.type === 'codex.result.invalid') {
      active.delete(`agent:${event.label}`);
    } else if (event.type === 'validation.started') {
      active.set(`validation:${event.command}`, {
        kind: 'validation',
        title: event.command,
        detail: `${event.index ?? '?'}/${event.total ?? '?'}`,
        at: event.at,
      });
    } else if (event.type === 'validation.completed' || event.type === 'validation.rejected') {
      active.delete(`validation:${event.command}`);
    } else if (event.type === 'validation.setup.started') {
      active.set(`setup:${event.command}`, {
        kind: 'setup',
        title: event.command,
        detail: `${event.index ?? '?'}/${event.total ?? '?'}`,
        at: event.at,
      });
    } else if (event.type === 'validation.setup.completed' || event.type === 'validation.setup.skipped') {
      active.delete(`setup:${event.command}`);
    } else if (event.type === 'inspection.started') {
      active.set(`inspection:${event.id ?? event.role}`, {
        kind: 'inspection',
        title: event.role ?? event.id ?? 'inspection',
        detail: `phase=${event.inspectionPhase ?? event.phase ?? 'unknown'}`,
        at: event.at,
      });
    } else if (event.type === 'inspection.completed') {
      active.delete(`inspection:${event.id ?? event.role}`);
    }
  }
  return [...active.values()];
}

function activeWorkLines(model, theme) {
  const lines = [];
  const running = (model.state?.workstreams ?? []).filter((item) => item.status === 'running');
  for (const workstream of running) {
    lines.push(`${theme.cyan('workstream')} ${workstream.id}: ${workstream.title} (${ageText(workstream.startedAt, model)})`);
  }
  for (const item of activeEventItems(model)) {
    lines.push(`${theme.cyan(item.kind)} ${item.title} ${theme.dim(item.detail)} (${ageText(item.at, model)})`);
  }
  if (resumeRunning(model)) {
    const pid = model.resumeState?.pid ? ` pid=${model.resumeState.pid}` : '';
    lines.push(`${theme.cyan('resume')} background ${model.resumeState.status}${pid}`);
  }
  if (!lines.length) lines.push(theme.dim('No active work item is currently visible.'));
  return lines.slice(0, 8);
}

function interventionLine(item, index, selected, theme) {
  const marker = index === selected ? theme.cyan('>') : ' ';
  return `${marker} ${severityBadge(item.severity ?? 'info', theme)} ${item.title} :: ${item.summary}`;
}

function timelineSnapshotLines(model) {
  return eventEntries(model)
    .slice(-5)
    .map((entry) => entry.line);
}

function renderCockpit(model, theme) {
  const state = model.state ?? {};
  const telemetry = model.telemetry ?? computeRunTelemetry(state, model.events ?? [], model.background);
  const selected = clamp(selectedIndex(model, 'cockpit'), 0, Math.max(0, (model.interventionItems ?? []).length - 1));
  const nextAction = nextActionLines(model, validationSummary(state.validation?.runs ?? []), reviewSummary(state.reviews ?? []), theme);
  const lines = [
    theme.bold('Autopilot Cockpit'),
    `Objective: ${state.objective ?? 'n/a'}`,
    ...nextAction,
    '',
    theme.bold('Progress'),
    `Overall ${progressBar(telemetry.progress?.percent ?? 0, 100, { width: 28, theme })} ${telemetry.progress?.label ?? 'unknown'}`,
    ...(telemetry.progress?.phases ?? []).map((phase) => phaseProgressLine(phase, theme)),
  ];
  lines.push(
    '',
    theme.bold(`Intervention Queue (${model.interventionItems?.length ?? 0})`),
  );
  if (!(model.interventionItems ?? []).length) lines.push(theme.green('No operator action is required.'));
  else {
    lines.push(...model.interventionItems.map((item, index) => interventionLine(item, index, selected, theme)));
    lines.push(theme.dim('Enter opens the selected item or starts its suggested action.'));
  }
  if (!model.noTime) {
    lines.push(
      '',
      theme.bold('Time'),
      `Elapsed: ${durationText(telemetry.timing?.elapsedMs)} | Phase: ${durationText(telemetry.timing?.phaseElapsedMs)} | ${etaText(telemetry.eta)}`,
      `Last event: ${formatAge(telemetry.timing?.updatedAgoMs)} | Heartbeat: ${formatAge(telemetry.timing?.heartbeatAgoMs)}`,
    );
  }
  lines.push(
    '',
    theme.bold('Active Work'),
    ...activeWorkLines(model, theme),
  );
  const recent = timelineSnapshotLines(model);
  lines.push('', theme.bold('Timeline Snapshot'), ...(recent.length ? recent : [theme.dim('No high-signal events yet.')]));
  if (model.helpVisible) {
    lines.push(
      '',
      theme.bold('Keys'),
      '1 cockpit, 2 review, 3 timeline, 4 workspace, 5 diagnostics, Enter selected, y confirm, Esc/n cancel, ? help, q quit',
    );
  }
  return lines;
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
  const selected = clamp(selectedIndex(model, 'timeline'), 0, Math.max(0, entries.length - 1));
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

function diagnosticsLines(model, theme) {
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

function renderDiagnostics(model, theme) {
  const lines = diagnosticsLines(model, theme);
  const selected = clamp(selectedIndex(model, 'diagnostics'), 0, Math.max(0, lines.length - 1));
  return [
    theme.bold(`Diagnostics (${lines.filter((line) => line !== '').length})`),
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
  if (model.panel === 'timeline') return renderEvents(model, theme);
  if (model.panel === 'diagnostics') return renderDiagnostics(model, theme);
  if (model.panel === 'review') return renderReview(model, theme);
  if (model.panel === 'workspace') return renderWorkspace(model, theme);
  return renderCockpit(model, theme);
}

function renderTuiLines(model, { width = 100, height = 30 } = {}) {
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
  ];
}

function TuiFrame({ model, width = 100, height = 30 }) {
  const lines = renderTuiLines(model, { width, height });
  return h(
    Box,
    { flexDirection: 'column', width },
    lines.map((line, index) => h(Text, { key: `line-${index}` }, line === '' ? ' ' : line)),
  );
}

export function renderTuiScreen(model, { width = 100, height = 30 } = {}) {
  const safeWidth = Math.max(40, Number(width) || 100);
  const safeHeight = Math.max(12, Number(height) || 30);
  return renderToString(h(TuiFrame, { model, width: safeWidth, height: safeHeight }), { columns: safeWidth });
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

function requestSaveConfirmation(model) {
  if (!(model.inbox?.items ?? []).length) return { model: { ...model, message: 'No review items to save.' }, action: null };
  if (!['blocked', 'failed'].includes(model.state?.phase)) {
    return { model: { ...model, message: 'Review decisions can be saved only for blocked or failed runs.' }, action: null };
  }
  return {
    model: {
      ...model,
      panel: model.panel === 'cockpit' ? 'cockpit' : 'review',
      confirmAction: {
        type: 'save',
        prompt: `Save ${countPhrase(model.inbox.items.length, 'review decision')} for run ${model.runId ?? '<run-id>'}?`,
      },
      message: 'Confirm save with y.',
    },
    action: null,
  };
}

function requestResumeConfirmation(model) {
  const disabled = resumeDisabledReason(model);
  if (disabled) return { model: { ...model, message: disabled }, action: null };
  return {
    model: {
      ...model,
      confirmAction: {
        type: 'resume',
        prompt: `Start background resume for run ${model.runId ?? '<run-id>'}?`,
      },
      message: 'Confirm background resume with y.',
    },
    action: null,
  };
}

function activateCockpitItem(model) {
  const item = (model.interventionItems ?? [])[selectedIndex(model, 'cockpit')];
  if (!item) return { model: { ...model, message: 'No operator action is required right now.' }, action: null };
  if (item.action === 'save') return requestSaveConfirmation(model);
  if (item.action === 'resume') return requestResumeConfirmation(model);
  const panel = normalizePanel(item.panel);
  return { model: { ...model, panel, message: `${PANEL_LABELS[panel]} panel.` }, action: null };
}

function applyConfirmKey(model, key) {
  if (key === 'q' || key === 'ctrl-c') return { model: { ...model, message: 'Closing TUI.' }, action: 'quit' };
  if (key === 'y' && model.confirmAction?.type) {
    const action = model.confirmAction.type;
    return {
      model: {
        ...model,
        confirmAction: null,
        resumeState: action === 'resume' ? { status: 'starting' } : model.resumeState,
        message: action === 'save' ? 'Saving review decisions...' : 'Starting background resume...',
      },
      action,
    };
  }
  if (key === 'n' || key === 'escape') {
    return { model: { ...model, confirmAction: null, message: 'Action cancelled.' }, action: null };
  }
  return { model: { ...model, message: 'Confirm with y, or cancel with Esc/n.' }, action: null };
}

export function applyTuiKey(model, keyInput) {
  const key = normalizedKey(keyInput);
  if (model.noteEditing) return applyNoteKey(model, key);
  if (model.confirmAction) return applyConfirmKey(model, key);
  if (key === 'q' || key === 'ctrl-c') return { model: { ...model, message: 'Closing TUI.' }, action: 'quit' };
  if (key === '?') return { model: { ...model, helpVisible: !model.helpVisible, message: model.helpVisible ? 'Help hidden.' : 'Help shown.' }, action: null };
  if (key === 'R') {
    return requestResumeConfirmation(model);
  }
  if (key === 's') {
    return requestSaveConfirmation(model);
  }
  if (key === '!') {
    if (!model.repoDirty) return { model: { ...model, message: 'Working tree is clean; allow-dirty is not needed.' }, action: null };
    const allowDirty = !model.allowDirty;
    return {
      model: withDerivedTuiFields({
        ...model,
        allowDirty,
        panel: 'workspace',
        message: allowDirty
          ? 'Dirty resume allowed for this TUI session. Press R to resume if review decisions are saved.'
          : 'Dirty resume disabled. Commit/stash changes or press ! to allow it again.',
      }),
      action: null,
    };
  }
  if (key === 'v') {
    const viewMode = nextViewMode(model.viewMode);
    return { model: { ...model, viewMode, selected: { ...model.selected, timeline: 0 }, message: `View mode: ${VIEW_LABELS[viewMode] ?? viewMode}.` }, action: null };
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
  if (model.panel === 'cockpit' && key === 'enter') {
    return activateCockpitItem(model);
  }
  if (model.panel === 'review') {
    const item = currentReviewItem(model);
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

function assertInteractiveTty(inputStream, outputStream) {
  if (!inputStream?.isTTY || !outputStream?.isTTY) {
    throw new Error('TUI mode requires an interactive terminal. Use status, status --json, review, or review --json in non-TTY contexts.');
  }
}

function keyInputFromInk(input, key = {}) {
  if (key.ctrl && input === 'c') return '\u0003';
  if (key.return) return '\r';
  if (key.escape) return '\u001b';
  if (key.backspace || key.delete) return '\u007f';
  if (key.upArrow) return '\u001b[A';
  if (key.downArrow) return '\u001b[B';
  return input ?? '';
}

function splitPrintableKeyInput(keyInput) {
  if (typeof keyInput !== 'string' || keyInput.length <= 1 || keyInput.startsWith('\u001b')) return [keyInput];
  return [...keyInput];
}

function ensureInkInputStream(inputStream) {
  if (inputStream && typeof inputStream.ref !== 'function') inputStream.ref = () => inputStream;
  if (inputStream && typeof inputStream.unref !== 'function') inputStream.unref = () => inputStream;
  return inputStream;
}

function InkTuiApp({
  initialModel,
  load,
  saveReview,
  resumeRun,
  initialPanel,
  viewMode,
  noColor,
  noTime,
  refreshMs,
  onModelChange,
}) {
  const { exit } = useApp();
  const { columns = 100, rows = 30 } = useWindowSize();
  const [model, setModel] = useState(initialModel);
  const modelRef = useRef(initialModel);
  const savingRef = useRef(false);
  const resumingRef = useRef(false);
  const reloadInFlightRef = useRef(false);
  const closedRef = useRef(false);

  const commitModel = (next) => {
    modelRef.current = next;
    onModelChange?.(next);
    setModel(next);
  };

  const close = (next = modelRef.current) => {
    if (closedRef.current) return;
    closedRef.current = true;
    commitModel(next);
    exit();
  };

  const performAction = async (action, actionModel) => {
    if (action === 'save') {
      if (!saveReview) {
        commitModel({ ...actionModel, message: 'This TUI session cannot save review decisions.' });
        return;
      }
      savingRef.current = true;
      try {
        const saved = await saveReview(actionModel);
        commitModel(markReviewSaved(modelRef.current, saved));
      } catch (error) {
        commitModel({ ...modelRef.current, message: `Save failed: ${error?.message ?? String(error)}` });
      } finally {
        savingRef.current = false;
      }
      return;
    }

    if (action === 'resume') {
      if (!resumeRun) {
        commitModel({ ...actionModel, resumeState: { status: 'idle' }, message: 'This TUI session cannot resume delivery.' });
        return;
      }
      resumingRef.current = true;
      try {
        const started = await resumeRun(actionModel);
        commitModel(withDerivedTuiFields({
          ...modelRef.current,
          resumeState: {
            status: started?.status ?? 'running',
            pid: started?.pid ?? null,
            logPath: started?.backgroundLogPath ?? started?.logPath ?? null,
            startedAt: new Date().toISOString(),
            message: 'Background resume started.',
          },
          message: `Resume started${started?.pid ? ` pid=${started.pid}` : ''}.`,
        }));
      } catch (error) {
        commitModel(withDerivedTuiFields({
          ...modelRef.current,
          resumeState: { status: 'failed', error: error?.message ?? String(error) },
          message: `Resume failed: ${error?.message ?? String(error)}`,
        }));
      } finally {
        resumingRef.current = false;
      }
    }
  };

  useInput((input, key) => {
    void (async () => {
      for (const keyInput of splitPrintableKeyInput(keyInputFromInk(input, key))) {
        if (savingRef.current || resumingRef.current) {
          commitModel({ ...modelRef.current, message: savingRef.current ? 'Save is already in progress.' : 'Resume is already starting.' });
          continue;
        }
        const result = applyTuiKey(modelRef.current, keyInput);
        commitModel(result.model);
        if (result.action === 'quit') {
          close(result.model);
          return;
        }
        if (result.action) await performAction(result.action, result.model);
      }
    })();
  });

  useEffect(() => {
    const timer = setInterval(async () => {
      if (closedRef.current || reloadInFlightRef.current || savingRef.current || resumingRef.current || modelRef.current.noteEditing) return;
      reloadInFlightRef.current = true;
      try {
        const next = createTuiModel({ ...await load(), initialPanel, viewMode, noColor, noTime });
        commitModel(mergeModel(modelRef.current, next));
      } catch (error) {
        commitModel({ ...modelRef.current, message: `Refresh failed: ${error?.message ?? String(error)}` });
      } finally {
        reloadInFlightRef.current = false;
      }
    }, Math.max(250, Number(refreshMs) || 1000));
    return () => clearInterval(timer);
  }, []);

  return h(TuiFrame, {
    model,
    width: Math.max(40, Number(columns) || 100),
    height: Math.max(12, Number(rows) || 30),
  });
}

export async function runTerminalTui({
  inputStream = process.stdin,
  outputStream = process.stdout,
  load,
  saveReview = null,
  resumeRun = null,
  initialPanel = 'cockpit',
  viewMode = 'simple',
  noColor = false,
  noTime = false,
  refreshMs = 1000,
  once = false,
} = {}) {
  if (typeof load !== 'function') throw new Error('TUI load callback is required.');
  if (!once) assertInteractiveTty(inputStream, outputStream);

  let model = createTuiModel({ ...await load(), initialPanel, viewMode, noColor, noTime });
  if (once) {
    outputStream.write(renderTuiScreen(model, { width: outputStream.columns || 100, height: outputStream.rows || 30 }));
    return model;
  }

  const instance = renderInk(
    h(InkTuiApp, {
      initialModel: model,
      load,
      saveReview,
      resumeRun,
      initialPanel,
      viewMode,
      noColor,
      noTime,
      refreshMs,
      onModelChange: (next) => {
        model = next;
      },
    }),
    {
      stdin: ensureInkInputStream(inputStream),
      stdout: outputStream,
      stderr: outputStream,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: true,
      alternateScreen: true,
      maxFps: 60,
    },
  );

  await instance.waitUntilExit();
  return model;
}
