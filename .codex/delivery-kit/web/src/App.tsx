import * as Dialog from '@radix-ui/react-dialog';
import * as Progress from '@radix-ui/react-progress';
import * as Switch from '@radix-ui/react-switch';
import * as Tabs from '@radix-ui/react-tabs';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  Clock3,
  GitBranch,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

type Phase = 'new' | 'discovery' | 'planning' | 'implementation' | 'integration' | 'verification' | 'review' | 'repair' | 'accepted' | 'blocked' | 'failed' | string;
type Decision = 'repair_requested' | 'environment_required' | 'manual_required' | 'acknowledged';

interface Telemetry {
  progress?: { percent?: number; label?: string };
  timing?: { elapsedMs?: number | null; phaseElapsedMs?: number | null; updatedAgoMs?: number | null };
  eta?: { remainingMs?: number | null; confidence?: string; reason?: string };
}

interface Background {
  pid?: number | null;
  mode?: string;
  status?: string;
  effectiveStatus?: string;
  alive?: boolean;
  backgroundLogPath?: string | null;
  lastHeartbeatAt?: string | null;
}

interface RunSummary {
  runId: string;
  objective?: string;
  phase: Phase;
  startedAt?: string;
  finishedAt?: string | null;
  repairIteration?: number;
  maxRepairs?: number;
  progress?: Telemetry['progress'];
  timing?: Telemetry['timing'];
  eta?: Telemetry['eta'];
  background?: Background | null;
  validation?: { total: number; failed: number; passed: number };
  reviews?: { total: number; notApproved: number; approved: number };
  integration?: { branch?: string | null; commit?: string | null; worktreePath?: string | null };
}

interface ReviewItem {
  id: string;
  type: string;
  title: string;
  summary?: string;
  defaultDecision: Decision;
  severity?: string;
  command?: string;
  logPath?: string;
  recommendation?: string;
  paths?: string[];
  criterionIds?: string[];
}

interface ReviewInbox {
  runId: string;
  phase: Phase;
  counts: { total: number; validation: number; criteria: number; findings: number };
  recommendedMaxRepairs: number;
  items: ReviewItem[];
}

interface RunDetail {
  repo: string;
  runId: string;
  state: {
    objective?: string;
    phase: Phase;
    startedAt?: string;
    finishedAt?: string | null;
    repairIteration?: number;
    maxRepairs?: number;
    validation?: { runs?: Array<{ command: string; ok: boolean; exitCode?: number; durationMs?: number; logPath?: string }> };
    reviews?: Array<{ role?: string; verdict?: string; summary?: string; findings?: unknown[] }>;
    humanReviews?: Array<{ id: string; at?: string; counts?: { byDecision?: Record<string, number> } }>;
    integration?: { branch?: string; commit?: string; worktreePath?: string };
  };
  background?: Background | null;
  telemetry: Telemetry;
  inbox?: ReviewInbox | null;
  events: Array<Record<string, unknown>>;
  dirtyEntries: string[];
  summary: RunSummary;
  paths: Record<string, string | null>;
}

const decisionOptions: Array<{ value: Decision; label: string }> = [
  { value: 'repair_requested', label: 'Repair' },
  { value: 'environment_required', label: 'Environment' },
  { value: 'manual_required', label: 'Manual' },
  { value: 'acknowledged', label: 'Acknowledge' },
];

function initialToken() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  if (token) {
    sessionStorage.setItem('codexDeliveryToken', token);
    url.searchParams.delete('token');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    return token;
  }
  return sessionStorage.getItem('codexDeliveryToken') ?? '';
}

async function apiRequest<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

function formatDuration(ms?: number | null) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function shortSha(value?: string | null) {
  return value ? value.slice(0, 12) : 'n/a';
}

function phaseTone(phase?: Phase) {
  if (phase === 'accepted') return 'ok';
  if (phase === 'blocked' || phase === 'failed') return 'bad';
  if (phase === 'review' || phase === 'repair') return 'warn';
  return 'info';
}

