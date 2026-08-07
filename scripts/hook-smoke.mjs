#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInitialState, instantiateWorkstreams, saveState, transition } from '../.codex/delivery-kit/lib/core.mjs';
import { runProcess } from '../.codex/delivery-kit/lib/git.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, '.codex', 'delivery-kit', 'hook.mjs');

async function git(cwd, args) {
  const result = await runProcess('git', args, { cwd });
  assert.equal(result.code, 0, result.stderr);
}

async function invoke(cwd, input, env = {}) {
  const prefix = `.hook-smoke-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stdoutPath = path.join(cwd, `${prefix}.stdout`);
  const stderrPath = path.join(cwd, `${prefix}.stderr`);
  const stdoutFile = await open(stdoutPath, 'w+');
  const stderrFile = await open(stderrPath, 'w+');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', stdoutFile.fd, stderrFile.fd] });
    child.on('error', reject);
    child.on('close', async (code) => {
      await stdoutFile.close();
      await stderrFile.close();
      const stdout = await readFile(stdoutPath, 'utf8').catch(() => '');
      const stderr = await readFile(stderrPath, 'utf8').catch(() => '');
      await rm(stdoutPath, { force: true });
      await rm(stderrPath, { force: true });
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-delivery-hook-'));
  try {
    await git(temp, ['init', '-q']);
    await git(temp, ['config', 'user.email', 'hook@example.invalid']);
    await git(temp, ['config', 'user.name', 'Hook Smoke']);
    await writeFile(path.join(temp, 'README.md'), '# fixture\n', 'utf8');
    await git(temp, ['add', 'README.md']);
    await git(temp, ['commit', '-q', '-m', 'fixture']);

    const runId = 'hook-smoke-run';
    const state = createInitialState({ runId, objective: 'Hook smoke', repoRoot: temp, baseRef: 'main', baseCommit: 'fixture', maxRepairs: 1, config: {} });
    transition(state, 'discovery', 'test');
    transition(state, 'planning', 'test');
    state.acceptanceCriteria = [{ id: 'AC-1', text: 'Scoped change.' }];
    state.workstreams = instantiateWorkstreams([{
      id: 'W1', title: 'Scoped writer', role: 'implementer', kind: 'implementation', scope: ['src/**'], dependsOn: [], criterionIds: ['AC-1'], required: true, instructions: [], localValidationCommands: [],
    }]);
    state.workstreams[0].status = 'running';
    transition(state, 'implementation', 'test');
    await saveState(temp, state);

    const common = {
      CODEX_DELIVERY_ROOT: temp,
      CODEX_DELIVERY_RUN_ID: runId,
      CODEX_DELIVERY_WORKSTREAM: 'W1',
      CODEX_DELIVERY_ROLE: 'implementer',
    };
    const base = { session_id: 'session-1', turn_id: 'turn-1', cwd: temp, model: 'fixture-model', permission_mode: 'dontAsk' };

    const allowed = await invoke(temp, {
      ...base,
      hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'tool-1',
      tool_input: { command: '*** Begin Patch\n*** Add File: src/example.js\n+export const ok = true;\n*** End Patch' },
    }, common);
    assert.equal(allowed.code, 0, allowed.stderr);
    const allowedJson = JSON.parse(allowed.stdout || '{}');
    assert.notEqual(allowedJson.hookSpecificOutput?.permissionDecision, 'deny');

    const deniedScope = await invoke(temp, {
      ...base,
      hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'tool-2',
      tool_input: { command: '*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch' },
    }, common);
    const deniedScopeJson = JSON.parse(deniedScope.stdout);
    assert.equal(deniedScopeJson.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(deniedScopeJson.hookSpecificOutput.permissionDecisionReason, /outside active delivery scope/i);

    const deniedCommand = await invoke(temp, {
      ...base,
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tool-3',
      tool_input: { command: 'git reset --hard HEAD~1' },
    }, common);
    const deniedCommandJson = JSON.parse(deniedCommand.stdout);
    assert.equal(deniedCommandJson.hookSpecificOutput.permissionDecision, 'deny');

    const post = await invoke(temp, {
      ...base,
      hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'tool-4',
      tool_input: { command: 'node --version' }, tool_response: { output: 'v22', exit_code: 0 },
    }, common);
    assert.equal(post.code, 0, post.stderr);

    const events = (await readFile(path.join(temp, '.codex', 'delivery-runs', runId, 'events.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
    assert(events.some((event) => event.type === 'codex.hook.pre-tool-use' && event.decision === 'deny'));
    assert(events.some((event) => event.type === 'codex.hook.post-tool-use' && event.responseHash));
    console.log('hook-smoke: OK');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`hook-smoke: FAIL\n${error.stack ?? error.message}`);
  process.exitCode = 1;
});
