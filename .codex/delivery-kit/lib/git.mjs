import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, slugify } from './core.mjs';

export async function runProcess(command, args = [], options = {}) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const limit = options.maxOutputBytes ?? 8 * 1024 * 1024;
    const append = (current, chunk) => {
      const next = current + chunk.toString();
      return next.length > limit ? next.slice(next.length - limit) : next;
    };
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); options.onStdout?.(chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); options.onStderr?.(chunk); });
    child.on('error', reject);
    let timer = null;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      }, options.timeoutMs);
    }
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const result = { code: code ?? -1, signal, stdout, stderr, durationMs: Date.now() - startedAt };
      if (options.rejectOnError && result.code !== 0) {
        const error = new Error(`${command} ${args.join(' ')} failed with code ${result.code}: ${stderr.slice(-1200)}`);
        error.result = result;
        reject(error);
      } else {
        resolve(result);
      }
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function git(cwd, args, options = {}) {
  return runProcess('git', args, { cwd, rejectOnError: options.rejectOnError ?? true, timeoutMs: options.timeoutMs ?? 120000, maxOutputBytes: options.maxOutputBytes });
}

export async function repoRoot(cwd = process.cwd()) {
  const result = await git(cwd, ['rev-parse', '--show-toplevel']);
  return result.stdout.trim();
}

export async function currentRef(cwd) {
  const branch = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { rejectOnError: false });
  return branch.code === 0 ? branch.stdout.trim() : 'HEAD';
}

export async function headCommit(cwd, ref = 'HEAD') {
  return (await git(cwd, ['rev-parse', ref])).stdout.trim();
}

export async function statusPorcelain(cwd) {
  return (await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout;
}

export async function assertUsableRepository(cwd, { allowDirty = false } = {}) {
  const root = await repoRoot(cwd);
  const status = await statusPorcelain(root);
  const meaningful = status
    .split('\n')
    .filter(Boolean)
    .filter((line) => !line.slice(3).startsWith('.codex/delivery-runs/'));
  if (!allowDirty && meaningful.length) {
    throw new Error(`Repository has uncommitted changes. Commit/stash them or pass --allow-dirty. First entries:\n${meaningful.slice(0, 12).join('\n')}`);
  }
  return root;
}

export function externalWorktreeRoot(repo, runId) {
  const parent = path.dirname(repo);
  const repoName = slugify(path.basename(repo), 40);
  return path.join(parent, '.codex-delivery-worktrees', repoName, runId);
}

export async function createWorktree({ repo, runId, id, baseCommit, branchPrefix = 'codex-delivery' }) {
  const root = externalWorktreeRoot(repo, runId);
  await ensureDir(root);
  const safeId = slugify(id, 50);
  const worktreePath = path.join(root, safeId);
  const branch = `${branchPrefix}/${slugify(runId, 56)}/${safeId}`;
  await git(repo, ['worktree', 'remove', '--force', worktreePath], { rejectOnError: false, timeoutMs: 120000 });
  await rm(worktreePath, { recursive: true, force: true });
  await git(repo, ['worktree', 'prune'], { rejectOnError: false, timeoutMs: 120000 });
  await git(repo, ['branch', '-D', branch], { rejectOnError: false });
  await git(repo, ['worktree', 'add', '-b', branch, worktreePath, baseCommit]);
  return { branch, worktreePath };
}

export async function removeWorktree(repo, worktreePath, branch = null) {
  if (worktreePath) await git(repo, ['worktree', 'remove', '--force', worktreePath], { rejectOnError: false, timeoutMs: 120000 });
  if (branch) await git(repo, ['branch', '-D', branch], { rejectOnError: false });
}

export async function changedPaths(cwd, base = 'HEAD') {
  const tracked = await git(cwd, ['diff', '--name-only', '--relative', base], { rejectOnError: false });
  const staged = await git(cwd, ['diff', '--cached', '--name-only', '--relative', base], { rejectOnError: false });
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard'], { rejectOnError: false });
  return [...new Set([...tracked.stdout.split('\n'), ...staged.stdout.split('\n'), ...untracked.stdout.split('\n')].map((item) => item.trim()).filter(Boolean))].sort();
}

export async function commitAll(cwd, message) {
  const paths = await changedPaths(cwd, 'HEAD');
  if (!paths.length) return null;
  await git(cwd, ['add', '--all']);
  const commit = await git(cwd, ['commit', '-m', message], { rejectOnError: false });
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  return headCommit(cwd);
}

export async function cherryPick(cwd, commit) {
  return git(cwd, ['cherry-pick', commit], { rejectOnError: false, timeoutMs: 180000 });
}

export async function abortCherryPick(cwd) {
  await git(cwd, ['cherry-pick', '--abort'], { rejectOnError: false });
}

export async function hasConflicts(cwd) {
  const result = await git(cwd, ['diff', '--name-only', '--diff-filter=U'], { rejectOnError: false });
  return result.stdout.split('\n').map((item) => item.trim()).filter(Boolean);
}

export async function worktreeList(repo) {
  const result = await git(repo, ['worktree', 'list', '--porcelain']);
  return result.stdout;
}
