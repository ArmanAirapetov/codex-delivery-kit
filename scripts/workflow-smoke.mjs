#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { activeDeliveryRuns, renderActiveDeliveryWarning } from '../.codex/delivery-kit/cli.mjs';
import { git, runProcess } from '../.codex/delivery-kit/lib/git.mjs';
import { renderProgressLine } from '../.codex/delivery-kit/lib/progress.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const kitRoot = path.resolve(scriptDir, '..');
const temp = await mkdtemp(path.join(os.tmpdir(), 'codex-delivery-smoke-'));
const repo = path.join(temp, 'repo');
const fakeBin = path.join(temp, 'bin');
await mkdir(path.join(repo, 'src'), { recursive: true });
await mkdir(path.join(repo, 'tests'), { recursive: true });
await mkdir(path.join(repo, 'scripts'), { recursive: true });
await mkdir(fakeBin, { recursive: true });
await writeFile(path.join(repo, 'src', 'a.txt'), 'initial\n');
await writeFile(path.join(repo, 'tests', 'a.test.txt'), 'initial\n');
await writeFile(path.join(repo, 'scripts', 'check.mjs'), `
import { readFile } from 'node:fs/promises';
const a = await readFile(new URL('../src/a.txt', import.meta.url), 'utf8');
const t = await readFile(new URL('../tests/a.test.txt', import.meta.url), 'utf8');
if (!a.includes('implemented') || !t.includes('test-added')) process.exit(1);
console.log('validated');
`);
await writeFile(path.join(repo, 'codex-delivery.config.json'), JSON.stringify({ maxParallel: 2, maxRepairs: 1, timeoutMinutes: 2 }, null, 2));
await git(repo, ['init', '-b', 'main']);
await git(repo, ['config', 'user.email', 'smoke@example.com']);
await git(repo, ['config', 'user.name', 'Smoke Test']);
await git(repo, ['add', '--all']);
await git(repo, ['commit', '-m', 'initial']);

