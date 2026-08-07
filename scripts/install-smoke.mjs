#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../.codex/delivery-kit/lib/git.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function run(command, args, cwd) {
  const result = await runProcess(command, args, { cwd, timeoutMs: 60000 });
  assert.equal(result.code, 0, `${command} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-delivery-install-'));
  try {
    await run('git', ['init', '-q'], temp);
    await run('git', ['config', 'user.email', 'install@example.invalid'], temp);
    await run('git', ['config', 'user.name', 'Install Smoke'], temp);
    await writeFile(path.join(temp, 'AGENTS.md'), '# Existing instructions\n\nKeep this line.\n', 'utf8');
    await writeFile(path.join(temp, '.gitignore'), 'existing.tmp\n', 'utf8');
    await run('mkdir', ['-p', '.codex'], temp);
    await writeFile(path.join(temp, '.codex', 'config.toml'), '[agents]\nmax_concurrent_threads_per_session = 3\n', 'utf8');
    await writeFile(path.join(temp, '.codex', 'hooks.json'), JSON.stringify({ description: 'existing', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo existing' }] }] } }, null, 2));
    await run('git', ['add', '.'], temp);
    await run('git', ['commit', '-q', '-m', 'fixture'], temp);

    await run(path.join(ROOT, 'scripts', 'install.sh'), [temp], ROOT);
    await run(path.join(ROOT, 'scripts', 'install.sh'), [temp], ROOT);

    const agents = await readFile(path.join(temp, 'AGENTS.md'), 'utf8');
    assert(agents.includes('Keep this line.'));
    assert.equal((agents.match(/CODEX DELIVERY KIT BEGIN/g) ?? []).length, 1, 'AGENTS block must be idempotent.');

    const config = await readFile(path.join(temp, '.codex', 'config.toml'), 'utf8');
    assert(config.includes('max_concurrent_threads_per_session = 3'), 'Existing agents config must win.');
    assert.equal((config.match(/\[mcp_servers\.delivery_workflow\]/g) ?? []).length, 1);

    const hooks = JSON.parse(await readFile(path.join(temp, '.codex', 'hooks.json'), 'utf8'));
    assert(hooks.hooks.Stop.some((group) => group.hooks?.some((hook) => hook.command === 'echo existing')));
    const deliveryCommands = Object.values(hooks.hooks).flat().flatMap((group) => group.hooks ?? []).filter((hook) => hook.command?.includes('delivery-kit/hook.mjs'));
    assert(deliveryCommands.length >= 6);

    const ignore = await readFile(path.join(temp, '.gitignore'), 'utf8');
    assert(ignore.includes('existing.tmp'));
    assert.equal((ignore.match(/CODEX DELIVERY KIT BEGIN/g) ?? []).length, 1);

    await readFile(path.join(temp, '.codex', 'delivery-kit', 'cli.mjs'), 'utf8');
    await readFile(path.join(temp, 'docs', 'codex-delivery', 'SYSTEM.md'), 'utf8');
    console.log('install-smoke: OK');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`install-smoke: FAIL\n${error.stack ?? error.message}`);
  process.exitCode = 1;
});
