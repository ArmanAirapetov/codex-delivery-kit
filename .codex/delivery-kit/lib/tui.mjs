import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { renderProgressLine } from './progress.mjs';

export const TUI_PANELS = ['overview', 'events', 'checkpoints', 'review'];

const PANEL_LABELS = {
  overview: 'Overview',
  events: 'Events',
  checkpoints: 'Checkpoints',
  review: 'Review',
};

export const TUI_DECISIONS = {
  repair_requested: {
    key: 'r',
    label: 'repair',
    description: 'approve Codex repair',
    color: 'cyan',
  },
  environment_required: {
    key: 'e',
    label: 'env',
    description: 'fix local environment',
    color: 'yellow',
  },
  manual_required: {
    key: 'm',
    label: 'manual',
    description: 'human action required',
    color: 'magenta',
  },
  acknowledged: {
    key: 'a',
    label: 'ack',
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

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
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

function initialDecisionMap(inbox) {
  return Object.fromEntries((inbox?.items ?? []).map((item) => [item.id, item.defaultDecision ?? 'repair_requested']));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function selectedIndex(model, panel = model.panel) {
  return Number(model.selected?.[panel] ?? 0);
}

function maxSelection(model, panel = model.panel) {
  if (panel === 'events') return Math.max(0, (model.events ?? []).length - 1);
  if (panel === 'checkpoints') return Math.max(0, checkpointEvents(model).length - 1);
  if (panel === 'review') return Math.max(0, (model.inbox?.items ?? []).length - 1);
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
  noColor = false,
  message = null,
} = {}) {
  const panel = TUI_PANELS.includes(initialPanel) ? initialPanel : 'overview';
  return {
    repo,
    runId: runId ?? state?.runId ?? inbox?.runId ?? null,
    state,
    background,
    inbox,
    events: events.slice(-300),
    panel,
    selected: { overview: 0, events: 0, checkpoints: 0, review: 0 },
    decisions: initialDecisionMap(inbox),
    notes: {},
    noteEditing: null,
    noteBuffer: '',
    message,
    noColor: Boolean(noColor),
  };
}

function mergeModel(previous, next) {
  if (!previous) return next;
  const decisions = { ...initialDecisionMap(next.inbox), ...previous.decisions };
  const selected = { ...previous.selected };
  const merged = {
    ...next,
    panel: previous.panel,
    selected,
    decisions,
    notes: { ...previous.notes },
    noteEditing: previous.noteEditing,
    noteBuffer: previous.noteBuffer,
    message: previous.message,
    noColor: previous.noColor,
  };
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
    `${theme.bold('Codex Delivery TUI')} ${theme.dim('|')} ${model.runId ?? 'no-run'} ${theme.dim('|')} phase=${theme.phase(state.phase)} repair=${state.repairIteration ?? 0}/${state.maxRepairs ?? 0}`,
    `${tabs}  ${theme.dim(`background=${backgroundStatus}${alive}`)}`,
    '-'.repeat(80),
  ];
}

function footerLines(model, theme) {
  const note = model.noteEditing
    ? `${theme.yellow('note:')} Enter save, Esc cancel, typing edits note`
    : 'keys: 1-4 panels, j/k arrows move, Enter default, r/e/m/a decision, n note, s save, q quit';
  const decisions = Object.entries(TUI_DECISIONS)
    .map(([decision, meta]) => `${theme.decision(decision, meta.key)} ${meta.description}`)
    .join(' | ');
  const message = model.message ? `${theme.bold('status:')} ${model.message}` : null;
  return [
    '-'.repeat(80),
    note,
    model.panel === 'review' ? decisions : null,
    message,
  ].filter(Boolean);
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
  return [
    theme.bold('Run'),
    `Objective: ${state.objective ?? 'n/a'}`,
    `Base: ${state.baseRef ?? 'n/a'} (${shortSha(state.baseCommit)})`,
    `Integration: ${state.integration?.branch ?? 'n/a'} @ ${shortSha(state.integration?.commit)}`,
    '',
    theme.bold('Control Points'),
    `Workstreams: ${integrated}/${workstreams.length} integrated, ${active} active`,
    `Validation: ${theme.status(validation.failed === 0, `${validation.passed}/${validation.total} passed`)} (${plural(validation.failed, 'failed')})`,
    `Setup: ${setupSummary}`,
    `Reviews: ${theme.status(reviews.failed === 0, `${reviews.approved}/${reviews.total} approved`)} (${plural(reviews.failed, 'not approved')})`,
    `Human reviews: ${humanReviews}`,
    '',
    theme.bold('Current Result'),
    final,
  ];
}

function renderedEventLine(event, model, index) {
  const line = renderProgressLine(event, { verbose: true, repo: model.repo });
  return line || `[event] ${event.type ?? 'unknown'}`;
}

function renderSelectableList(lines, selected, theme) {
  if (!lines.length) return [theme.dim('No records yet.')];
  return lines.map((line, index) => `${index === selected ? theme.cyan('>') : ' '} ${line}`);
}

function renderEvents(model, theme) {
  const events = model.events ?? [];
  const selected = clamp(selectedIndex(model, 'events'), 0, Math.max(0, events.length - 1));
  const recent = events.map((event, index) => renderedEventLine(event, model, index));
  return [
    theme.bold(`Events (${events.length})`),
    ...renderSelectableList(recent, selected, theme),
  ];
}

function renderCheckpoints(model, theme) {
  const events = checkpointEvents(model);
  const selected = clamp(selectedIndex(model, 'checkpoints'), 0, Math.max(0, events.length - 1));
  const lines = events.map((event, index) => renderedEventLine(event, model, index));
  if (!lines.length && model.state?.integration?.commit) {
    lines.push(`[integration] current commit=${shortSha(model.state.integration.commit)}`);
  }
  if (!lines.length) {
    const validation = validationSummary(model.state?.validation?.runs ?? []);
    lines.push(`[validation] ${validation.passed}/${validation.total} passed, ${validation.failed} failed`);
  }
  return [
    theme.bold(`Checkpoints (${lines.length})`),
    ...renderSelectableList(lines, selected, theme),
  ];
}

function decisionLabel(decision, theme) {
  const meta = TUI_DECISIONS[decision];
  if (!meta) return decision ?? 'unset';
  return `${theme.decision(decision, decision)} ${theme.dim(`(${meta.description})`)}`;
}

function reviewItemLine(item, decision, hasNote, index, selected, theme) {
  const parts = [
    item.id,
    item.type,
    item.severity ? `severity=${item.severity}` : null,
    item.role ? `role=${item.role}` : null,
    `action=${decision}`,
    hasNote ? 'note' : null,
  ].filter(Boolean);
  const marker = index === selected ? theme.cyan('>') : ' ';
  return `${marker} ${parts.join(' ')} :: ${item.title}`;
}

function renderReview(model, theme) {
  const inbox = model.inbox ?? {};
  const items = inbox.items ?? [];
  const selected = clamp(selectedIndex(model, 'review'), 0, Math.max(0, items.length - 1));
  const lines = [
    theme.bold(`Review Inbox (${items.length})`),
    `Phase: ${inbox.phase ?? model.state?.phase ?? 'unknown'} | items: ${inbox.counts?.total ?? items.length} total, ${inbox.counts?.validation ?? 0} validation, ${inbox.counts?.criteria ?? 0} criteria, ${inbox.counts?.findings ?? 0} findings`,
  ];
  if (!items.length) {
    lines.push('', theme.dim('No human review items for this run.'));
    return lines;
  }
  lines.push('');
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    lines.push(reviewItemLine(item, model.decisions[item.id] ?? item.defaultDecision, Boolean(model.notes[item.id]), index, selected, theme));
  }
  const item = items[selected];
  lines.push('', theme.bold('Selected'));
  lines.push(`${item.id}: ${item.title}`);
  lines.push(`Suggested: ${decisionLabel(item.defaultDecision, theme)}`);
  lines.push(`Chosen: ${decisionLabel(model.decisions[item.id] ?? item.defaultDecision, theme)}`);
  if (item.summary) lines.push(`Summary: ${item.summary}`);
  if (item.command) lines.push(`Command: ${item.command}`);
  if (item.logPath) lines.push(`Log: ${item.logPath}`);
  if (item.recommendation) lines.push(`Recommendation: ${item.recommendation}`);
  const note = model.noteEditing === item.id ? model.noteBuffer : model.notes[item.id];
  if (model.noteEditing === item.id) lines.push(`${theme.yellow('Editing note:')} ${note}`);
  else if (note) lines.push(`Note: ${note}`);
  return lines;
}

