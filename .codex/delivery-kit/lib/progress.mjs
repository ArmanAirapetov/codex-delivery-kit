import path from 'node:path';

const TERMINAL_EVENT_TYPES = new Set(['workflow.accepted', 'workflow.blocked', 'workflow.failed']);

function shortSha(value) {
  return value ? String(value).slice(0, 12) : 'n/a';
}

function duration(value) {
  const ms = Number(value ?? 0);
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

function list(values, max = 5) {
  const items = [...new Set((values ?? []).filter(Boolean).map(String))];
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} +${items.length - max}`;
}

function rel(repo, value) {
  if (!repo || !value) return value ? String(value) : '';
  const text = String(value);
  if (!path.isAbsolute(text)) return text;
  const relative = path.relative(repo, text).split(path.sep).join('/');
  return relative && !relative.startsWith('../') ? relative : text;
}

function usageSummary(usage) {
  if (!usage) return '';
  const input = Number(usage.input_tokens ?? 0);
  const cached = Number(usage.cached_input_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0);
  const reasoning = Number(usage.reasoning_output_tokens ?? 0);
  if (!input && !cached && !output && !reasoning) return '';
  return ` tokens=in:${input} cached:${cached} out:${output} reasoning:${reasoning}`;
}

function details(parts) {
  return parts.filter(Boolean).join(' ');
}

export function isTerminalProgressEvent(event) {
  return TERMINAL_EVENT_TYPES.has(event?.type);
}

export function renderProgressLine(event, { verbose = false, repo = null } = {}) {
  if (!event?.type) return null;
  switch (event.type) {
    case 'workflow.started':
      return details([
        `[run] ${event.runId} started`,
        event.baseRef ? `base=${event.baseRef}@${shortSha(event.baseCommit)}` : '',
      ]);
    case 'workflow.resume.started':
      return `[resume] ${event.runId} ${event.fromPhase} -> ${event.toPhase}`;
    case 'workflow.checkpoint':
      return `[checkpoint] ${event.checkpoint}${event.tracks ? ` tracks=${event.tracks}` : ''}`;
    case 'workflow.plan.approved':
      return `[plan] approved workstreams=${event.workstreams} criteria=${event.criteria}`;
    case 'workflow.error':
      return `[error] ${event.error ?? 'workflow error'}`;
    case 'workflow.accepted':
    case 'workflow.blocked':
    case 'workflow.failed':
      return details([
        `[final] ${event.type.replace('workflow.', '')}`,
        event.integrationCommit ? `commit=${shortSha(event.integrationCommit)}` : '',
        event.summary ? `summary=${event.summary}` : '',
      ]);
    case 'environment.codex':
      return verbose ? `[env] codex ${event.version ?? 'unknown'}` : null;
    case 'codex.run.started':
      return details([
        `[agent] ${event.label} started`,
        `role=${event.role}`,
        event.workstreamId ? `workstream=${event.workstreamId}` : '',
        verbose ? `cwd=${rel(repo, event.cwd)}` : '',
      ]);
    case 'codex.run.completed':
      return details([
        `[agent] ${event.label} ${event.ok ? 'ok' : 'failed'}`,
        `role=${event.role}`,
        event.workstreamId ? `workstream=${event.workstreamId}` : '',
        `duration=${duration(event.durationMs)}`,
        verbose ? usageSummary(event.usage) : '',
      ]);
    case 'codex.result.invalid':
      return `[agent] ${event.label} invalid-result ${event.error ?? ''}`.trim();
    case 'workstream.wave.started':
      return `[wave] started ids=${list(event.ids)} base=${shortSha(event.baseCommit)}`;
    case 'workstream.wave.completed':
      return `[wave] completed ids=${list(event.ids)} integration=${shortSha(event.integrationCommit)}`;
    case 'workstream.wave.failed':
      return `[wave] failed ids=${list(event.ids)} completed=${list(event.completed)} failures=${list(event.failures, 2)}`;
    case 'workstream.completed-integrated':
      return verbose ? `[integration] completed-ready ids=${list(event.ids)} commit=${shortSha(event.integrationCommit)}` : null;
    case 'workstream.started':
      return details([
        `[workstream] ${event.workstreamId} started`,
        `attempt=${event.attempt ?? 1}`,
        `role=${event.role}`,
        verbose ? `branch=${event.branch}` : '',
      ]);
    case 'workstream.completed':
      return details([
        `[workstream] ${event.workstreamId} completed`,
        `commit=${shortSha(event.commit)}`,
        `paths=${(event.paths ?? []).length}`,
        `checks=${event.checks ?? 0}`,
      ]);
    case 'workstream.failed':
      return `[workstream] ${event.workstreamId} failed ${event.error ?? ''}`.trim();
    case 'workstream.snapshot.saved':
      return verbose ? `[snapshot] ${event.workstreamId} ${event.reason} ${event.path} archive=${event.archiveOk ? 'ok' : 'failed'}` : null;
    case 'workstream.resume.reset':
      return details([
        `[resume] reset ${event.workstreamId}`,
        `from=${event.fromStatus}`,
        verbose && event.snapshot ? `snapshot=${event.snapshot}` : '',
      ]);
    case 'integration.created':
      return details([
        '[integration] worktree created',
        verbose ? `branch=${event.branch}` : '',
        verbose ? `path=${rel(repo, event.worktreePath)}` : '',
      ]);
    case 'integration.started':
      return `[integration] ${event.workstreamId} started commit=${shortSha(event.commit)}`;
    case 'integration.conflict':
      return `[integration] ${event.workstreamId} conflict paths=${list(event.conflicts)}`;
    case 'integration.completed':
      return details([
        `[integration] ${event.workstreamId} completed`,
        `commit=${shortSha(event.integrationCommit)}`,
        event.conflictResolved ? 'conflict=resolved' : '',
      ]);
    case 'validation.started':
      return `[validation] ${event.index}/${event.total} started ${event.command}`;
    case 'validation.completed':
      return details([
        `[validation] ${event.ok ? 'passed' : 'failed'}`,
        `exit=${event.exitCode}`,
        `duration=${duration(event.durationMs)}`,
        verbose && event.logPath ? `log=${event.logPath}` : '',
        event.command,
      ]);
    case 'validation.rejected':
      return `[validation] rejected ${event.command} reason=${event.reason}`;
    case 'inspection.started':
      return `[inspection] ${event.role} started phase=${event.inspectionPhase ?? event.phase}`;
    case 'inspection.completed':
      return details([
        `[inspection] ${event.role} ${event.ok ? 'ok' : 'failed'}`,
        `duration=${duration(event.durationMs)}`,
      ]);
    case 'inspection.mutations.discarded':
      return `[inspection] ${event.role} discarded mutations paths=${list(event.paths)}`;
    case 'repair.plan.approved':
      return `[repair] iteration=${event.iteration} workstreams=${list(event.workstreams)}`;
    case 'quality.gate':
      return `[gate] ${event.passed ? 'passed' : 'failed'} commands=${event.failedCommands} criteria=${event.failedCriteria} findings=${event.blockingFindings}`;
    case 'background.started':
      return `[background] started pid=${event.pid} log=${event.backgroundLogPath ?? event.logPath ?? ''}`.trim();
    case 'background.heartbeat':
      return verbose ? `[background] heartbeat pid=${event.pid}` : null;
    case 'background.stop.requested':
      return `[background] stop requested pid=${event.pid}`;
    case 'background.exited':
      return `[background] exited pid=${event.pid} exit=${event.exitCode ?? 'n/a'} signal=${event.signal ?? 'n/a'}`;
    case 'turn.completed':
      return verbose ? `[codex] ${event.label ?? event.role ?? 'turn'} completed${usageSummary(event.usage)}` : null;
    case 'turn.failed':
    case 'error':
      return `[codex] ${event.label ?? event.role ?? 'turn'} failed ${event.error ?? ''}`.trim();
    default:
      return verbose && event.type.startsWith('codex.')
        ? `[event] ${event.type} ${event.label ?? ''}`.trim()
        : null;
  }
}

export function createProgressLogger({ enabled = true, verbose = false, repo = null, stream = process.stderr } = {}) {
  return {
    event(event) {
      if (!enabled) return;
      const line = renderProgressLine(event, { verbose, repo });
      if (line) stream.write(`${line}\n`);
    },
  };
}
