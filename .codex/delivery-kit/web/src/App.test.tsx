import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

const runSummary = {
  runId: 'run-1',
  objective: 'Implement web UI',
  phase: 'blocked',
  progress: { percent: 72, label: 'blocked' },
  timing: { elapsedMs: 62000, phaseElapsedMs: 12000 },
  eta: { remainingMs: null, confidence: 'none', reason: 'waiting for operator' },
  validation: { total: 1, failed: 1, passed: 0 },
  reviews: { total: 1, notApproved: 1, approved: 0 },
  integration: { branch: 'integration/web', commit: 'abcdef1234567890' },
};

const inbox = {
  runId: 'run-1',
  phase: 'blocked',
  recommendedMaxRepairs: 3,
  counts: { total: 1, validation: 1, criteria: 0, findings: 0 },
  items: [
    {
      id: 'VAL-1',
      type: 'validation',
      title: 'Validation failed: npm test',
      summary: 'npm test failed',
      defaultDecision: 'repair_requested',
      command: 'npm test',
      logPath: '.codex/delivery-runs/run-1/commands/validation-01.log',
      paths: [],
    },
  ],
};

const runDetail = {
  repo: '/repo',
  runId: 'run-1',
  state: {
    objective: 'Implement web UI',
    phase: 'blocked',
    repairIteration: 1,
    maxRepairs: 3,
    integration: { branch: 'integration/web', commit: 'abcdef1234567890' },
    validation: { runs: [{ command: 'npm test', ok: false, durationMs: 1000 }] },
    reviews: [{ role: 'reviewer', verdict: 'changes_requested', summary: 'Fix test' }],
    humanReviews: [],
  },
  background: null,
  telemetry: {
    progress: { percent: 72, label: 'blocked' },
    timing: { elapsedMs: 62000, phaseElapsedMs: 12000 },
    eta: { remainingMs: null, confidence: 'none', reason: 'waiting for operator' },
  },
  inbox,
  events: [{ at: '2026-08-12T12:00:00.000Z', type: 'workflow.blocked', summary: 'blocked' }],
  dirtyEntries: [' M src/app.tsx'],
  summary: runSummary,
  paths: { state: '.codex/delivery-runs/run-1/state.json', events: '.codex/delivery-runs/run-1/events.jsonl' },
};

class MockEventSource {
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener() {}
  close() {}
}

function jsonResponse(payload: unknown) {
  return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
}

describe('App', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.pushState(null, '', '/?token=test-token');
    vi.stubGlobal('EventSource', MockEventSource);
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/runs') return jsonResponse({ runs: [runSummary], latestRunId: 'run-1' });
      if (url === '/api/runs/run-1') return jsonResponse(runDetail);
      if (url === '/api/runs/run-1/review' && init?.method === 'POST') {
        return jsonResponse({ artifactPath: '.codex/delivery-runs/run-1/artifacts/human-reviews/HR-web.json' });
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the cockpit for the latest run', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Implement web UI' })).toBeInTheDocument();
    expect(screen.getAllByText('72%').length).toBeGreaterThan(0);
    expect(screen.getByText('Review decisions are waiting.')).toBeInTheDocument();
  });

  it('saves review decisions through the API', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('heading', { name: 'Implement web UI' });
    await user.click(screen.getByRole('tab', { name: 'Review' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/runs/run-1/review', expect.objectContaining({ method: 'POST' }));
    });
  });

  it('shows an actionable empty state when no runs exist', async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/runs') return jsonResponse({ runs: [], latestRunId: null });
      return Promise.resolve(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'No delivery runs yet' })).toBeInTheDocument();
    expect(screen.getByText('./scripts/codex-delivery run "Describe the project change" --background')).toBeInTheDocument();
  });
});
