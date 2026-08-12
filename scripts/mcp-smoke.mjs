#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../.codex/delivery-kit/lib/git.mjs';
import { handleMcpRequest } from '../.codex/delivery-kit/mcp-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function git(cwd, args) {
  const result = await runProcess('git', args, { cwd });
  assert.equal(result.code, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-delivery-mcp-'));
  try {
    await git(temp, ['init', '-q']);
    await git(temp, ['config', 'user.email', 'smoke@example.invalid']);
    await git(temp, ['config', 'user.name', 'Smoke Test']);
    await writeFile(path.join(temp, 'README.md'), '# fixture\n', 'utf8');
    await git(temp, ['add', 'README.md']);
    await git(temp, ['commit', '-q', '-m', 'fixture']);

    const previousCwd = process.cwd();
    process.chdir(temp);
    let nextId = 1;
    const request = async (method, params = {}) => {
      const id = nextId++;
      const message = await handleMcpRequest({ jsonrpc: '2.0', id, method, params });
      assert(message, `MCP request ${method} produced no response.`);
      if (message.error) throw new Error(message.error.message);
      return message.result;
    };

    const initialize = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
    assert.equal(initialize.serverInfo.name, 'codex-delivery-workflow');
    const listed = await request('tools/list');
    const names = new Set(listed.tools.map((tool) => tool.name));
    for (const required of ['delivery_begin', 'delivery_define_contract', 'delivery_approve_plan', 'delivery_claim', 'delivery_complete', 'delivery_record_verification', 'delivery_record_review', 'delivery_accept']) {
      assert(names.has(required), `Missing MCP tool ${required}`);
    }

    const call = async (name, args) => {
      const result = await request('tools/call', { name, arguments: args });
      assert.equal(result.isError, false, `${name} failed: ${result.content?.[0]?.text}`);
      return result.structuredContent;
    };

    const begun = await call('delivery_begin', { objective: 'MCP smoke workflow' });
    assert.match(begun.runId, /^interactive-/);
    await call('delivery_define_contract', {
      runId: begun.runId,
      acceptanceCriteria: ['A fixture file exists and is checked.'],
      nonGoals: ['No production integration.'],
    });
    const planned = await call('delivery_approve_plan', {
      runId: begun.runId,
      summary: 'Create one isolated fixture.',
      affectedAreas: ['fixture.txt'],
      validationCommands: ['node --version'],
      parallelismRationale: 'Only one writer is needed.',
      workstreams: [{
        id: 'W1',
        title: 'Create fixture',
        kind: 'implementation',
        role: 'implementer',
        scope: ['fixture.txt'],
        dependsOn: [],
        criterionIds: ['AC-1'],
        required: true,
        instructions: ['Create the fixture.'],
        localValidationCommands: ['test -f fixture.txt'],
      }],
    });
    assert.deepEqual(planned.ready, ['W1']);
    const claim = await call('delivery_claim', { runId: begun.runId, workstreamId: 'W1', worker: 'smoke-worker' });
    await call('delivery_complete', {
      runId: begun.runId,
      workstreamId: 'W1',
      claimToken: claim.claimToken,
      summary: 'Fixture created and checked.',
      changedPaths: ['fixture.txt'],
      checks: [{ command: 'test -f fixture.txt', status: 'passed', summary: 'Present.' }],
    });
    await call('delivery_record_verification', {
      runId: begun.runId,
      verdict: 'passed',
      summary: 'Criterion proven.',
      criteria: [{ id: 'AC-1', status: 'proven', evidence: ['fixture.txt'], notes: 'Recorded by smoke test.' }],
      failedCommands: [],
      residualRisks: [],
    });
    await call('delivery_record_review', {
      runId: begun.runId,
      role: 'reviewer',
      verdict: 'approved',
      summary: 'No blocking findings.',
      findings: [],
      positiveEvidence: ['Scope and check recorded.'],
    });
    const accepted = await call('delivery_accept', { runId: begun.runId, summary: 'MCP smoke accepted.' });
    assert.equal(accepted.status, 'accepted');

    const latest = (await readFile(path.join(temp, '.codex', 'delivery-runs', 'latest-interactive'), 'utf8')).trim();
    assert.equal(latest, begun.runId);
    process.chdir(previousCwd);
    console.log('mcp-smoke: OK');
  } finally {
    try {
      if (process.cwd() === temp) process.chdir(ROOT);
    } catch {
      process.chdir(ROOT);
    }
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`mcp-smoke: FAIL\n${error.stack ?? error.message}`);
  process.exitCode = 1;
});
