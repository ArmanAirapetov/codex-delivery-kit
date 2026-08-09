import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const TERMINAL_PHASES = new Set(['accepted', 'blocked', 'failed']);

const LEGAL_TRANSITIONS = new Map([
  ['new', new Set(['discovery', 'blocked', 'failed'])],
  ['discovery', new Set(['planning', 'blocked', 'failed'])],
  ['planning', new Set(['implementation', 'blocked', 'failed'])],
  ['implementation', new Set(['integration', 'blocked', 'failed'])],
  ['integration', new Set(['verification', 'repair', 'blocked', 'failed'])],
  ['verification', new Set(['review', 'repair', 'blocked', 'failed'])],
  ['review', new Set(['accepted', 'repair', 'blocked', 'failed'])],
  ['repair', new Set(['integration', 'verification', 'blocked', 'failed'])],
]);

export function now() {
  return new Date().toISOString();
}

export function slugify(value, max = 48) {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return (slug || 'run').slice(0, max).replace(/-+$/g, '');
}

export function newRunId(objective = 'delivery') {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${stamp}-${slugify(objective, 28)}-${randomUUID().slice(0, 8)}`;
}

export async function ensureDir(directory) {
  await mkdir(directory, { recursive: true });
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' && fallback !== null) return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

export async function appendJsonl(file, value) {
  await ensureDir(path.dirname(file));
  await appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

const SECRET_PATTERNS = [
  /(sk-[a-zA-Z0-9_-]{12,})/g,
  /(Bearer\s+)[a-zA-Z0-9._~+/=-]{8,}/gi,
  /((?:api[_-]?key|token|password|passwd|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi,
  /([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)\s*=\s*)[^\s]+/g,
  /(-----BEGIN [A-Z ]+PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]+PRIVATE KEY-----)/g,
];

export function redactText(value, maxLength = 2000) {
  let result = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (...args) => {
      const first = args[0];
      if (/^Bearer\s/i.test(first)) return 'Bearer [REDACTED]';
      if (/-----BEGIN/.test(first)) return '[REDACTED_PRIVATE_KEY]';
      const prefix = args[1] ?? '';
      return `${prefix}[REDACTED]`;
    });
  }
  if (result.length > maxLength) result = `${result.slice(0, maxLength)}…[TRUNCATED]`;
  return result;
}

export function sanitizeEvent(event) {
  const base = {
    at: now(),
    type: String(event?.type ?? 'unknown'),
  };
  if (event?.thread_id) base.threadId = String(event.thread_id);
  if (event?.turn_id) base.turnId = String(event.turn_id);
  if (event?.usage) base.usage = event.usage;
  if (event?.error) base.error = redactText(event.error?.message ?? JSON.stringify(event.error), 800);
  if (event?.item && typeof event.item === 'object') {
    const item = event.item;
    base.item = {
      id: item.id ? String(item.id) : undefined,
      type: item.type ? String(item.type) : undefined,
      status: item.status ? String(item.status) : undefined,
    };
    if (item.command) {
      base.item.commandHash = sha256(item.command);
      base.item.commandPreview = redactText(item.command, 300);
    }
    if (item.cwd) base.item.cwd = String(item.cwd);
    if (Array.isArray(item.changes)) {
      base.item.paths = item.changes
        .map((entry) => entry?.path ?? entry?.file ?? entry?.file_path)
        .filter(Boolean)
        .map(String);
    }
    if (item.type === 'agent_message' && item.text) {
      base.item.messageHash = sha256(item.text);
      base.item.messageLength = String(item.text).length;
    }
  }
  return base;
}

export function normalizeRelative(candidate, root) {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (!relative || relative === '.') return '.';
  if (relative === '..' || relative.startsWith('../')) {
    throw new Error(`Path escapes repository: ${candidate}`);
  }
  return relative.replace(/^\.\//, '');
}

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

export function globToRegExp(glob) {
  let source = '';
  const normalized = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 1;
        if (normalized[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

export function scopeMatches(candidate, scopes) {
  const normalized = String(candidate).replace(/\\/g, '/').replace(/^\.\//, '');
  return scopes.some((scope) => {
    const rule = String(scope).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (rule === '**' || rule === '**/*' || rule === '.') return true;
    if (!rule.includes('*') && !rule.includes('?')) {
      return normalized === rule || normalized.startsWith(`${rule}/`);
    }
    return globToRegExp(rule).test(normalized);
  });
}

export function scopesMayOverlap(leftScopes, rightScopes) {
  const sample = (scope) => String(scope)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\*\*.*$/, '')
    .replace(/\*.*$/, '')
    .replace(/\?.*$/, '')
    .replace(/\/$/, '');
  for (const left of leftScopes) {
    for (const right of rightScopes) {
      const a = sample(left);
      const b = sample(right);
      if (!a || !b || a === '.' || b === '.') return true;
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true;
    }
  }
  return false;
}

export function validateWorkstreams(workstreams, criterionIds = new Set()) {
  if (!Array.isArray(workstreams) || workstreams.length === 0) {
    throw new Error('At least one workstream is required.');
  }
  const ids = new Set();
  for (const item of workstreams) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{1,63}$/.test(item.id)) throw new Error(`Invalid workstream ID: ${item.id}`);
    if (ids.has(item.id)) throw new Error(`Duplicate workstream ID: ${item.id}`);
    ids.add(item.id);
    if (!item.title?.trim()) throw new Error(`Workstream '${item.id}' has no title.`);
    if (!item.role?.trim()) throw new Error(`Workstream '${item.id}' has no role.`);
    if (!Array.isArray(item.scope) || item.scope.length === 0) throw new Error(`Workstream '${item.id}' has no scope.`);
    for (const criterionId of item.criterionIds ?? []) {
      if (criterionIds.size && !criterionIds.has(criterionId)) {
        throw new Error(`Workstream '${item.id}' references unknown criterion '${criterionId}'.`);
      }
    }
  }
  for (const item of workstreams) {
    for (const dependency of item.dependsOn ?? []) {
      if (!ids.has(dependency)) throw new Error(`Workstream '${item.id}' depends on unknown '${dependency}'.`);
      if (dependency === item.id) throw new Error(`Workstream '${item.id}' depends on itself.`);
    }
  }
  topologicalOrder(workstreams);

  const ancestors = dependencyAncestors(workstreams);
  for (let leftIndex = 0; leftIndex < workstreams.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < workstreams.length; rightIndex += 1) {
      const left = workstreams[leftIndex];
      const right = workstreams[rightIndex];
      if (!scopesMayOverlap(left.scope, right.scope)) continue;
      const ordered = ancestors.get(left.id).has(right.id) || ancestors.get(right.id).has(left.id);
      if (!ordered) {
        throw new Error(`Potentially overlapping scopes must be dependency-ordered: '${left.id}' and '${right.id}'.`);
      }
    }
  }
}

export function dependencyAncestors(workstreams) {
  topologicalOrder(workstreams);
  const ancestors = new Map();
  const visit = (id) => {
    if (ancestors.has(id)) return ancestors.get(id);
    const item = workstreams.find((entry) => entry.id === id);
    const result = new Set(item?.dependsOn ?? []);
    for (const dependency of item?.dependsOn ?? []) {
      for (const ancestor of visit(dependency)) result.add(ancestor);
    }
    ancestors.set(id, result);
    return result;
  };
  for (const item of workstreams) visit(item.id);
  return ancestors;
}

export function serializeOverlappingWorkstreams(workstreams) {
  const normalized = workstreams.map((item) => ({
    ...item,
    dependsOn: [...new Set((item.dependsOn ?? []).map(String))],
  }));
  const addedDependencies = [];
  topologicalOrder(normalized);
  for (let leftIndex = 0; leftIndex < normalized.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < normalized.length; rightIndex += 1) {
      const left = normalized[leftIndex];
      const right = normalized[rightIndex];
      if (!scopesMayOverlap(left.scope, right.scope)) continue;
      const ancestors = dependencyAncestors(normalized);
      const alreadyOrdered = ancestors.get(left.id).has(right.id) || ancestors.get(right.id).has(left.id);
      if (alreadyOrdered) continue;
      right.dependsOn = [...new Set([...right.dependsOn, left.id])];
      addedDependencies.push({ workstreamId: right.id, dependsOn: left.id });
    }
  }
  topologicalOrder(normalized);
  return { workstreams: normalized, addedDependencies };
}

export function topologicalOrder(workstreams) {
  const byId = new Map(workstreams.map((item) => [item.id, item]));
  const indegree = new Map(workstreams.map((item) => [item.id, 0]));
  const children = new Map(workstreams.map((item) => [item.id, []]));
  for (const item of workstreams) {
    for (const dependency of item.dependsOn ?? []) {
      if (!byId.has(dependency)) throw new Error(`Unknown dependency '${dependency}'.`);
      indegree.set(item.id, indegree.get(item.id) + 1);
      children.get(dependency).push(item.id);
    }
  }
  const queue = [...indegree.entries()].filter(([, value]) => value === 0).map(([id]) => id).sort();
  const result = [];
  while (queue.length) {
    const id = queue.shift();
    result.push(id);
    for (const child of children.get(id)) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) queue.push(child);
    }
    queue.sort();
  }
  if (result.length !== workstreams.length) throw new Error('Workstream graph contains a cycle.');
  return result;
}

export function readyWorkstreams(workstreams) {
  const byId = new Map(workstreams.map((item) => [item.id, item]));
  return workstreams.filter((item) => {
    if (!['pending', 'ready'].includes(item.status)) return false;
    return (item.dependsOn ?? []).every((id) => ['completed', 'integrated'].includes(byId.get(id)?.status));
  });
}

export function transition(state, target, reason = '') {
  if (state.phase === target) return state;
  const allowed = LEGAL_TRANSITIONS.get(state.phase);
  if (!allowed?.has(target)) throw new Error(`Illegal phase transition: ${state.phase} -> ${target}`);
  state.transitions.push({ at: now(), from: state.phase, to: target, reason: redactText(reason, 500) });
  state.phase = target;
  if (TERMINAL_PHASES.has(target)) state.finishedAt = now();
  return state;
}

export function createInitialState({ runId, objective, repoRoot, baseRef, baseCommit, maxRepairs = 2, config = {} }) {
  return {
    version: 1,
    runId,
    objective: redactText(objective, 4000),
    repoRoot,
    baseRef,
    baseCommit,
    phase: 'new',
    startedAt: now(),
    finishedAt: null,
    repairIteration: 0,
    maxRepairs,
    acceptanceCriteria: [],
    nonGoals: [],
    plan: null,
    workstreams: [],
    integration: { branch: null, worktreePath: null, commit: null, attempts: [] },
    validation: { commands: [], runs: [] },
    verification: null,
    reviews: [],
    final: null,
    background: null,
    resumes: [],
    transitions: [],
    config,
  };
}

export function instantiateWorkstreams(specs, repairIteration = 0) {
  return specs.map((item) => ({
    id: item.id,
    title: redactText(item.title, 500),
    kind: item.kind ?? 'implementation',
    role: item.role ?? 'implementer',
    scope: [...new Set(item.scope.map((scope) => String(scope).trim()).filter(Boolean))],
    dependsOn: [...new Set((item.dependsOn ?? []).map(String))],
    criterionIds: [...new Set((item.criterionIds ?? []).map(String))],
    required: item.required !== false,
    instructions: [...new Set((item.instructions ?? []).map(String))],
    localValidationCommands: [...new Set((item.localValidationCommands ?? []).map(String))],
    repairIteration,
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
    snapshots: [],
    attempts: [],
  }));
}

export function runPaths(repoRoot, runId) {
  const root = path.join(repoRoot, '.codex', 'delivery-runs', runId);
  return {
    root,
    state: path.join(root, 'state.json'),
    events: path.join(root, 'events.jsonl'),
    results: path.join(root, 'results.jsonl'),
    summary: path.join(root, 'summary.md'),
    final: path.join(root, 'final.json'),
    background: path.join(root, 'background.json'),
    backgroundLog: path.join(root, 'background.log'),
    artifacts: path.join(root, 'artifacts'),
    agents: path.join(root, 'agents'),
    commands: path.join(root, 'commands'),
    prompts: path.join(root, 'prompts'),
  };
}

export async function saveState(repoRoot, state) {
  const paths = runPaths(repoRoot, state.runId);
  await writeJsonAtomic(paths.state, state);
  await writeFile(paths.summary, renderSummary(state), 'utf8');
}

export async function loadState(repoRoot, runId) {
  return readJson(runPaths(repoRoot, runId).state);
}

export async function appendEvent(repoRoot, state, event) {
  const record = {
    at: now(),
    runId: state.runId,
    phase: state.phase,
    ...event,
  };
  await appendJsonl(runPaths(repoRoot, state.runId).events, record);
  try {
    state?.__eventSink?.(record);
  } catch {
    // Progress rendering must never break the durable event write.
  }
  return record;
}

export async function appendResult(repoRoot, state, result) {
  const normalized = {
    id: result.id ?? `RES-${randomUUID().slice(0, 8)}`,
    at: now(),
    runId: state.runId,
    phase: state.phase,
    kind: result.kind ?? 'finding',
    title: redactText(result.title ?? 'Result', 300),
    summary: redactText(result.summary ?? '', 2000),
    details: (result.details ?? []).map((item) => redactText(item, 1000)),
    paths: [...new Set((result.paths ?? []).map(String))],
    criterionIds: [...new Set((result.criterionIds ?? []).map(String))],
    workstreamId: result.workstreamId ?? null,
    role: result.role ?? null,
    confidence: result.confidence ?? 'medium',
    tags: [...new Set((result.tags ?? []).map(String))],
  };
  await appendJsonl(runPaths(repoRoot, state.runId).results, normalized);
  return normalized;
}

export function renderSummary(state) {
  const lines = [
    `# Codex delivery run ${state.runId}`,
    '',
    `- **Phase:** ${state.phase}`,
    `- **Objective:** ${state.objective}`,
    `- **Base:** ${state.baseRef} (${state.baseCommit})`,
    `- **Started:** ${state.startedAt}`,
    `- **Finished:** ${state.finishedAt ?? '—'}`,
    `- **Repair iteration:** ${state.repairIteration}/${state.maxRepairs}`,
    '',
    '## Acceptance criteria',
    '',
  ];
  if (state.acceptanceCriteria.length === 0) lines.push('_Not defined._');
  for (const criterion of state.acceptanceCriteria) {
    const evidence = state.verification?.criteria?.find((item) => item.id === criterion.id);
    lines.push(`- **${criterion.id}** [${evidence?.status ?? 'unverified'}] ${criterion.text}`);
  }
  lines.push('', '## Workstreams', '');
  if (state.workstreams.length === 0) lines.push('_Not planned._');
  for (const item of state.workstreams) {
    lines.push(`- **${item.id}** [${item.status}] ${item.title} — role=${item.role}; scope=${item.scope.join(', ')}`);
  }
  lines.push('', '## Validation', '');
  if (state.validation.runs.length === 0) lines.push('_No commands recorded._');
  for (const run of state.validation.runs) {
    lines.push(`- [${run.ok ? 'passed' : 'failed'}] \`${run.command}\` (${run.durationMs} ms)`);
  }
  lines.push('', '## Reviews', '');
  if (state.reviews.length === 0) lines.push('_No reviews recorded._');
  for (const review of state.reviews) {
    const counts = review.findings?.reduce((acc, finding) => {
      acc[finding.severity] = (acc[finding.severity] ?? 0) + 1;
      return acc;
    }, {}) ?? {};
    lines.push(`- **${review.role ?? 'review'}:** ${review.verdict ?? 'unknown'} ${JSON.stringify(counts)}`);
  }
  if (state.final) {
    lines.push('', '## Final', '', `**${state.final.status}:** ${state.final.summary}`);
  }
  return `${lines.join('\n')}\n`;
}

export function parseJsonResult(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('Codex did not produce a final structured result.');
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error(`Invalid JSON result: ${redactText(raw, 400)}`);
  }
}

export function collectUsage(events) {
  const total = {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
  for (const event of events) {
    if (event?.type !== 'turn.completed' || !event.usage) continue;
    for (const key of Object.keys(total)) total[key] += Number(event.usage[key] ?? 0);
  }
  return total;
}

export function attachEventSink(state, sink = null) {
  if (!state || typeof state !== 'object') return state;
  Object.defineProperty(state, '__eventSink', {
    value: typeof sink === 'function' ? sink : null,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return state;
}