const fakeCodex = path.join(fakeBin, 'codex');
await writeFile(fakeCodex, `#!/usr/bin/env python3
import json, os, pathlib, sys, time, uuid
args=sys.argv[1:]
if '--version' in args:
    print('codex-cli 0.143.0-fake')
    sys.exit(0)
def value(flag):
    i=args.index(flag)
    return args[i+1]
schema=pathlib.Path(value('--output-schema')).name
out=pathlib.Path(value('--output-last-message'))
cwd=pathlib.Path(value('--cd'))
prompt=sys.stdin.read()
if 'Stop background smoke' in prompt:
    time.sleep(30)
if schema=='discovery.schema.json':
    result={'status':'completed','summary':'Discovery complete','results':[{'kind':'discovery','title':'Repository mapped','summary':'Relevant files found','details':[],'paths':['src/a.txt','tests/a.test.txt'],'confidence':'high','tags':['smoke']}],'blockingQuestions':[]}
elif schema=='plan.schema.json':
    result={'summary':'Implement source and test in parallel','acceptanceCriteria':['Source behavior is implemented','Regression test artifact is added'],'nonGoals':[],'affectedAreas':['src/a.txt','tests/a.test.txt'],'validationCommands':['node scripts/check.mjs'],'parallelismRationale':'The source and test files do not overlap.','workstreams':[{'id':'W1','title':'Implement source','kind':'implementation','role':'implementer','scope':['src/a.txt'],'dependsOn':[],'criterionIds':['AC-1'],'required':True,'instructions':['Update source marker'],'localValidationCommands':['python -m pytest tests/contracts']},{'id':'W2','title':'Add test artifact','kind':'test','role':'test_engineer','scope':['tests/a.test.txt'],'dependsOn':[],'criterionIds':['AC-2'],'required':True,'instructions':['Update test marker'],'localValidationCommands':['node scripts/check.mjs']}],'risks':[],'assumptions':[]}
elif schema=='worker.schema.json':
    is_resume_smoke='Resume smoke delivery' in prompt
    if '"id": "W1"' in prompt:
        p=cwd/'src'/'a.txt'; p.write_text('implemented\\n'); changed=['src/a.txt']; cid=['AC-1']; title='Source implemented'
        result={'status':'completed','summary':title,'results':[{'kind':'outcome','title':title,'summary':title,'details':[],'paths':changed,'criterionIds':cid,'confidence':'high','tags':['smoke']}],'checks':[{'command':'node scripts/check.mjs','status':'passed','summary':'Fake worker fallback check recorded'},{'command':'python -m pytest tests/contracts','status':'failed','summary':'Failed before collection because pytest is not installed.'},{'command':'python -m pip install --user pytest','status':'failed','summary':'Could not install pytest because pip is not installed.'},{'command':'delivery_status --runId smoke','status':'failed','summary':'Workflow helper is unavailable in strict worker worktree.'}],'changedPathsClaimed':changed,'residualRisks':['Planned pytest command was unavailable in the smoke environment.'],'blockingReason':None}
    elif '"id": "W2"' in prompt:
        p=cwd/'tests'/'a.test.txt'; changed=['tests/a.test.txt']; cid=['AC-2']; title='Test added'
        marker=pathlib.Path(os.environ.get('CODEX_DELIVERY_ROOT', cwd))/'.codex'/'delivery-runs'/os.environ.get('CODEX_DELIVERY_RUN_ID', 'unknown')/'.fake-w2-failed'
        if is_resume_smoke and not marker.exists():
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.write_text('failed-once')
            p.write_text('test-added-first-failed\\n')
            result={'status':'completed','summary':'Intentional first W2 failure','results':[{'kind':'outcome','title':'W2 attempted','summary':'W2 generated a first attempt that should be snapshotted before resume','details':[],'paths':changed,'criterionIds':cid,'confidence':'medium','tags':['smoke','resume']}],'checks':[{'command':'intentional_resume_first_attempt','status':'failed','summary':'Intentional first-attempt failure'}],'changedPathsClaimed':changed,'residualRisks':['Resume should retry W2 without losing this attempt'],'blockingReason':None}
        else:
            p.write_text('test-added\\n')
            result={'status':'completed','summary':title,'results':[{'kind':'outcome','title':title,'summary':title,'details':[],'paths':changed,'criterionIds':cid,'confidence':'high','tags':['smoke']}],'checks':[{'command':'node scripts/check.mjs','status':'passed','summary':'Fake worker check recorded'}],'changedPathsClaimed':changed,'residualRisks':[],'blockingReason':None}
    else:
        changed=[]; cid=[]; title='Integration resolved'
        result={'status':'completed','summary':title,'results':[{'kind':'outcome','title':title,'summary':title,'details':[],'paths':changed,'criterionIds':cid,'confidence':'high','tags':['smoke']}],'checks':[{'command':'node scripts/check.mjs','status':'passed','summary':'Fake worker check recorded'}],'changedPathsClaimed':changed,'residualRisks':[],'blockingReason':None}
elif schema=='verification.schema.json':
    result={'verdict':'passed','summary':'All criteria proven','criteria':[{'id':'AC-1','status':'proven','evidence':['src/a.txt contains implemented'],'paths':['src/a.txt'],'commands':['node scripts/check.mjs']},{'id':'AC-2','status':'proven','evidence':['tests/a.test.txt contains test-added'],'paths':['tests/a.test.txt'],'commands':['node scripts/check.mjs']}],'failedCommands':[],'residualRisks':[]}
elif schema=='review.schema.json':
    result={'verdict':'approved','summary':'No material findings','findings':[],'positiveEvidence':['Validation passed']}
elif schema=='repair-plan.schema.json':
    result={'summary':'No repair expected','workstreams':[]}
else:
    raise SystemExit('unknown schema '+schema)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(result))
thread=str(uuid.uuid4())
print(json.dumps({'type':'thread.started','thread_id':thread}))
print(json.dumps({'type':'turn.started'}))
print(json.dumps({'type':'item.completed','item':{'id':'item_1','type':'agent_message','text':json.dumps(result)}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':100,'cached_input_tokens':20,'output_tokens':30,'reasoning_output_tokens':10}}))
`);
await chmod(fakeCodex, 0o755);

