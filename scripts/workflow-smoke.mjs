#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, runProcess } from '../.codex/delivery-kit/lib/git.mjs';

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
import json, os, pathlib, sys, uuid
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
if schema=='discovery.schema.json':
    result={'status':'completed','summary':'Discovery complete','results':[{'kind':'discovery','title':'Repository mapped','summary':'Relevant files found','details':[],'paths':['src/a.txt','tests/a.test.txt'],'confidence':'high','tags':['smoke']}],'blockingQuestions':[]}
elif schema=='plan.schema.json':
    result={'summary':'Implement source and test in parallel','acceptanceCriteria':['Source behavior is implemented','Regression test artifact is added'],'nonGoals':[],'affectedAreas':['src/a.txt','tests/a.test.txt'],'validationCommands':['node scripts/check.mjs'],'parallelismRationale':'The source and test files do not overlap.','workstreams':[{'id':'W1','title':'Implement source','kind':'implementation','role':'implementer','scope':['src/a.txt'],'dependsOn':[],'criterionIds':['AC-1'],'required':True,'instructions':['Update source marker'],'localValidationCommands':['node scripts/check.mjs']},{'id':'W2','title':'Add test artifact','kind':'test','role':'test_engineer','scope':['tests/a.test.txt'],'dependsOn':[],'criterionIds':['AC-2'],'required':True,'instructions':['Update test marker'],'localValidationCommands':['node scripts/check.mjs']}],'risks':[],'assumptions':[]}
elif schema=='worker.schema.json':
    if '"id": "W1"' in prompt:
        p=cwd/'src'/'a.txt'; p.write_text('implemented\\n'); changed=['src/a.txt']; cid=['AC-1']; title='Source implemented'
    elif '"id": "W2"' in prompt:
        p=cwd/'tests'/'a.test.txt'; p.write_text('test-added\\n'); changed=['tests/a.test.txt']; cid=['AC-2']; title='Test added'
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
const run = await runProcess('node', [cli, 'run', 'Implement smoke delivery', '--max-parallel', '2'], { cwd: repo, env, timeoutMs: 120000, maxOutputBytes: 10 * 1024 * 1024 });
if (run.code !== 0) {
  console.error(run.stdout);
  console.error(run.stderr);
  throw new Error(`workflow run failed with ${run.code}`);
}
const final = JSON.parse(run.stdout.trim());
assert.equal(final.status, 'accepted');
assert.ok(final.integrationCommit);
const latest = (await readFile(path.join(repo, '.codex', 'delivery-runs', 'latest'), 'utf8')).trim();
const state = JSON.parse(await readFile(path.join(repo, '.codex', 'delivery-runs', latest, 'state.json'), 'utf8'));
assert.equal(state.phase, 'accepted');
assert.deepEqual(state.workstreams.map((item) => item.status), ['integrated', 'integrated']);
assert.equal(state.validation.runs[0].ok, true);
assert.equal(state.verification.verdict, 'passed');
assert.equal(state.reviews.length, 2);
const integratedSource = await readFile(path.join(final.integrationWorktree, 'src', 'a.txt'), 'utf8');
const integratedTest = await readFile(path.join(final.integrationWorktree, 'tests', 'a.test.txt'), 'utf8');
assert.match(integratedSource, /implemented/);
assert.match(integratedTest, /test-added/);

const analyzer = path.join(kitRoot, '.codex', 'delivery-kit', 'analyze-runs.mjs');
const analysis = await runProcess('node', [analyzer, '--root', repo, '--run', latest, '--json'], { cwd: repo, env, rejectOnError: true });
const report = JSON.parse(analysis.stdout);
assert.equal(report.workstreams.maxConcurrentWorkstreams, 2);
assert.equal(report.quality.criteriaProven, 2);
assert.ok(report.codex.runs >= 8);

await runProcess('node', [cli, 'cleanup', '--run', latest, '--integration'], { cwd: repo, env, rejectOnError: true });
console.log('workflow-smoke: OK');
