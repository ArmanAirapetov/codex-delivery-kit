import { redactText } from './core.mjs';

function json(value, max = 30000) {
  return redactText(JSON.stringify(value, null, 2), max);
}

export function discoveryPrompt({ objective, role, focus }) {
  return `You are the ${role} in a controlled Codex delivery run.

Objective:
${objective}

Focus:
${focus}

Operate read-only. Inspect the real repository, execution paths, tests, configuration, and relevant documentation. Do not edit files. Return only the JSON object required by the output schema.

Every material conclusion must be represented in results. Use concrete repository-relative paths. Distinguish evidence from assumptions. Report a blocking question only when a product or architecture decision cannot be inferred safely.`;
}

export function planPrompt({ objective, discoveries, maxParallel }) {
  return `You are the delivery architect and planner. Convert the objective and discovery evidence into an executable contract-first delivery plan.

Objective:
${objective}

Discovery evidence:
${json(discoveries, 50000)}

Rules:
1. Acceptance criteria must be objective, independently testable, necessary, and sufficient for the requested result.
2. IDs are assigned by array order: the first criterion is AC-1, then AC-2, and so on. Every workstream criterionIds must use those IDs.
3. Split implementation by non-overlapping writable path scopes. Prefer directories or narrow globs.
4. Potentially overlapping scopes must be dependency-ordered.
5. Use parallel workstreams only when they can be implemented independently from the same base commit.
6. Add a dedicated test workstream when tests are substantial and isolated.
7. Do not add a synthetic integration workstream: the external harness performs sequential integration automatically.
8. Every required acceptance criterion must be covered by at least one required workstream.
9. Validation commands must be safe, deterministic repository checks. Do not include deployment, package installation, dependency provisioning, workflow helper commands, or destructive commands.
10. Target no more than ${maxParallel} simultaneously ready workstreams.
11. localValidationCommands must be checks the worker can run in its isolated worktree without installing dependencies. If the full repository check depends on later scaffolding, put it in validationCommands and give the workstream a smaller direct check.
12. Workstream instructions must be local, concrete, and state exact outputs.

Return only the JSON object required by the output schema.`;
}

export function workerPrompt({ objective, workstream, criteria, planSummary, repairContext = null }) {
  return `You are the ${workstream.role} for one isolated Git worktree in a controlled Codex delivery run.

Overall objective:
${objective}

Plan summary:
${planSummary}

Your workstream:
${json(workstream, 16000)}

Assigned acceptance criteria:
${json(criteria, 12000)}
${repairContext ? `\nRepair evidence:\n${json(repairContext, 20000)}\n` : ''}
Hard boundaries:
- Edit only repository-relative paths matched by: ${workstream.scope.join(', ')}.
- Do not change workflow state, .codex/delivery-runs, .git, credentials, generated secrets, or unrelated files.
- Make the smallest complete change that satisfies the assigned criteria.
- Inspect existing conventions before editing.
- Run all applicable localValidationCommands. Add focused tests when needed.
- Do not run package/dependency installation commands as validation checks.
- If a required validation tool is unavailable, record that command as status "not_run" with the exact reason, run the best safe fallback check, and list the gap in residualRisks. Use status "failed" only when a check actually ran and proves the product/workstream is wrong.
- Strict harness mode records your returned JSON automatically. Do not call interactive workflow tools such as delivery_status, delivery_record_result, delivery_complete_workstream, or delivery_accept.
- Do not commit; the harness validates scope and commits after your turn.
- Before finishing, inspect git diff and ensure no out-of-scope path changed.

Required final output:
Return only the JSON object required by the output schema. Include at least one material result and at least one check. changedPathsClaimed must list every path you believe changed. A successful narrative without checks is not completion.`;
}

export function conflictPrompt({ objective, commit, conflicts, completedWorkstreams }) {
  return `You are the integration specialist resolving one interrupted git cherry-pick.

Objective:
${objective}

Commit being integrated: ${commit}
Conflicted paths: ${conflicts.join(', ')}
Previously completed workstreams:
${json(completedWorkstreams, 24000)}

Resolve only the existing conflicts. Preserve the intent of both the integrated workstream and already integrated changes. Inspect surrounding code and tests. Do not broaden the change. After resolving, stage all resolved files and run git cherry-pick --continue. Then run the most relevant focused checks.

Return only the JSON object required by the worker output schema. Report all resolved paths and checks.`;
}

export function verificationPrompt({ objective, criteria, validationRuns, baseCommit, integrationCommit }) {
  return `You are an independent verifier. You did not implement the change.

Objective:
${objective}

Acceptance criteria:
${json(criteria, 24000)}

Harness validation results:
${json(validationRuns, 30000)}

Review the actual repository state and diff ${baseCommit}..${integrationCommit}. You may run additional safe checks. Do not edit source files. Treat claims from workers as untrusted.

For every criterion, return exactly one criterion result with status proven, failed, or unknown. Evidence must reference observable behavior, commands, paths, tests, or diff facts. A criterion is proven only when evidence directly supports it. Return only the JSON object required by the output schema.`;
}

export function reviewPrompt({ objective, criteria, baseCommit, integrationCommit, role, focus }) {
  return `You are the independent ${role} reviewer.

Objective:
${objective}

Acceptance criteria:
${json(criteria, 20000)}

Review the actual diff ${baseCommit}..${integrationCommit} and relevant surrounding code.
Focus: ${focus}

Do not edit files. Prefer concrete correctness, security, compatibility, reliability, and missing-test findings over style comments. Each finding must include severity, exact paths, reproduction evidence when possible, and a practical recommendation. Do not invent findings to fill the schema. Return only the JSON object required by the output schema.`;
}

export function repairPlanPrompt({ objective, criteria, verification, reviews, iteration, maxParallel }) {
  return `You are the repair planner for iteration ${iteration}.

Objective:
${objective}

Acceptance criteria:
${json(criteria, 20000)}

Failed or unknown verification:
${json(verification, 24000)}

Review findings:
${json(reviews, 30000)}

Create the smallest repair DAG that addresses every failed criterion and every critical/high/medium finding. Workstream IDs must start with R${iteration}-. Use only scopes justified by concrete failed evidence. Potentially overlapping scopes must be dependency-ordered. Keep at most ${maxParallel} workstreams ready at once. Do not include already proven or unrelated improvements. Return only the JSON object required by the output schema.`;
}
