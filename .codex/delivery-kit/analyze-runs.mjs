#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const result = { json: false, run: null, root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--json') result.json = true;
    else if (argv[index] === '--run') result.run = argv[++index];
    else if (argv[index] === '--root') result.root = path.resolve(argv[++index]);
  }
  return result;
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function readJsonl(file) {
  try {
    return (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function sumUsage(events) {
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  for (const event of events) {
    if (event.type !== 'codex.run.completed' || !event.usage) continue;
    for (const key of Object.keys(usage)) usage[key] += Number(event.usage[key] ?? 0);
  }
  return usage;
}

function durationMs(start, end) {
  if (!start || !end) return null;
  const value = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(value) ? value : null;
}

function computeParallelism(events) {
  const starts = new Map();
  const intervals = [];
  for (const event of events) {
    if (event.type === 'workstream.started') starts.set(event.workstreamId, new Date(event.at).getTime());
    if (event.type === 'workstream.completed' || event.type === 'workstream.failed') {
      const start = starts.get(event.workstreamId);
      const end = new Date(event.at).getTime();
      if (start && end >= start) intervals.push({ id: event.workstreamId, start, end });
    }
  }
  const points = [];
  for (const interval of intervals) {
    points.push([interval.start, 1]);
    points.push([interval.end, -1]);
  }
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let max = 0;
  let area = 0;
  let last = points[0]?.[0] ?? 0;
  for (const [at, delta] of points) {
    area += active * (at - last);
    active += delta;
    max = Math.max(max, active);
    last = at;
  }
  const span = points.length ? points.at(-1)[0] - points[0][0] : 0;
  return { maxConcurrentWorkstreams: max, averageConcurrentWorkstreams: span ? area / span : 0, intervals };
}

export function analyze(state, events, results) {
  const workstreams = state.workstreams ?? [];
  const codexRuns = events.filter((event) => event.type === 'codex.run.completed');
  const hookEvents = events.filter((event) => String(event.type ?? '').startsWith('codex.hook.'));
  const failedCodexRuns = codexRuns.filter((event) => !event.ok);
  const commandRuns = state.validation?.runs ?? [];
  const criteria = state.verification?.criteria ?? [];
  const findings = (state.reviews ?? []).flatMap((review) => (review.findings ?? []).map((finding) => ({ ...finding, role: review.role })));
  const resultCoverage = Object.fromEntries(workstreams.map((item) => [item.id, results.filter((result) => result.workstreamId === item.id).length]));
  const byRole = {};
  for (const event of codexRuns) {
    const role = event.role ?? 'unknown';
    byRole[role] ??= { runs: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    byRole[role].runs += 1;
    byRole[role].durationMs += Number(event.durationMs ?? 0);
    byRole[role].inputTokens += Number(event.usage?.input_tokens ?? 0);
    byRole[role].outputTokens += Number(event.usage?.output_tokens ?? 0);
    byRole[role].reasoningTokens += Number(event.usage?.reasoning_output_tokens ?? 0);
  }
  return {
    runId: state.runId,
    phase: state.phase,
    objective: state.objective,
    leadTimeMs: durationMs(state.startedAt, state.finishedAt ?? new Date().toISOString()),
    repairIterations: state.repairIteration,
    workstreams: {
      total: workstreams.length,
      integrated: workstreams.filter((item) => item.status === 'integrated').length,
      failed: workstreams.filter((item) => item.status === 'failed').length,
      resultCoverage,
      ...computeParallelism(events),
    },
    quality: {
      validationPassed: commandRuns.filter((run) => run.ok).length,
      validationFailed: commandRuns.filter((run) => !run.ok).length,
      criteriaProven: criteria.filter((item) => item.status === 'proven').length,
      criteriaFailed: criteria.filter((item) => item.status === 'failed').length,
      criteriaUnknown: criteria.filter((item) => item.status === 'unknown').length,
      findingsBySeverity: findings.reduce((acc, finding) => { acc[finding.severity] = (acc[finding.severity] ?? 0) + 1; return acc; }, {}),
    },
    hooks: {
      events: hookEvents.length,
      deniedToolCalls: hookEvents.filter((event) => event.type === 'codex.hook.pre-tool-use' && event.decision === 'deny').length,
      subagentStarts: hookEvents.filter((event) => event.type === 'codex.hook.subagent-start').length,
      byType: hookEvents.reduce((acc, event) => { acc[event.type] = (acc[event.type] ?? 0) + 1; return acc; }, {}),
    },
    codex: {
      runs: codexRuns.length,
      failedRuns: failedCodexRuns.length,
      usage: sumUsage(events),
      byRole,
    },
    results: {
      total: results.length,
      byKind: results.reduce((acc, result) => { acc[result.kind] = (acc[result.kind] ?? 0) + 1; return acc; }, {}),
      linkedToCriteria: results.filter((result) => result.criterionIds?.length).length,
      linkedToWorkstreams: results.filter((result) => result.workstreamId).length,
    },
    final: state.final,
  };
}

function render(report) {
  const usage = report.codex.usage;
  const lines = [
    `# Delivery analytics: ${report.runId}`,
    '',
    `- Phase: **${report.phase}**`,
    `- Lead time: **${report.leadTimeMs ?? 'n/a'} ms**`,
    `- Repair iterations: **${report.repairIterations}**`,
    `- Codex runs: **${report.codex.runs}** (${report.codex.failedRuns} failed)`,
    `- Hook events: **${report.hooks.events}** (${report.hooks.deniedToolCalls} denied tool calls, ${report.hooks.subagentStarts} subagent starts)`,
    `- Tokens: input=${usage.input_tokens}, cached=${usage.cached_input_tokens}, output=${usage.output_tokens}, reasoning=${usage.reasoning_output_tokens}`,
    `- Workstreams: total=${report.workstreams.total}, integrated=${report.workstreams.integrated}, failed=${report.workstreams.failed}`,
    `- Parallelism: max=${report.workstreams.maxConcurrentWorkstreams}, avg=${report.workstreams.averageConcurrentWorkstreams.toFixed(2)}`,
    `- Criteria: proven=${report.quality.criteriaProven}, failed=${report.quality.criteriaFailed}, unknown=${report.quality.criteriaUnknown}`,
    `- Validation: passed=${report.quality.validationPassed}, failed=${report.quality.validationFailed}`,
    `- Findings: ${JSON.stringify(report.quality.findingsBySeverity)}`,
    `- Semantic results: ${report.results.total}, linked to criteria=${report.results.linkedToCriteria}, linked to workstreams=${report.results.linkedToWorkstreams}`,
    '',
    '## Codex usage by role',
    '',
  ];
  for (const [role, data] of Object.entries(report.codex.byRole)) {
    lines.push(`- **${role}**: runs=${data.runs}, duration=${data.durationMs} ms, input=${data.inputTokens}, output=${data.outputTokens}, reasoning=${data.reasoningTokens}`);
  }
  lines.push('', '## Hook events by type', '');
  for (const [type, count] of Object.entries(report.hooks.byType)) lines.push(`- ${type}: ${count}`);
  lines.push('', '## Result coverage by workstream', '');
  for (const [id, count] of Object.entries(report.workstreams.resultCoverage)) lines.push(`- ${id}: ${count}`);
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runsRoot = path.join(options.root, '.codex', 'delivery-runs');
  let runIds;
  if (options.run) runIds = [options.run];
  else {
    runIds = (await readdir(runsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  }
  const reports = [];
  for (const runId of runIds) {
    const root = path.join(runsRoot, runId);
    const state = await readJson(path.join(root, 'state.json'));
    if (!state) continue;
    reports.push(analyze(state, await readJsonl(path.join(root, 'events.jsonl')), await readJsonl(path.join(root, 'results.jsonl'))));
  }
  if (options.json) process.stdout.write(`${JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2)}\n`);
  else process.stdout.write(reports.map(render).join('\n'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`[analyze-runs] ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