function StatusPill({ children, tone = 'info' }: { children: React.ReactNode; tone?: 'ok' | 'bad' | 'warn' | 'info' | 'muted' }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

function IconButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button className="icon-button" aria-label={label} {...props}>
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={6}>{label}</Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function ConfirmAction({
  icon,
  label,
  title,
  body,
  disabled,
  danger = false,
  onConfirm,
}: {
  icon: React.ReactNode;
  label: string;
  title: string;
  body: string;
  disabled?: boolean;
  danger?: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className={danger ? 'button danger' : 'button'} disabled={disabled}>
          {icon}
          {label}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{body}</Dialog.Description>
          <div className="dialog-actions">
            <Dialog.Close asChild><button className="button quiet">Cancel</button></Dialog.Close>
            <button
              className={danger ? 'button danger' : 'button primary'}
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Confirm
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function useRunStream(runId: string | null, token: string) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!runId || !token) return undefined;
    const stream = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream?tail=120&token=${encodeURIComponent(token)}`);
    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: ['run', runId] });
      void queryClient.invalidateQueries({ queryKey: ['runs'] });
    };
    stream.addEventListener('snapshot', invalidate);
    stream.addEventListener('error', invalidate);
    return () => stream.close();
  }, [queryClient, runId, token]);
}

function RunList({ runs, selectedRunId, onSelect }: { runs: RunSummary[]; selectedRunId: string | null; onSelect: (runId: string) => void }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-title">
        <GitBranch size={17} />
        Runs
      </div>
      <div className="run-list">
        {runs.map((run) => (
          <button key={run.runId} className={run.runId === selectedRunId ? 'run-item selected' : 'run-item'} onClick={() => onSelect(run.runId)}>
            <span className="run-row">
              <strong>{run.runId}</strong>
              <StatusPill tone={phaseTone(run.phase)}>{run.phase}</StatusPill>
            </span>
            <span className="run-objective">{run.objective ?? 'No objective'}</span>
            <span className="run-row muted">
              <span>{run.progress?.percent ?? 0}%</span>
              <span>{formatDuration(run.timing?.elapsedMs)}</span>
            </span>
          </button>
        ))}
        {!runs.length && <div className="empty">No valid delivery runs found.</div>}
      </div>
    </aside>
  );
}

function EmptyRuns({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="empty-page">
      <div className="empty-card">
        <TerminalSquare size={22} />
        <h1>No delivery runs yet</h1>
        <p>This Web UI manages existing Codex Delivery runs for the current repository.</p>
        <div className="command-box">
          <code>./scripts/codex-delivery run "Describe the project change" --background</code>
          <code>./scripts/codex-delivery web</code>
        </div>
        <button className="button primary" onClick={onRefresh}>
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>
    </div>
  );
}

function RunLoadError({ message, onRefresh }: { message: string; onRefresh: () => void }) {
  return (
    <div className="empty-page">
      <div className="empty-card">
        <AlertTriangle size={22} />
        <h1>Run could not be loaded</h1>
        <p>{message}</p>
        <button className="button primary" onClick={onRefresh}>
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>
    </div>
  );
}

function TopStrip({ run, onRefresh }: { run: RunDetail; onRefresh: () => void }) {
  const percent = run.telemetry.progress?.percent ?? 0;
  return (
    <header className="top-strip">
      <div className="top-main">
        <div className="title-row">
          <h1>{run.state.objective ?? run.runId}</h1>
          <StatusPill tone={phaseTone(run.state.phase)}>{run.state.phase}</StatusPill>
        </div>
        <div className="meta-row">
          <span>run {run.runId}</span>
          <span>repair {run.state.repairIteration ?? 0}/{run.state.maxRepairs ?? 0}</span>
          <span>commit {shortSha(run.state.integration?.commit)}</span>
          <span>elapsed {formatDuration(run.telemetry.timing?.elapsedMs)}</span>
          <span>{run.telemetry.eta?.remainingMs ? `ETA ${formatDuration(run.telemetry.eta.remainingMs)}` : `ETA ${run.telemetry.eta?.reason ?? 'unknown'}`}</span>
        </div>
      </div>
      <div className="progress-cluster">
        <Progress.Root className="progress" value={percent}>
          <Progress.Indicator className="progress-fill" style={{ transform: `translateX(-${100 - percent}%)` }} />
        </Progress.Root>
        <span>{percent}%</span>
        <IconButton label="Refresh" onClick={onRefresh}><RefreshCw size={17} /></IconButton>
      </div>
    </header>
  );
}

function Cockpit({ run }: { run: RunDetail }) {
  const inboxCount = run.inbox?.items.length ?? 0;
  const validationFailed = run.summary.validation?.failed ?? 0;
  const reviewFailed = run.summary.reviews?.notApproved ?? 0;
  return (
    <section className="panel cockpit-grid">
      <div className="metric-band">
        <div><Activity size={18} /><strong>{run.telemetry.progress?.label ?? run.state.phase}</strong><span>Progress state</span></div>
        <div><Clock3 size={18} /><strong>{formatDuration(run.telemetry.timing?.phaseElapsedMs)}</strong><span>Phase time</span></div>
        <div><AlertTriangle size={18} /><strong>{inboxCount}</strong><span>Review items</span></div>
        <div><TerminalSquare size={18} /><strong>{run.background?.effectiveStatus ?? 'none'}</strong><span>Background</span></div>
      </div>
      <div className="section">
        <h2>Intervention Queue</h2>
        {inboxCount > 0 && <p className="action-line warn"><AlertTriangle size={16} /> Review decisions are waiting.</p>}
        {validationFailed > 0 && <p className="action-line bad"><CircleStop size={16} /> {validationFailed} validation command failed.</p>}
        {reviewFailed > 0 && <p className="action-line warn"><ShieldCheck size={16} /> {reviewFailed} review track needs attention.</p>}
        {!inboxCount && !validationFailed && !reviewFailed && <p className="action-line ok"><CheckCircle2 size={16} /> No operator action is required.</p>}
      </div>
      <div className="section">
        <h2>Active Work</h2>
        <dl className="facts">
          <dt>Background</dt><dd>{run.background?.effectiveStatus ?? 'none'}{run.background?.pid ? ` pid=${run.background.pid}` : ''}</dd>
          <dt>Heartbeat</dt><dd>{run.background?.lastHeartbeatAt ?? 'n/a'}</dd>
          <dt>Integration</dt><dd>{run.state.integration?.branch ?? 'n/a'}</dd>
        </dl>
      </div>
    </section>
  );
}

function Timeline({ run }: { run: RunDetail }) {
  const [mode, setMode] = useState<'normal' | 'detail' | 'raw'>('normal');
  const events = mode === 'normal'
    ? run.events.filter((event) => /workflow|validation|review|quality|background/.test(String(event.type ?? '')))
    : run.events;
  return (
    <section className="panel">
      <div className="panel-toolbar">
        <h2>Timeline</h2>
        <div className="segmented">
          {(['normal', 'detail', 'raw'] as const).map((item) => (
            <button key={item} className={mode === item ? 'selected' : ''} onClick={() => setMode(item)}>{item}</button>
          ))}
        </div>
      </div>
      <div className="event-list">
        {events.map((event, index) => (
          <pre key={index} className="event-line">{mode === 'raw' ? JSON.stringify(event) : `${event.at ?? ''}  ${event.type ?? 'event'}  ${event.summary ?? event.command ?? event.phase ?? ''}`}</pre>
        ))}
        {!events.length && <div className="empty">No events in this view.</div>}
      </div>
    </section>
  );
}

function Review({ run, token }: { run: RunDetail; token: string }) {
  const queryClient = useQueryClient();
  const inbox = run.inbox;
  const [selected, setSelected] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, { decision: Decision; note: string }>>({});

  useEffect(() => {
    const next: Record<string, { decision: Decision; note: string }> = {};
    for (const item of inbox?.items ?? []) next[item.id] = { decision: item.defaultDecision, note: '' };
    setDecisions(next);
    setSelected(0);
  }, [inbox?.runId, inbox?.items.length]);

  const saveMutation = useMutation({
    mutationFn: () => apiRequest(`/api/runs/${encodeURIComponent(run.runId)}/review`, token, {
      method: 'POST',
      body: JSON.stringify({
        decisions: Object.entries(decisions).map(([itemId, value]) => ({ itemId, ...value })),
      }),
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['run', run.runId] });
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
  });

  const item = inbox?.items[selected] ?? null;
  if (!inbox?.items.length) {
    return <section className="panel"><h2>Review</h2><div className="empty">No review items.</div></section>;
  }
  return (
    <section className="panel review-layout">
      <div className="review-list">
        <div className="panel-toolbar">
          <h2>Review</h2>
          <ConfirmAction
            icon={<Save size={16} />}
            label={saveMutation.isPending ? 'Saving' : 'Save'}
            title="Save review decisions"
            body="This writes durable human-review artifacts for the selected run."
            disabled={saveMutation.isPending}
            onConfirm={() => saveMutation.mutate()}
          />
        </div>
        {saveMutation.error && <p className="error-line">{saveMutation.error.message}</p>}
        {inbox.items.map((reviewItem, index) => (
          <button key={reviewItem.id} className={index === selected ? 'review-item selected' : 'review-item'} onClick={() => setSelected(index)}>
            <span>{reviewItem.title}</span>
            <StatusPill tone={reviewItem.severity === 'high' || reviewItem.severity === 'critical' ? 'bad' : 'warn'}>{reviewItem.type}</StatusPill>
          </button>
        ))}
      </div>
      {item && (
        <div className="review-detail">
          <h3>{item.title}</h3>
          <p>{item.summary}</p>
          <div className="decision-row">
            {decisionOptions.map((option) => (
              <button
                key={option.value}
                className={decisions[item.id]?.decision === option.value ? 'decision selected' : 'decision'}
                onClick={() => setDecisions((current) => ({ ...current, [item.id]: { ...(current[item.id] ?? { note: '' }), decision: option.value } }))}
              >
                {option.label}
              </button>
            ))}
          </div>
          <textarea
            value={decisions[item.id]?.note ?? ''}
            onChange={(event) => setDecisions((current) => ({ ...current, [item.id]: { ...(current[item.id] ?? { decision: item.defaultDecision }), note: event.target.value } }))}
            placeholder="Operator note"
          />
          <dl className="facts">
            <dt>Command</dt><dd>{item.command ?? 'n/a'}</dd>
            <dt>Log</dt><dd>{item.logPath ?? 'n/a'}</dd>
            <dt>Paths</dt><dd>{item.paths?.join(', ') || 'n/a'}</dd>
          </dl>
        </div>
      )}
    </section>
  );
}

function Workspace({ run, token }: { run: RunDetail; token: string }) {
  const queryClient = useQueryClient();
  const [allowDirty, setAllowDirty] = useState(false);
  const resumeMutation = useMutation({
    mutationFn: () => apiRequest(`/api/runs/${encodeURIComponent(run.runId)}/resume`, token, {
      method: 'POST',
      body: JSON.stringify({ allowDirty }),
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['run', run.runId] });
      await queryClient.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  const stopMutation = useMutation({
    mutationFn: () => apiRequest(`/api/runs/${encodeURIComponent(run.runId)}/stop`, token, { method: 'POST', body: '{}' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['run', run.runId] }),
  });
  const cleanupMutation = useMutation({
    mutationFn: () => apiRequest(`/api/runs/${encodeURIComponent(run.runId)}/cleanup`, token, { method: 'POST', body: JSON.stringify({ integration: true }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['runs'] }),
  });
  return (
    <section className="panel workspace-grid">
      <div className="section">
        <h2>Workspace</h2>
        <label className="switch-row">
          <Switch.Root className="switch" checked={allowDirty} onCheckedChange={setAllowDirty}>
            <Switch.Thumb className="switch-thumb" />
          </Switch.Root>
          allow dirty resume
        </label>
        <div className="dirty-list">
          {run.dirtyEntries.map((entry) => <code key={entry}>{entry}</code>)}
          {!run.dirtyEntries.length && <span className="empty">Working tree clean.</span>}
        </div>
      </div>
      <div className="section">
        <h2>Operations</h2>
        <div className="operation-row">
          <ConfirmAction icon={<Play size={16} />} label="Resume" title="Start background resume" body="This starts a detached resume process for the selected run." onConfirm={() => resumeMutation.mutate()} />
          <ConfirmAction icon={<CircleStop size={16} />} label="Stop" title="Stop background process" body="This sends SIGTERM to the recorded background process." danger onConfirm={() => stopMutation.mutate()} />
          <ConfirmAction icon={<Trash2 size={16} />} label="Cleanup" title="Cleanup integration worktree" body="This removes run worktrees and the integration worktree. Run logs are preserved." danger onConfirm={() => cleanupMutation.mutate()} />
        </div>
        {[resumeMutation, stopMutation, cleanupMutation].map((mutation, index) => mutation.error ? <p className="error-line" key={index}>{mutation.error.message}</p> : null)}
      </div>
    </section>
  );
}

function Diagnostics({ run }: { run: RunDetail }) {
  return (
    <section className="panel diagnostics-grid">
      <div className="section">
        <h2>Validation</h2>
        {(run.state.validation?.runs ?? []).map((item) => (
          <div key={item.command} className="diagnostic-row">
            <StatusPill tone={item.ok ? 'ok' : 'bad'}>{item.ok ? 'passed' : 'failed'}</StatusPill>
            <span>{item.command}</span>
            <span>{formatDuration(item.durationMs)}</span>
          </div>
        ))}
      </div>
      <div className="section">
        <h2>Reviews</h2>
        {(run.state.reviews ?? []).map((item, index) => (
          <div key={`${item.role}-${index}`} className="diagnostic-row">
            <StatusPill tone={item.verdict === 'approved' ? 'ok' : 'warn'}>{item.verdict ?? 'unknown'}</StatusPill>
            <span>{item.role ?? 'review'}</span>
            <span>{item.summary ?? ''}</span>
          </div>
        ))}
      </div>
      <div className="section">
        <h2>Artifacts</h2>
        <dl className="facts">
          {Object.entries(run.paths).map(([key, value]) => <><dt key={`${key}-k`}>{key}</dt><dd key={`${key}-v`}>{value ?? 'n/a'}</dd></>)}
        </dl>
      </div>
    </section>
  );
}

function Dashboard({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const runsQuery = useQuery({ queryKey: ['runs'], queryFn: () => apiRequest<{ runs: RunSummary[]; latestRunId: string | null }>('/api/runs', token) });
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const selected = selectedRunId ?? runsQuery.data?.latestRunId ?? runsQuery.data?.runs[0]?.runId ?? null;
  const runQuery = useQuery({
    queryKey: ['run', selected],
    enabled: Boolean(selected),
    queryFn: () => apiRequest<RunDetail>(`/api/runs/${encodeURIComponent(selected!)}`, token),
  });
  useRunStream(selected, token);
  useEffect(() => {
    if (!selectedRunId && selected) setSelectedRunId(selected);
  }, [selected, selectedRunId]);

  if (runsQuery.isLoading) return <div className="loading">Loading runs...</div>;
  if (runsQuery.error) return <div className="auth-empty">{runsQuery.error.message}</div>;
  const runs = runsQuery.data?.runs ?? [];

  return (
    <Tooltip.Provider delayDuration={250}>
      <div className="app-shell">
        <RunList runs={runs} selectedRunId={selected} onSelect={setSelectedRunId} />
        <main className="main">
          {!runs.length ? (
            <EmptyRuns onRefresh={() => void queryClient.invalidateQueries({ queryKey: ['runs'] })} />
          ) : runQuery.error ? (
            <RunLoadError message={runQuery.error.message} onRefresh={() => void queryClient.invalidateQueries({ queryKey: ['run', selected] })} />
          ) : runQuery.data ? (
            <>
              <TopStrip run={runQuery.data} onRefresh={() => void queryClient.invalidateQueries({ queryKey: ['run', selected] })} />
              <Tabs.Root defaultValue="cockpit" className="tabs">
                <Tabs.List className="tab-list">
                  <Tabs.Trigger value="cockpit">Cockpit</Tabs.Trigger>
                  <Tabs.Trigger value="timeline">Timeline</Tabs.Trigger>
                  <Tabs.Trigger value="review">Review</Tabs.Trigger>
                  <Tabs.Trigger value="workspace">Workspace</Tabs.Trigger>
                  <Tabs.Trigger value="diagnostics">Diagnostics</Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content value="cockpit"><Cockpit run={runQuery.data} /></Tabs.Content>
                <Tabs.Content value="timeline"><Timeline run={runQuery.data} /></Tabs.Content>
                <Tabs.Content value="review"><Review run={runQuery.data} token={token} /></Tabs.Content>
                <Tabs.Content value="workspace"><Workspace run={runQuery.data} token={token} /></Tabs.Content>
                <Tabs.Content value="diagnostics"><Diagnostics run={runQuery.data} /></Tabs.Content>
              </Tabs.Root>
            </>
          ) : (
            <div className="empty-page">Loading selected run...</div>
          )}
        </main>
      </div>
    </Tooltip.Provider>
  );
}

export function App() {
  const [token] = useState(initialToken);
  const client = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }), []);
  if (!token) {
    return <div className="auth-empty">Missing session token.</div>;
  }
  return (
    <QueryClientProvider client={client}>
      <Dashboard token={token} />
    </QueryClientProvider>
  );
}
