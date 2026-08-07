#!/usr/bin/env node
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { redactText, scopeMatches, sha256 } from './lib/core.mjs';

function readStdin() {
  const data = readFileSync(0, 'utf8');
  if (data.length > 8 * 1024 * 1024) throw new Error('Hook input exceeds 8 MiB.');
  return data;
}

function repoRoot(cwd) {
  if (process.env.CODEX_DELIVERY_ROOT) return path.resolve(process.env.CODEX_DELIVERY_ROOT);
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (result.status === 0 && result.stdout.trim()) return path.resolve(result.stdout.trim());
  return path.resolve(cwd);
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

async function resolveRun(root) {
  const explicit = process.env.CODEX_DELIVERY_RUN_ID?.trim();
  if (explicit) {
    const state = await readJson(path.join(root, '.codex', 'delivery-runs', explicit, 'state.json'));
    return { runId: explicit, state, explicit: true };
  }
  try {
    const runId = (await readFile(path.join(root, '.codex', 'delivery-runs', 'latest-interactive'), 'utf8')).trim();
    if (!runId) return { runId: null, state: null, explicit: false };
    const state = await readJson(path.join(root, '.codex', 'delivery-runs', runId, 'state.json'));
    if (!state || ['accepted', 'blocked', 'failed'].includes(state.phase)) return { runId: null, state: null, explicit: false };
    return { runId, state, explicit: false };
  } catch {
    return { runId: null, state: null, explicit: false };
  }
}

function safeId(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
}

async function appendHookEvent(root, run, input, extra = {}) {
  const sessionId = safeId(input.session_id);
  const file = run.runId
    ? path.join(root, '.codex', 'delivery-runs', run.runId, 'events.jsonl')
    : path.join(root, '.codex', 'hook-events', `${sessionId}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  const event = {
    at: new Date().toISOString(),
    type: `codex.hook.${String(input.hook_event_name || 'unknown').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
    source: 'codex-hook',
    runId: run.runId,
    sessionId: input.session_id || null,
    turnId: input.turn_id || null,
    model: input.model || null,
    permissionMode: input.permission_mode || null,
    role: process.env.CODEX_DELIVERY_ROLE || null,
    workstreamId: process.env.CODEX_DELIVERY_WORKSTREAM || null,
    ...extra,
  };
  await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
}

function commandText(input) {
  const value = input?.tool_input?.command;
  return typeof value === 'string' ? value : '';
}

function dangerousCommand(command) {
  const rules = [
    [/\brm\s+(?=[^\n]*(?:-r|-R|--recursive))(?=[^\n]*(?:-f|--force))[^\n]*(?:^|\s)(?:\/|\.\/?|\.\.\/?|~\/?|\$HOME\/?|\$\{HOME\}\/?|\*)(?:\s|$)/i, 'Recursive deletion of a root, repository, parent, home, or wildcard path is forbidden.'],
    [/\bgit\s+reset\s+--hard\b/i, 'git reset --hard is forbidden; preserve changes and use a new branch or worktree.'],
    [/\bgit\s+clean\s+-[^\s]*[fdx][^\s]*\b/i, 'Destructive git clean is forbidden.'],
    [/\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|-f)\b/i, 'Force-pushing is forbidden from Codex delivery runs.'],
    [/\b(?:mkfs(?:\.[a-z0-9]+)?|wipefs)\b/i, 'Filesystem formatting commands are forbidden.'],
    [/\bdd\b[^\n]*\bof=\/dev\//i, 'Raw writes to block devices are forbidden.'],
    [/\b(?:shutdown|poweroff|halt|reboot)\b/i, 'Host power-state commands are forbidden.'],
    [/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash)\b/i, 'Piping downloaded content directly to a shell is forbidden.'],
  ];
  for (const [pattern, reason] of rules) if (pattern.test(command)) return reason;
  return null;
}

function patchPaths(command) {
  const paths = [];
  for (const line of String(command).split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete|Move to) File:\s*(.+?)\s*$/);
    if (match) paths.push(match[1].replace(/^a\//, '').replace(/^b\//, '').trim());
  }
  return [...new Set(paths)];
}

function activeScopes(run) {
  const state = run.state;
  if (!state) return { scopes: [], workstreams: [], enforce: false, reason: null };
  const explicitId = process.env.CODEX_DELIVERY_WORKSTREAM?.trim();
  if (explicitId) {
    const item = state.workstreams?.find((entry) => entry.id === explicitId);
    if (!item) return { scopes: [], workstreams: [], enforce: true, reason: `Unknown delivery workstream '${explicitId}'.` };
    return { scopes: item.scope ?? [], workstreams: [item.id], enforce: true, reason: null };
  }
  if (!run.explicit && ['implementation', 'repair'].includes(state.phase)) {
    const running = (state.workstreams ?? []).filter((entry) => entry.status === 'running');
    return {
      scopes: [...new Set(running.flatMap((entry) => entry.scope ?? []))],
      workstreams: running.map((entry) => entry.id),
      enforce: true,
      reason: running.length ? null : 'No interactive workstream is currently claimed.',
    };
  }
  if (!run.explicit && ['discovery', 'planning', 'verification', 'review'].includes(state.phase)) {
    return { scopes: [], workstreams: [], enforce: true, reason: `File edits are not allowed during delivery phase '${state.phase}'.` };
  }
  return { scopes: [], workstreams: [], enforce: false, reason: null };
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

function context(event, text) {
  return {
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: text,
    },
  };
}

function responseHash(value) {
  if (value === undefined || value === null) return { responseHash: null, responseLength: 0 };
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { responseHash: sha256(text), responseLength: text.length };
}

async function main() {
  const raw = readStdin();
  const input = JSON.parse(raw || '{}');
  const root = repoRoot(input.cwd || process.cwd());
  const run = await resolveRun(root);
  const eventName = input.hook_event_name || 'Unknown';

  if (eventName === 'PreToolUse') {
    const command = commandText(input);
    const toolName = input.tool_name || 'unknown';
    const paths = toolName === 'apply_patch' ? patchPaths(command) : [];
    const scopes = activeScopes(run);
    const danger = toolName === 'Bash' ? dangerousCommand(command) : null;
    const outside = paths.filter((candidate) => !scopeMatches(candidate, scopes.scopes));
    const blockedReason = danger
      || (toolName === 'apply_patch' && scopes.enforce && scopes.reason)
      || (toolName === 'apply_patch' && scopes.enforce && paths.length === 0 ? 'The patch paths could not be determined; use a standard apply_patch file header.' : null)
      || (toolName === 'apply_patch' && scopes.enforce && outside.length ? `Patch paths outside active delivery scope: ${outside.join(', ')}. Allowed scopes: ${scopes.scopes.join(', ') || '(none)'}.` : null);
    await appendHookEvent(root, run, input, {
      toolName,
      toolUseId: input.tool_use_id || null,
      inputHash: sha256(JSON.stringify(input.tool_input ?? null)),
      commandPreview: command ? redactText(command, 280) : null,
      paths,
      activeWorkstreams: scopes.workstreams,
      decision: blockedReason ? 'deny' : 'allow',
      reason: blockedReason,
    });
    if (blockedReason) process.stdout.write(JSON.stringify(deny(blockedReason)));
    else if (toolName === 'Bash' && scopes.enforce && scopes.scopes.length) {
      process.stdout.write(JSON.stringify(context('PreToolUse', `Active delivery scope: ${scopes.scopes.join(', ')}. Bash mutations cannot be fully inferred statically; keep all changes inside this scope and record checks/results.`)));
    } else process.stdout.write('{}');
    return;
  }

  if (eventName === 'PostToolUse') {
    await appendHookEvent(root, run, input, {
      toolName: input.tool_name || 'unknown',
      toolUseId: input.tool_use_id || null,
      inputHash: sha256(JSON.stringify(input.tool_input ?? null)),
      ...responseHash(input.tool_response),
    });
    process.stdout.write('{}');
    return;
  }

  if (eventName === 'UserPromptSubmit') {
    const prompt = String(input.prompt ?? '');
    await appendHookEvent(root, run, input, { promptHash: sha256(prompt), promptLength: prompt.length });
    process.stdout.write('{}');
    return;
  }

  if (eventName === 'SessionStart') {
    await appendHookEvent(root, run, input, { sourceKind: input.source || null });
    if (run.state && !['accepted', 'blocked', 'failed'].includes(run.state.phase)) {
      process.stdout.write(JSON.stringify(context('SessionStart', `Active delivery run ${run.runId}; phase=${run.state.phase}. Read delivery_status before acting, preserve acceptance criteria and workstream scopes, and record material results through delivery_record_result.`)));
    } else process.stdout.write('{}');
    return;
  }

  if (eventName === 'SubagentStart') {
    await appendHookEvent(root, run, input, { agentId: input.agent_id || null, agentType: input.agent_type || null });
    process.stdout.write('{}');
    return;
  }

  if (eventName === 'SubagentStop') {
    const message = String(input.last_assistant_message ?? '');
    await appendHookEvent(root, run, input, { agentId: input.agent_id || null, agentType: input.agent_type || null, messageHash: sha256(message), messageLength: message.length });
    process.stdout.write('{}');
    return;
  }

  if (eventName === 'Stop') {
    const message = String(input.last_assistant_message ?? '');
    await appendHookEvent(root, run, input, { messageHash: sha256(message), messageLength: message.length, stopHookActive: Boolean(input.stop_hook_active) });
    process.stdout.write('{}');
    return;
  }

  if (eventName === 'SessionEnd') {
    await appendHookEvent(root, run, input, { reason: input.reason || null });
    return;
  }

  await appendHookEvent(root, run, input);
  process.stdout.write('{}');
}

main().catch((error) => {
  process.stderr.write(`[codex-delivery-hook] ${redactText(error.stack ?? error.message, 1800)}\n`);
  process.exitCode = 1;
});
