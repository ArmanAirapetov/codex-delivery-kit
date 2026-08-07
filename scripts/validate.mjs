#!/usr/bin/env node
import assert from 'node:assert/strict';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full));
    else result.push(full);
  }
  return result;
}

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
}

async function main() {
  const required = [
    'README.md', 'AGENTS.md', '.codex/config.toml', 'codex-delivery.config.json',
    '.codex/delivery-kit/cli.mjs', '.codex/delivery-kit/mcp-server.mjs',
    '.agents/skills/codex-delivery/SKILL.md', 'scripts/codex-delivery',
    'docs/SYSTEM.md', 'docs/WORKFLOW.md', 'docs/OBSERVABILITY.md', 'docs/HOOKS.md', 'docs/RESULTS.md',
  ];
  for (const relative of required) await access(path.join(ROOT, relative));

  const files = await walk(ROOT);
  const mjsFiles = files.filter((file) => file.endsWith('.mjs'));
  for (const file of mjsFiles) run(process.execPath, ['--check', file]);

  const jsonFiles = files.filter((file) => file.endsWith('.json'));
  for (const file of jsonFiles) JSON.parse(await readFile(file, 'utf8'));

  const schemas = jsonFiles.filter((file) => file.includes(`${path.sep}delivery${path.sep}schemas${path.sep}`));
  assert.equal(schemas.length, 6, 'Expected six output schemas.');
  for (const file of schemas) {
    const schema = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(schema.type, 'object', `${file} must be an object schema.`);
    assert.equal(schema.additionalProperties, false, `${file} must reject unknown top-level fields.`);
  }

  const agents = files.filter((file) => file.includes(`${path.sep}.codex${path.sep}agents${path.sep}`) && file.endsWith('.toml'));
  assert(agents.length >= 10, 'Expected a complete custom-agent set.');

  const pythonCode = [
    'import pathlib, tomllib',
    `root = pathlib.Path(${JSON.stringify(ROOT)})`,
    'files = [root / ".codex/config.toml", *sorted((root / ".codex/agents").glob("*.toml"))]',
    'for p in files:',
    '    tomllib.loads(p.read_text(encoding="utf-8"))',
  ].join('\n');
  const python = spawnSync('python3', ['-c', pythonCode], { encoding: 'utf8' });
  if (python.error?.code !== 'ENOENT' && python.status !== 0) {
    throw new Error(`TOML validation failed\n${python.stdout}\n${python.stderr}`);
  }

  const wrapper = await stat(path.join(ROOT, 'scripts', 'codex-delivery'));
  assert(wrapper.isFile());
  const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8');
  for (const referenced of ['scripts/install.sh', 'scripts/validate.mjs', 'scripts/mcp-smoke.mjs', 'scripts/smoke-test.sh']) {
    assert(readme.includes(referenced.split('/').at(-1)) || readme.includes(referenced), `README does not describe ${referenced}`);
  }

  console.log(`validate: OK (${mjsFiles.length} JavaScript modules, ${jsonFiles.length} JSON files, ${agents.length} agents)`);
}

main().catch((error) => {
  console.error(`validate: FAIL\n${error.stack ?? error.message}`);
  process.exitCode = 1;
});