function bodyLines(model, theme) {
  if (model.panel === 'events') return renderEvents(model, theme);
  if (model.panel === 'checkpoints') return renderCheckpoints(model, theme);
  if (model.panel === 'review') return renderReview(model, theme);
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
    return {
      model: {
        ...model,
        notes: { ...model.notes, [item.id]: model.noteBuffer },
        noteEditing: null,
        noteBuffer: '',
        message: `Note saved for ${item.id}.`,
      },
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
  if (/^[1-4]$/.test(key)) {
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
    if (key === 's') return { model: { ...model, message: 'Saving review decisions...' }, action: 'save' };
    if (key === 'n') {
      if (!item) return { model: { ...model, message: 'No review item selected.' }, action: null };
      return { model: { ...model, noteEditing: item.id, noteBuffer: model.notes[item.id] ?? '', message: `Editing note for ${item.id}.` }, action: null };
    }
    if (key === 'enter') {
      if (!item) return { model: { ...model, message: 'No review item selected.' }, action: null };
      const decision = item.defaultDecision ?? 'repair_requested';
      return {
        model: { ...model, decisions: { ...model.decisions, [item.id]: decision }, message: `${item.id}: ${decision}.` },
        action: null,
      };
    }
    const decision = DECISION_BY_KEY.get(key);
    if (decision && item) {
      return {
        model: { ...model, decisions: { ...model.decisions, [item.id]: decision }, message: `${item.id}: ${decision}.` },
        action: null,
      };
    }
  }
  return { model, action: null };
}

export function reviewDecisionCounts(model) {
  return countBy((model.inbox?.items ?? []).map((item) => model.decisions[item.id] ?? item.defaultDecision));
}

function renderFrame(outputStream, model) {
  const width = outputStream.columns || 100;
  const height = outputStream.rows || 30;
  outputStream.write(`\u001b[H\u001b[2J${renderTuiScreen(model, { width, height })}`);
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
  initialPanel = 'overview',
  noColor = false,
  refreshMs = 1000,
  once = false,
} = {}) {
  if (typeof load !== 'function') throw new Error('TUI load callback is required.');
  if (!once) assertInteractiveTty(inputStream, outputStream);

  let model = createTuiModel({ ...await load(), initialPanel, noColor });
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
  let reloadInFlight = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const close = () => {
    if (closed) return;
    closed = true;
    resolveDone();
  };

  const redraw = () => renderFrame(outputStream, model);
  const onKey = async (str, key) => {
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
          model = { ...model, message: saved?.message ?? 'Review decisions saved.' };
        } catch (error) {
          model = { ...model, message: `Save failed: ${error?.message ?? String(error)}` };
        } finally {
          saving = false;
        }
      }
    }
    redraw();
    if (result.action === 'quit') close();
  };

  const refresh = async () => {
    if (closed || reloadInFlight) return;
    reloadInFlight = true;
    try {
      const next = createTuiModel({ ...await load(), initialPanel, noColor });
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
  redraw();
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