const cli = path.join(kitRoot, '.codex', 'delivery-kit', 'cli.mjs');
const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };

async function latestRun(repoPath) {
  return (await readFile(path.join(repoPath, '.codex', 'delivery-runs', 'latest'), 'utf8')).trim();
}

async function renderedEvents(repoPath, runId, { verbose = false } = {}) {
  const eventsPath = path.join(repoPath, '.codex', 'delivery-runs', runId, 'events.jsonl');
  const text = await readFile(eventsPath, 'utf8');
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => renderProgressLine(JSON.parse(line), { verbose, repo: repoPath }))
    .filter(Boolean)
    .join('\n');
}

function parseJsonOutput(result) {
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

const activeWarningRepo = path.join(temp, 'active-warning-repo');
const activeWarningRun = 'active-warning-run';
await mkdir(path.join(activeWarningRepo, '.codex', 'delivery-runs', activeWarningRun), { recursive: true });
await writeFile(path.join(activeWarningRepo, '.codex', 'delivery-runs', activeWarningRun, 'background.json'), JSON.stringify({
  runId: activeWarningRun,
  repo: activeWarningRepo,
  mode: 'run',
  status: 'running',
  pid: process.pid,
  startedAt: new Date().toISOString(),
  lastHeartbeatAt: new Date().toISOString(),
}, null, 2));
const activeWarnings = await activeDeliveryRuns(activeWarningRepo);
assert.equal(activeWarnings.length, 1);
assert.equal(activeWarnings[0].runId, activeWarningRun);
assert.match(renderActiveDeliveryWarning(activeWarnings), /already|appears active|Codex delivery process/);
assert.match(renderProgressLine({
  type: 'background.heartbeat',
  pid: process.pid,
  mode: 'resume',
  phase: 'implementation',
}), /\[background\] heartbeat.*mode=resume.*phase=implementation/);
assert.match(renderProgressLine({
  type: 'item.started',
  label: 'workstream-W1',
  workstreamId: 'W1',
  item: { type: 'command_execution', commandPreview: 'python -m pytest tests/contracts' },
}), /\[agent\] workstream-W1 command started.*workstream=W1/);
assert.match(renderProgressLine({
  type: 'item.completed',
  label: 'workstream-W1',
  workstreamId: 'W1',
  item: { type: 'agent_message', messageLength: 42 },
}), /\[agent\] workstream-W1 message.*chars=42/);
assert.match(renderProgressLine({
  type: 'item.completed',
  label: 'workstream-W1',
  workstreamId: 'W1',
  item: { type: 'file_change', status: 'completed', paths: ['src/a.txt', 'tests/a.test.txt'] },
}), /\[agent\] workstream-W1 file change completed.*paths=2/);

const staleWarningRun = 'stale-warning-run';
await mkdir(path.join(activeWarningRepo, '.codex', 'delivery-runs', staleWarningRun), { recursive: true });
await writeFile(path.join(activeWarningRepo, '.codex', 'delivery-runs', staleWarningRun, 'state.json'), JSON.stringify({
  runId: staleWarningRun,
  phase: 'implementation',
  objective: 'stale warning smoke',
  baseRef: 'main',
  baseCommit: 'abc',
  repairIteration: 0,
  maxRepairs: 1,
  acceptanceCriteria: [],
  workstreams: [],
  validation: { commands: [], runs: [] },
  reviews: [],
  final: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
}, null, 2));
await writeFile(path.join(activeWarningRepo, '.codex', 'delivery-runs', staleWarningRun, 'background.json'), JSON.stringify({
  runId: staleWarningRun,
  repo: activeWarningRepo,
  mode: 'resume',
  status: 'running',
  pid: 999999999,
  startedAt: new Date().toISOString(),
  lastHeartbeatAt: new Date().toISOString(),
}, null, 2));
const activeWarningsWithStale = await activeDeliveryRuns(activeWarningRepo);
assert.deepEqual(activeWarningsWithStale.map((item) => item.runId), [activeWarningRun]);
await writeFile(path.join(activeWarningRepo, '.codex', 'delivery-runs', staleWarningRun, 'events.jsonl'), `${JSON.stringify({
  at: new Date().toISOString(),
  runId: staleWarningRun,
  phase: 'blocked',
  type: 'workflow.blocked',
  summary: 'previous terminal event',
})}\n`);
await writeFile(path.join(activeWarningRepo, '.codex', 'delivery-runs', staleWarningRun, 'summary.md'), '# stale warning smoke\n');
const staleFollow = await runProcess('node', [cli, 'logs', '--repo', activeWarningRepo, '--run', staleWarningRun, '--follow'], { cwd: kitRoot, env, timeoutMs: 10000, maxOutputBytes: 1024 * 1024 });
if (staleFollow.stdout.trim()) assert.match(staleFollow.stdout, /\[background\] stale/);

const missingObjective = await runProcess('node', [cli, 'run', repo], { cwd: kitRoot, env, timeoutMs: 60000, maxOutputBytes: 1024 * 1024 });
assert.notEqual(missingObjective.code, 0, 'Path-only run should fail before starting a delivery run.');
const missingObjectiveOutput = `${missingObjective.stdout}\n${missingObjective.stderr}`.trim();
if (missingObjectiveOutput) {
  assert.match(missingObjectiveOutput, /requires an objective/i);
  assert.doesNotMatch(missingObjectiveOutput, /\n\s+at\s+/);
}

const run = await runProcess('node', [cli, 'run', '--repo', repo, 'Implement smoke delivery', '--max-parallel', '2'], { cwd: kitRoot, env, timeoutMs: 120000, maxOutputBytes: 10 * 1024 * 1024 });
if (run.code !== 0) {
  console.error(run.stdout);
  console.error(run.stderr);
  throw new Error(`workflow run failed with ${run.code}`);
}
if (run.stderr.trim()) {
  assert.match(run.stderr, /\[run\].*started/);
  assert.match(run.stderr, /\[agent\] discovery-1-explorer started/);
  assert.match(run.stderr, /\[workstream\] W1 started/);
  assert.match(run.stderr, /\[validation\] 1\/1 started/);
  assert.match(run.stderr, /\[final\] accepted/);
}
const runJson = parseJsonOutput(run);
if (runJson) assert.equal(runJson.status, 'accepted');
const latest = await latestRun(repo);
const rendered = await renderedEvents(repo, latest);
assert.match(rendered, /\[run\].*started/);
assert.match(rendered, /\[agent\] discovery-1-explorer started/);
assert.match(rendered, /\[workstream\] W1 started/);
assert.match(rendered, /\[workstream\] W1 nonblocking failed checks=/);
assert.match(rendered, /\[validation\] 1\/1 started/);
assert.match(rendered, /\[final\] accepted/);
const state = JSON.parse(await readFile(path.join(repo, '.codex', 'delivery-runs', latest, 'state.json'), 'utf8'));
const final = state.final;
assert.equal(final.status, 'accepted');
assert.ok(final.integrationCommit);
assert.equal(state.phase, 'accepted');
assert.deepEqual(state.workstreams.map((item) => item.status), ['integrated', 'integrated']);
assert.ok(state.workstreams.find((item) => item.id === 'W1').checks.some((check) => check.status === 'failed'));
assert.equal(state.validation.runs[0].ok, true);
assert.equal(state.verification.verdict, 'passed');
assert.equal(state.reviews.length, 2);
const workerPrompt = await readFile(path.join(repo, '.codex', 'delivery-runs', latest, 'agents', 'workstream-W1', 'prompt.txt'), 'utf8');
const workerRequest = JSON.parse(await readFile(path.join(repo, '.codex', 'delivery-runs', latest, 'agents', 'workstream-W1', 'request.json'), 'utf8'));
const workerResponse = JSON.parse(await readFile(path.join(repo, '.codex', 'delivery-runs', latest, 'agents', 'workstream-W1', 'response.json'), 'utf8'));
assert.match(workerPrompt, /Implement smoke delivery/);
assert.equal(workerRequest.label, 'workstream-W1');
assert.equal(workerResponse.ok, true);
const w1Snapshots = await readdir(path.join(repo, '.codex', 'delivery-runs', latest, 'artifacts', 'workstreams', 'W1', 'snapshots'));
assert.ok(w1Snapshots.some((entry) => entry.includes('completed')));
const integratedSource = await readFile(path.join(final.integrationWorktree, 'src', 'a.txt'), 'utf8');
const integratedTest = await readFile(path.join(final.integrationWorktree, 'tests', 'a.test.txt'), 'utf8');
assert.match(integratedSource, /implemented/);
assert.match(integratedTest, /test-added/);

const analyzer = path.join(kitRoot, '.codex', 'delivery-kit', 'analyze-runs.mjs');
const analysis = await runProcess('node', [analyzer, '--root', repo, '--run', latest, '--json'], { cwd: repo, env, rejectOnError: true });
if (analysis.stdout.trim()) {
  const report = JSON.parse(analysis.stdout);
  assert.equal(report.workstreams.maxConcurrentWorkstreams, 2);
  assert.equal(report.quality.criteriaProven, 2);
  assert.ok(report.codex.runs >= 8);
}

const status = await runProcess('node', [cli, 'status', '--repo', repo, '--run', latest], { cwd: kitRoot, env, rejectOnError: true });
if (status.stdout.trim()) assert.match(status.stdout, /accepted/i);
const cliReport = await runProcess('node', [cli, 'report', '--repo', repo, '--run', latest], { cwd: kitRoot, env, rejectOnError: true });
if (cliReport.stdout.trim()) assert.equal(JSON.parse(cliReport.stdout).runId, latest);
const logs = await runProcess('node', [cli, 'logs', '--repo', repo, '--run', latest], { cwd: kitRoot, env, rejectOnError: true });
if (logs.stdout.trim()) {
  assert.match(logs.stdout, /\[run\].*started/);
  assert.match(logs.stdout, /\[final\] accepted/);
  assert.doesNotMatch(logs.stdout, /Update source marker/);
}
const tailedLogs = await runProcess('node', [cli, 'logs', '--repo', repo, '--run', latest, '--tail', '1'], { cwd: kitRoot, env, rejectOnError: true });
if (tailedLogs.stdout.trim()) {
  assert.doesNotMatch(tailedLogs.stdout, /\[run\].*started/);
  assert.match(tailedLogs.stdout, /\[final\] accepted/);
}
const verboseLogs = await runProcess('node', [cli, 'logs', '--repo', repo, '--run', latest, '--verbose'], { cwd: kitRoot, env, rejectOnError: true });
if (verboseLogs.stdout.trim()) assert.match(verboseLogs.stdout, /log=.*validation-01\.log/);
assert.match(await renderedEvents(repo, latest, { verbose: true }), /log=.*validation-01\.log/);

await runProcess('node', [cli, 'cleanup', '--repo', repo, '--run', latest, '--integration'], { cwd: kitRoot, env, rejectOnError: true });

const quietRun = await runProcess('node', [cli, 'run', '--repo', repo, 'Quiet smoke delivery', '--quiet'], { cwd: kitRoot, env, timeoutMs: 120000, maxOutputBytes: 10 * 1024 * 1024 });
if (quietRun.code !== 0) {
  console.error(quietRun.stdout);
  console.error(quietRun.stderr);
  throw new Error(`quiet workflow run failed with ${quietRun.code}`);
}
assert.equal(quietRun.stderr.trim(), '');
const quietJson = parseJsonOutput(quietRun);
if (quietJson) assert.equal(quietJson.status, 'accepted');
const quietLatest = await latestRun(repo);
await runProcess('node', [cli, 'cleanup', '--repo', repo, '--run', quietLatest, '--integration'], { cwd: kitRoot, env, rejectOnError: true });

const resumeRepo = path.join(temp, 'resume-repo');
await mkdir(path.join(resumeRepo, 'src'), { recursive: true });
await mkdir(path.join(resumeRepo, 'tests'), { recursive: true });
await mkdir(path.join(resumeRepo, 'scripts'), { recursive: true });
await writeFile(path.join(resumeRepo, 'src', 'a.txt'), 'initial\n');
await writeFile(path.join(resumeRepo, 'tests', 'a.test.txt'), 'initial\n');
await writeFile(path.join(resumeRepo, 'scripts', 'check.mjs'), `
import { readFile } from 'node:fs/promises';
const a = await readFile(new URL('../src/a.txt', import.meta.url), 'utf8');
const t = await readFile(new URL('../tests/a.test.txt', import.meta.url), 'utf8');
if (!a.includes('implemented') || !t.includes('test-added')) process.exit(1);
console.log('validated');
`);
await writeFile(path.join(resumeRepo, 'codex-delivery.config.json'), JSON.stringify({ maxParallel: 2, maxRepairs: 1, timeoutMinutes: 2 }, null, 2));
await git(resumeRepo, ['init', '-b', 'main']);
await git(resumeRepo, ['config', 'user.email', 'smoke@example.com']);
await git(resumeRepo, ['config', 'user.name', 'Smoke Test']);
await git(resumeRepo, ['add', '--all']);
await git(resumeRepo, ['commit', '-m', 'initial']);

const blockedRun = await runProcess('node', [cli, 'run', '--repo', resumeRepo, 'Resume smoke delivery', '--max-parallel', '2'], { cwd: kitRoot, env, timeoutMs: 120000, maxOutputBytes: 10 * 1024 * 1024 });
assert.notEqual(blockedRun.code, 0, 'Intentional first resume smoke run should block.');
if (blockedRun.stderr.trim()) assert.match(blockedRun.stderr, /Workstream 'W2' failed/);
const resumeLatest = (await readFile(path.join(resumeRepo, '.codex', 'delivery-runs', 'latest'), 'utf8')).trim();
const blockedState = JSON.parse(await readFile(path.join(resumeRepo, '.codex', 'delivery-runs', resumeLatest, 'state.json'), 'utf8'));
assert.equal(blockedState.phase, 'blocked');
assert.equal(blockedState.workstreams.find((item) => item.id === 'W1').status, 'integrated');
assert.equal(blockedState.workstreams.find((item) => item.id === 'W2').status, 'failed');
const w2Snapshots = await readdir(path.join(resumeRepo, '.codex', 'delivery-runs', resumeLatest, 'artifacts', 'workstreams', 'W2', 'snapshots'));
assert.ok(w2Snapshots.some((entry) => entry.includes('failed')));
await readFile(path.join(resumeRepo, '.codex', 'delivery-runs', resumeLatest, 'agents', 'workstream-W2', 'prompt.txt'), 'utf8');

const resumed = await runProcess('node', [cli, 'resume', '--repo', resumeRepo, '--run', resumeLatest, '--max-parallel', '2'], { cwd: kitRoot, env, timeoutMs: 120000, maxOutputBytes: 10 * 1024 * 1024 });
if (resumed.code !== 0) {
  console.error(resumed.stdout);
  console.error(resumed.stderr);
  throw new Error(`resume run failed with ${resumed.code}`);
}
const resumedState = JSON.parse(await readFile(path.join(resumeRepo, '.codex', 'delivery-runs', resumeLatest, 'state.json'), 'utf8'));
const resumedFinal = resumedState.final;
assert.equal(resumedFinal.status, 'accepted');
assert.equal(resumedState.phase, 'accepted');
assert.equal(resumedState.resumes.length, 1);
assert.equal(resumedState.workstreams.find((item) => item.id === 'W2').status, 'integrated');
assert.ok(resumedState.workstreams.find((item) => item.id === 'W2').attempts.length >= 2);
await readFile(path.join(resumeRepo, '.codex', 'delivery-runs', resumeLatest, 'agents', 'workstream-W2-attempt-2', 'prompt.txt'), 'utf8');

await runProcess('node', [cli, 'cleanup', '--repo', resumeRepo, '--run', resumeLatest, '--integration'], { cwd: kitRoot, env, rejectOnError: true });

const backgroundRepo = path.join(temp, 'background-repo');
await mkdir(path.join(backgroundRepo, 'src'), { recursive: true });
await mkdir(path.join(backgroundRepo, 'tests'), { recursive: true });
await mkdir(path.join(backgroundRepo, 'scripts'), { recursive: true });
await writeFile(path.join(backgroundRepo, 'src', 'a.txt'), 'initial\n');
await writeFile(path.join(backgroundRepo, 'tests', 'a.test.txt'), 'initial\n');
await writeFile(path.join(backgroundRepo, 'scripts', 'check.mjs'), `
import { readFile } from 'node:fs/promises';
const a = await readFile(new URL('../src/a.txt', import.meta.url), 'utf8');
const t = await readFile(new URL('../tests/a.test.txt', import.meta.url), 'utf8');
if (!a.includes('implemented') || !t.includes('test-added')) process.exit(1);
console.log('validated');
`);
await writeFile(path.join(backgroundRepo, 'codex-delivery.config.json'), JSON.stringify({ maxParallel: 2, maxRepairs: 1, timeoutMinutes: 2 }, null, 2));
await git(backgroundRepo, ['init', '-b', 'main']);
await git(backgroundRepo, ['config', 'user.email', 'smoke@example.com']);
await git(backgroundRepo, ['config', 'user.name', 'Smoke Test']);
await git(backgroundRepo, ['add', '--all']);
await git(backgroundRepo, ['commit', '-m', 'initial']);

const backgroundStart = await runProcess('node', [cli, 'run', '--repo', backgroundRepo, 'Background smoke delivery', '--background', '--max-parallel', '2'], { cwd: kitRoot, env, timeoutMs: 60000, maxOutputBytes: 1024 * 1024 });
if (backgroundStart.code !== 0) {
  console.error(backgroundStart.stdout);
  console.error(backgroundStart.stderr);
  throw new Error(`background start failed with ${backgroundStart.code}`);
}
assert.equal(backgroundStart.stderr.trim(), '');
const backgroundRunId = parseJsonOutput(backgroundStart)?.runId ?? await latestRun(backgroundRepo);
const backgroundMeta = JSON.parse(await readFile(path.join(backgroundRepo, '.codex', 'delivery-runs', backgroundRunId, 'background.json'), 'utf8'));
assert.ok(backgroundMeta.pid);
assert.equal(backgroundMeta.mode, 'run');
await readFile(path.join(backgroundRepo, '.codex', 'delivery-runs', backgroundRunId, 'background.json'), 'utf8');
const followed = await runProcess('node', [cli, 'logs', '--repo', backgroundRepo, '--run', backgroundMeta.runId, '--follow'], { cwd: kitRoot, env, timeoutMs: 120000, maxOutputBytes: 10 * 1024 * 1024 });
if (followed.code !== 0) {
  console.error(followed.stdout);
  console.error(followed.stderr);
  throw new Error(`logs --follow failed with ${followed.code}`);
}
if (followed.stdout.trim()) {
  assert.match(followed.stdout, /\[background\] started/);
  assert.match(followed.stdout, /\[final\] accepted/);
}
const backgroundRendered = await renderedEvents(backgroundRepo, backgroundMeta.runId);
assert.match(backgroundRendered, /\[background\] started/);
assert.match(backgroundRendered, /\[final\] accepted/);
const backgroundState = JSON.parse(await readFile(path.join(backgroundRepo, '.codex', 'delivery-runs', backgroundMeta.runId, 'state.json'), 'utf8'));
assert.equal(backgroundState.phase, 'accepted');
const backgroundStatus = await runProcess('node', [cli, 'status', '--repo', backgroundRepo, '--run', backgroundMeta.runId], { cwd: kitRoot, env, rejectOnError: true });
if (backgroundStatus.stdout.trim()) {
  assert.match(backgroundStatus.stdout, /## Background/);
  assert.match(backgroundStatus.stdout, /Status:/);
}
const acceptedBackgroundRecord = JSON.parse(await readFile(path.join(backgroundRepo, '.codex', 'delivery-runs', backgroundMeta.runId, 'background.json'), 'utf8'));
assert.match(acceptedBackgroundRecord.status, /exited|running/);
await runProcess('node', [cli, 'cleanup', '--repo', backgroundRepo, '--run', backgroundMeta.runId, '--integration'], { cwd: kitRoot, env, rejectOnError: true });

const stopRepo = path.join(temp, 'stop-repo');
await mkdir(path.join(stopRepo, 'src'), { recursive: true });
await mkdir(path.join(stopRepo, 'tests'), { recursive: true });
await mkdir(path.join(stopRepo, 'scripts'), { recursive: true });
await writeFile(path.join(stopRepo, 'src', 'a.txt'), 'initial\n');
await writeFile(path.join(stopRepo, 'tests', 'a.test.txt'), 'initial\n');
await writeFile(path.join(stopRepo, 'scripts', 'check.mjs'), `
import { readFile } from 'node:fs/promises';
const a = await readFile(new URL('../src/a.txt', import.meta.url), 'utf8');
const t = await readFile(new URL('../tests/a.test.txt', import.meta.url), 'utf8');
if (!a.includes('implemented') || !t.includes('test-added')) process.exit(1);
console.log('validated');
`);
await writeFile(path.join(stopRepo, 'codex-delivery.config.json'), JSON.stringify({ maxParallel: 2, maxRepairs: 1, timeoutMinutes: 2 }, null, 2));
await git(stopRepo, ['init', '-b', 'main']);
await git(stopRepo, ['config', 'user.email', 'smoke@example.com']);
await git(stopRepo, ['config', 'user.name', 'Smoke Test']);
await git(stopRepo, ['add', '--all']);
await git(stopRepo, ['commit', '-m', 'initial']);

const stopStart = await runProcess('node', [cli, 'run', '--repo', stopRepo, 'Stop background smoke', '--background'], { cwd: kitRoot, env, timeoutMs: 60000, maxOutputBytes: 1024 * 1024 });
if (stopStart.code !== 0) {
  console.error(stopStart.stdout);
  console.error(stopStart.stderr);
  throw new Error(`stop background start failed with ${stopStart.code}`);
}
const stopRunId = parseJsonOutput(stopStart)?.runId ?? await latestRun(stopRepo);
const stopMeta = JSON.parse(await readFile(path.join(stopRepo, '.codex', 'delivery-runs', stopRunId, 'background.json'), 'utf8'));
await delay(1000);
const stopped = await runProcess('node', [cli, 'stop', '--repo', stopRepo, '--run', stopMeta.runId], { cwd: kitRoot, env, timeoutMs: 15000, maxOutputBytes: 1024 * 1024 });
if (stopped.code !== 0) {
  console.error(stopped.stdout);
  console.error(stopped.stderr);
  throw new Error(`stop command failed with ${stopped.code}`);
}
const stopResult = parseJsonOutput(stopped);
if (stopResult) {
  assert.equal(stopResult.signalSent, true);
  assert.match(stopResult.status, /stopped|stop_requested/);
}
const stoppedMeta = JSON.parse(await readFile(path.join(stopRepo, '.codex', 'delivery-runs', stopMeta.runId, 'background.json'), 'utf8'));
assert.match(stoppedMeta.status, /stopped|stop_requested/);
const stopLogs = await runProcess('node', [cli, 'logs', '--repo', stopRepo, '--run', stopMeta.runId], { cwd: kitRoot, env, rejectOnError: true });
if (stopLogs.stdout.trim()) assert.match(stopLogs.stdout, /\[background\] stop requested/);
if (stoppedMeta.status === 'stopped' && stopLogs.stdout.trim()) assert.match(stopLogs.stdout, /\[background\] stopped/);
assert.match(await renderedEvents(stopRepo, stopMeta.runId), /\[background\] stop requested/);
if (stoppedMeta.status === 'stopped') assert.match(await renderedEvents(stopRepo, stopMeta.runId), /\[background\] stopped/);
console.log('workflow-smoke: OK');
