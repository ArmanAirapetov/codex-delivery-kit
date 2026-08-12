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
    const relative = path.relative(ROOT, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (['.git', '.codex-delivery-backups', 'node_modules', 'dist'].includes(entry.name)) continue;
      if (relative === '.codex/delivery-runs' || relative.startsWith('.codex/delivery-runs/')) continue;
      result.push(...await walk(full));
    } else {
      result.push(full);
    }
  }
  return result;
}

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
}

async function exists(relative) {
  try {
    await access(path.join(ROOT, relative));
    return true;
  } catch {
    return false;
  }
}

async function requireAny(label, candidates) {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`Missing required ${label}. Tried: ${candidates.join(', ')}`);
}

async function main() {
  const required = [
    'AGENTS.md', '.codex/config.toml', 'codex-delivery.config.json',
    '.codex/delivery-kit/cli.mjs', '.codex/delivery-kit/mcp-server.mjs',
    '.codex/delivery-kit/package.json', '.codex/delivery-kit/package-lock.json',
    '.agents/skills/codex-delivery/SKILL.md', 'scripts/codex-delivery',
  ];
  for (const relative of required) await access(path.join(ROOT, relative));
  const readmePath = await requireAny('README', ['README.md', 'docs/codex-delivery/README.md']);
  for (const doc of ['SYSTEM.md', 'WORKFLOW.md', 'OBSERVABILITY.md', 'HOOKS.md', 'RESULTS.md']) {
    await requireAny(doc, [`docs/${doc}`, `docs/codex-delivery/${doc}`]);
  }

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
  const readme = await readFile(path.join(ROOT, readmePath), 'utf8');
  assert(readme.includes('Node.js 22+'), 'README must document the Node.js 22+ runtime requirement.');
  assert(readme.includes('Ink/React'), 'README must document the bundled Ink/React TUI runtime.');
  for (const referenced of ['scripts/install.sh', 'scripts/validate.mjs', 'scripts/mcp-smoke.mjs', 'scripts/smoke-test.sh']) {
    assert(readme.includes(referenced.split('/').at(-1)) || readme.includes(referenced), `README does not describe ${referenced}`);
  }

  const runtimePackage = JSON.parse(await readFile(path.join(ROOT, '.codex', 'delivery-kit', 'package.json'), 'utf8'));
  assert.equal(runtimePackage.engines?.node, '>=22', 'Runtime package must declare Node.js >=22 for current Ink.');
  assert.equal(runtimePackage.dependencies?.ink, '7.1.1', 'Runtime package must pin Ink.');
  assert.equal(runtimePackage.dependencies?.react, '19.2.4', 'Runtime package must pin React.');

  console.log(`validate: OK (${mjsFiles.length} JavaScript modules, ${jsonFiles.length} JSON files, ${agents.length} agents)`);
}

main().catch((error) => {
  console.error(`validate: FAIL\n${error.stack ?? error.message}`);
  process.exitCode = 1;
});
