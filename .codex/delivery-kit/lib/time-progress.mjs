const PHASE_ORDER = ['discovery', 'planning', 'implementation', 'integration', 'validation', 'verification', 'review'];
const PHASE_WEIGHTS = {
  discovery: 0.10,
  planning: 0.10,
  implementation: 0.35,
  integration: 0.10,
  validation: 0.15,
  verification: 0.10,
  review: 0.10,
};
const TERMINAL_PHASES = new Set(['accepted', 'blocked', 'failed']);

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function timestampMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function formatDuration(ms) {
  const value = Number(ms ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '0ms';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}h${String(remainder).padStart(2, '0')}m`;
}

export function formatAge(ms) {
  if (ms === null || ms === undefined) return 'n/a';
  return `${formatDuration(ms)} ago`;
}

function phaseIndex(phase) {
  return PHASE_ORDER.indexOf(String(phase ?? ''));
}

function latestTransitionTo(state, phase) {
  return [...(state?.transitions ?? [])].reverse().find((transition) => transition.to === phase) ?? null;
}

function currentPhaseStartAt(state) {
  const transition = latestTransitionTo(state, state?.phase);
  return transition?.at ?? state?.startedAt ?? null;
}

function latestEventAt(events = []) {
  let latest = null;
  for (const event of events) {
    const at = timestampMs(event?.at);
    if (at !== null && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

export function phaseTransitionDurations(state, { nowMs = Date.now() } = {}) {
  const startedAt = timestampMs(state?.startedAt);
  if (startedAt === null) return [];
  const transitions = [...(state?.transitions ?? [])]
    .filter((transition) => timestampMs(transition.at) !== null)
    .sort((left, right) => timestampMs(left.at) - timestampMs(right.at));
  const segments = [];
  let phase = 'new';
  let start = startedAt;
  for (const transition of transitions) {
    const at = timestampMs(transition.at);
    if (at !== null && at >= start) segments.push({ phase, from: start, to: at, durationMs: at - start });
    phase = transition.to ?? phase;
    start = at ?? start;
  }
  const end = timestampMs(state?.finishedAt) ?? nowMs;
  if (end >= start) segments.push({ phase, from: start, to: end, durationMs: end - start, current: !state?.finishedAt });
  return segments;
}

export function computeRunTiming(state, events = [], background = null, { nowMs = Date.now() } = {}) {
  const startedAt = timestampMs(state?.startedAt);
  const finishedAt = timestampMs(state?.finishedAt);
  const phaseStartedAt = timestampMs(currentPhaseStartAt(state));
  const lastEventMs = latestEventAt(events);
  const heartbeatMs = timestampMs(background?.lastHeartbeatAt ?? state?.background?.lastHeartbeatAt);
  const effectiveEnd = finishedAt ?? nowMs;
  return {
    startedAt: state?.startedAt ?? null,
    finishedAt: state?.finishedAt ?? null,
    phaseStartedAt: phaseStartedAt === null ? null : new Date(phaseStartedAt).toISOString(),
    lastEventAt: lastEventMs === null ? null : new Date(lastEventMs).toISOString(),
    elapsedMs: startedAt === null ? null : Math.max(0, effectiveEnd - startedAt),
    phaseElapsedMs: phaseStartedAt === null ? null : Math.max(0, effectiveEnd - phaseStartedAt),
    updatedAgoMs: lastEventMs === null ? null : Math.max(0, nowMs - lastEventMs),
    heartbeatAgoMs: heartbeatMs === null ? null : Math.max(0, nowMs - heartbeatMs),
    phaseDurations: phaseTransitionDurations(state, { nowMs }),
  };
}

function phaseAfter(state, phase) {
  if (state?.phase === 'accepted') return true;
  const target = phaseIndex(phase);
  const current = phaseIndex(state?.phase);
  if (target < 0 || current < 0) return false;
  return current > target;
}

function workflowCheckpointDone(events, name) {
  return events.some((event) => event.type === 'workflow.checkpoint' && event.checkpoint === name);
}

function completedCodexCount(events, predicate) {
  return events.filter((event) => event.type === 'codex.run.completed' && event.ok !== false && predicate(event)).length;
}

function phaseFraction(state, events, phase) {
  if (state?.phase === 'accepted') return 1;
  if (phaseAfter(state, phase)) return 1;
  if (TERMINAL_PHASES.has(state?.phase) && phaseIndex(phase) < phaseIndex('review')) {
    return phase === 'validation' || phase === 'verification'
      ? nonTerminalPhaseFraction(state, events, phase)
      : 1;
  }
  return nonTerminalPhaseFraction(state, events, phase);
}

function nonTerminalPhaseFraction(state, events, phase) {
  switch (phase) {
    case 'discovery':
      if (state?.plan || workflowCheckpointDone(events, 'discovery-complete')) return 1;
      if (state?.phase === 'discovery') return clamp(completedCodexCount(events, (event) => String(event.label ?? '').startsWith('discovery-')) / 3, 0.05, 0.9);
      return 0;
    case 'planning':
      if (state?.plan || (state?.acceptanceCriteria?.length && state?.workstreams?.length)) return 1;
      return state?.phase === 'planning' ? 0.35 : 0;
    case 'implementation': {
      const workstreams = state?.workstreams ?? [];
      if (!workstreams.length) return phaseAfter(state, 'implementation') ? 1 : 0;
      const complete = workstreams.filter((item) => ['integrated', 'completed'].includes(item.status)).length;
      const running = workstreams.filter((item) => item.status === 'running').length;
      return clamp((complete + running * 0.35) / workstreams.length, 0, 1);
    }
    case 'integration': {
      const workstreams = state?.workstreams ?? [];
      if (phaseAfter(state, 'integration')) return 1;
      if (!workstreams.length) return 0;
      const integrated = workstreams.filter((item) => item.status === 'integrated').length;
      return clamp(integrated / workstreams.length, state?.phase === 'integration' ? 0.1 : 0, 1);
    }
    case 'validation': {
      const commands = state?.validation?.commands ?? [];
      const runs = state?.validation?.runs ?? [];
      const total = Math.max(commands.length, runs.length);
      if (phaseAfter(state, 'validation')) return 1;
      if (!total) return state?.phase === 'validation' ? 0.05 : 0;
      return clamp(runs.length / total, 0, 1);
    }
    case 'verification': {
      const criteria = state?.verification?.criteria ?? [];
      if (phaseAfter(state, 'verification')) return 1;
      if (!criteria.length) return state?.phase === 'verification' ? 0.15 : 0;
      const checked = criteria.filter((item) => ['proven', 'failed', 'unknown'].includes(item.status)).length;
      return clamp(checked / criteria.length, 0, 1);
    }
    case 'review': {
      const reviews = state?.reviews ?? [];
      if (state?.phase === 'accepted' || (TERMINAL_PHASES.has(state?.phase) && reviews.length)) return 1;
      if (!reviews.length) return state?.phase === 'review' ? 0.15 : 0;
      const completed = reviews.filter((item) => item.verdict).length;
      return clamp(completed / reviews.length, 0, 1);
    }
    default:
      return 0;
  }
}

export function computeRunProgress(state, events = []) {
  const phases = PHASE_ORDER.map((phase) => ({
    id: phase,
    label: phase,
    fraction: phaseFraction(state, events, phase),
    weight: PHASE_WEIGHTS[phase],
  }));
  const weighted = phases.reduce((sum, phase) => sum + phase.fraction * phase.weight, 0);
  const terminal = TERMINAL_PHASES.has(state?.phase);
  const percent = state?.phase === 'accepted'
    ? 100
    : clamp(Math.round(weighted * 100), 0, terminal ? 99 : 98);
  const current = state?.phase === 'repair'
    ? 'repair planning'
    : TERMINAL_PHASES.has(state?.phase)
      ? state.phase
      : state?.phase ?? 'unknown';
  return {
    percent,
    fraction: percent / 100,
    label: `${percent}% ${current}`,
    phases,
  };
}

function completedDurations(records = []) {
  return records
    .map((item) => Number(item?.durationMs ?? 0))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function estimatePhaseRemainingMs(state) {
  if (state?.phase === 'implementation') {
    const workstreams = state.workstreams ?? [];
    const durations = workstreams
      .map((item) => {
        const start = timestampMs(item.startedAt);
        const end = timestampMs(item.finishedAt);
        return start !== null && end !== null && end >= start ? end - start : null;
      })
      .filter((value) => value !== null && value > 0);
    const avg = average(durations);
    if (!avg) return null;
    const remaining = workstreams.filter((item) => !['integrated', 'completed'].includes(item.status)).length;
    const parallel = Math.max(1, Number(state.config?.maxParallel ?? 1) || 1);
    return {
      remainingMs: Math.max(0, Math.ceil(remaining / parallel) * avg),
      confidence: durations.length >= 2 ? 'medium' : 'low',
      reason: 'based on completed workstream duration in this run',
    };
  }
  if (state?.phase === 'validation') {
    const runs = state.validation?.runs ?? [];
    const avg = average(completedDurations(runs));
    if (!avg) return null;
    const total = Math.max(state.validation?.commands?.length ?? 0, runs.length);
    return {
      remainingMs: Math.max(0, Math.max(0, total - runs.length) * avg),
      confidence: runs.length >= 2 ? 'medium' : 'low',
      reason: 'based on completed validation command duration in this run',
    };
  }
  const setupRuns = state?.validation?.setupRuns ?? [];
  if (state?.phase === 'integration' && setupRuns.length) {
    const avg = average(completedDurations(setupRuns));
    if (avg) {
      return {
        remainingMs: avg,
        confidence: 'low',
        reason: 'based on validation setup duration in this run',
      };
    }
  }
  return null;
}

export function estimateRemaining(state, events = [], progress = computeRunProgress(state, events), timing = computeRunTiming(state, events)) {
  if (state?.phase === 'accepted') return { remainingMs: 0, confidence: 'none', reason: 'run is accepted' };
  if (state?.phase === 'blocked' || state?.phase === 'failed') return { remainingMs: null, confidence: 'none', reason: 'run is waiting for operator intervention' };
  const phaseEstimate = estimatePhaseRemainingMs(state);
  if (phaseEstimate) return phaseEstimate;
  const elapsed = Number(timing.elapsedMs ?? 0);
  const fraction = Number(progress.fraction ?? 0);
  if (!elapsed || fraction < 0.08) return { remainingMs: null, confidence: 'none', reason: 'not enough timed progress yet' };
  return {
    remainingMs: Math.max(0, Math.round(elapsed * ((1 - fraction) / fraction))),
    confidence: fraction >= 0.35 ? 'medium' : 'low',
    reason: 'rough weighted progress estimate',
  };
}

export function computeRunTelemetry(state, events = [], background = null, options = {}) {
  const timing = computeRunTiming(state, events, background, options);
  const progress = computeRunProgress(state, events);
  const eta = estimateRemaining(state, events, progress, timing);
  return { timing, progress, eta };
}

export function elapsedPrefix(event, originAt, { noTime = false } = {}) {
  if (noTime || !event?.at || !originAt) return '';
  const origin = timestampMs(originAt);
  const at = timestampMs(event.at);
  if (origin === null || at === null || at < origin) return '';
  return `[+${formatDuration(at - origin)}] `;
}
