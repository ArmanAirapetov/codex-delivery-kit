import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { appendEvent, collectUsage, ensureDir, parseJsonResult, redactText, sanitizeEvent, sha256 } from './core.mjs';

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const MODEL_CAPACITY_PATTERN = /selected model is at capacity/i;

export async function codexAvailable(binary = 'codex') {
  return new Promise((resolve) => {
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', () => resolve({ available: false, version: null }));
    child.on('close', (code) => resolve({ available: code === 0, version: output.trim() || null }));
  });
}

function signalProcessTree(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      // Best-effort cleanup: process groups can already be gone or partially reaped.
    }
  }
}

function appendCaptured(current, value) {
  const next = current + value;
  return next.length > MAX_CAPTURE_BYTES ? next.slice(-MAX_CAPTURE_BYTES) : next;
}

function isModelCapacityFailure({ code, timedOut, stderr, events }) {
  if (code === 0 || timedOut) return false;
  return MODEL_CAPACITY_PATTERN.test(`${stderr}\n${JSON.stringify(events)}`);
}

function retryCount(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export async function runCodex({
  binary = 'codex',
  cwd,
  prompt,
  schemaPath,
  outputDir,
  repoRoot,
  state,
  label,
  role,
  workstreamId = null,
  sandbox = 'read-only',
  model = null,
  reasoningEffort = null,
  timeoutMs = 60 * 60 * 1000,
  retainRaw = false,
  extraConfig = [],
  maxCapacityRetries = 2,
  capacityRetryDelayMs = 15_000,
}) {
  await ensureDir(outputDir);
  const finalPath = path.join(outputDir, 'final.json');
  const promptPath = path.join(outputDir, 'prompt.txt');
  const requestPath = path.join(outputDir, 'request.json');
  const responsePath = path.join(outputDir, 'response.json');
  const stderrPath = path.join(outputDir, 'stderr.log');
  const rawPath = path.join(outputDir, 'raw.jsonl');
  const promptHash = sha256(prompt);
  await writeFile(promptPath, prompt, 'utf8');
  await writeFile(requestPath, JSON.stringify({
    label,
    role,
    workstreamId,
    cwd,
    schemaPath,
    sandbox,
    model,
    reasoningEffort,
    timeoutMs,
    retainRaw,
    maxCapacityRetries,
    capacityRetryDelayMs,
    promptPath: path.basename(promptPath),
    promptHash,
    promptLength: prompt.length,
  }, null, 2), 'utf8');
  await appendEvent(repoRoot, state, {
    type: 'codex.run.started',
    label,
    role,
    workstreamId,
    sandbox,
    cwd,
    promptHash,
  });

  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--dangerously-bypass-hook-trust',
    '--sandbox', sandbox,
    '--cd', cwd,
    '--output-schema', schemaPath,
    '--output-last-message', finalPath,
  ];
  if (model) args.push('--model', model);
  if (reasoningEffort) args.push('-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  for (const override of extraConfig) args.push('-c', override);
  args.push('-');

  const startedAt = Date.now();
  const events = [];
  let stderr = '';
  let raw = '';
  let timedOut = false;
  let result = { code: -1, signal: null };
  const attempts = [];
  const retryLimit = retryCount(maxCapacityRetries, 2);
  const retryDelayMs = retryCount(capacityRetryDelayMs, 15_000);

  for (let attemptIndex = 0; attemptIndex <= retryLimit; attemptIndex += 1) {
    let attemptStderr = '';
    let stdoutBuffer = '';
    let attemptTimedOut = false;
    const attemptEvents = [];
    result = await new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        cwd,
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          CODEX_DELIVERY_RUN_ID: state.runId,
          CODEX_DELIVERY_ROOT: repoRoot,
          CODEX_DELIVERY_ROLE: role,
          CODEX_DELIVERY_WORKSTREAM: workstreamId ?? '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const consumeLine = async (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (retainRaw) raw += `${trimmed}\n`;
        try {
          const event = JSON.parse(trimmed);
          events.push(event);
          attemptEvents.push(event);
          await appendEvent(repoRoot, state, {
            ...sanitizeEvent(event),
            label,
            role,
            workstreamId,
          });
        } catch {
          await appendEvent(repoRoot, state, {
            type: 'codex.output.unparsed',
            label,
            role,
            workstreamId,
            preview: redactText(trimmed, 500),
          });
        }
      };
      let chain = Promise.resolve();
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) chain = chain.then(() => consumeLine(line));
      });
      child.stderr.on('data', (chunk) => {
        attemptStderr = appendCaptured(attemptStderr, chunk.toString());
      });
      child.on('error', reject);
      let killTimer = null;
      const timer = setTimeout(() => {
        attemptTimedOut = true;
        signalProcessTree(child, 'SIGTERM');
        killTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), 5000);
        killTimer.unref();
      }, timeoutMs);
      child.on('close', async (code, signal) => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (process.platform !== 'win32') {
          try {
            signalProcessTree(child, 'SIGTERM');
          } catch {
            // Best-effort cleanup for helper descendants that survived codex exit.
          }
        }
        if (stdoutBuffer.trim()) chain = chain.then(() => consumeLine(stdoutBuffer));
        await chain;
        resolve({ code: code ?? -1, signal });
      });
      child.stdin.end(prompt);
    });

    timedOut = attemptTimedOut;
    stderr = appendCaptured(stderr, `${stderr ? '\n' : ''}[attempt ${attemptIndex + 1}]\n${attemptStderr}`);
    const capacityFailure = isModelCapacityFailure({ code: result.code, timedOut, stderr: attemptStderr, events: attemptEvents });
    attempts.push({
      number: attemptIndex + 1,
      exitCode: result.code,
      signal: result.signal,
      timedOut,
      modelCapacity: capacityFailure,
    });
    if (!capacityFailure || attemptIndex === retryLimit) break;

    const delayMs = retryDelayMs * (2 ** attemptIndex);
    await appendEvent(repoRoot, state, {
      type: 'codex.run.retry',
      label,
      role,
      workstreamId,
      attempt: attemptIndex + 1,
      nextAttempt: attemptIndex + 2,
      totalAttempts: retryLimit + 1,
      delayMs,
      reason: 'selected model is at capacity',
    });
    if (delayMs > 0) await delay(delayMs);
  }

  await writeFile(stderrPath, redactText(stderr, MAX_CAPTURE_BYTES), 'utf8');
  if (retainRaw) await writeFile(rawPath, raw, 'utf8');

  let finalText = '';
  let final = null;
  try {
    finalText = await readFile(finalPath, 'utf8');
    final = parseJsonResult(finalText);
  } catch (error) {
    await appendEvent(repoRoot, state, {
      type: 'codex.result.invalid',
      label,
      role,
      workstreamId,
      error: redactText(error.message, 800),
    });
  }
  const usage = collectUsage(events);
  const durationMs = Date.now() - startedAt;
  const ok = result.code === 0 && !timedOut && final !== null;
  await appendEvent(repoRoot, state, {
    type: 'codex.run.completed',
    label,
    role,
    workstreamId,
    ok,
    exitCode: result.code,
    signal: result.signal,
    timedOut,
    durationMs,
    usage,
    attempts,
    finalHash: finalText ? sha256(finalText) : null,
  });
  await writeFile(responsePath, JSON.stringify({
    ok,
    exitCode: result.code,
    signal: result.signal,
    timedOut,
    durationMs,
    usage,
    attempts,
    finalPath: path.basename(finalPath),
    stderrPath: path.basename(stderrPath),
    rawPath: retainRaw ? path.basename(rawPath) : null,
    finalHash: finalText ? sha256(finalText) : null,
  }, null, 2), 'utf8');
  return {
    ok,
    exitCode: result.code,
    signal: result.signal,
    timedOut,
    durationMs,
    usage,
    attempts,
    threadId: events.find((event) => event.type === 'thread.started')?.thread_id ?? null,
    events,
    final,
    finalPath,
    stderrPath,
    rawPath: retainRaw ? rawPath : null,
  };
}
