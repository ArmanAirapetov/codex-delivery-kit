#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  createInitialState,
  globToRegExp,
  instantiateWorkstreams,
  readyWorkstreams,
  scopeMatches,
  scopesMayOverlap,
  serializeOverlappingWorkstreams,
  topologicalOrder,
  transition,
  validateWorkstreams,
} from '../.codex/delivery-kit/lib/core.mjs';

const criteria = new Set(['AC-1', 'AC-2']);
const specs = [
  { id: 'W1', title: 'Backend', role: 'implementer', scope: ['src/api/**'], dependsOn: [], criterionIds: ['AC-1'], required: true },
  { id: 'W2', title: 'Tests', role: 'test_engineer', scope: ['tests/**'], dependsOn: [], criterionIds: ['AC-2'], required: true },
  { id: 'W3', title: 'Integration', role: 'integrator', scope: ['src/api/**'], dependsOn: ['W1', 'W2'], criterionIds: ['AC-1', 'AC-2'], required: true },
];
validateWorkstreams(specs, criteria);
assert.deepEqual(topologicalOrder(specs), ['W1', 'W2', 'W3']);
const workstreams = instantiateWorkstreams(specs);
assert.deepEqual(readyWorkstreams(workstreams).map((item) => item.id), ['W1', 'W2']);
workstreams[0].status = 'integrated';
workstreams[1].status = 'integrated';
assert.deepEqual(readyWorkstreams(workstreams).map((item) => item.id), ['W3']);
assert.equal(scopeMatches('src/api/auth.ts', ['src/api/**']), true);
assert.equal(scopeMatches('src/ui/app.tsx', ['src/api/**']), false);
assert.equal(globToRegExp('tests/**/*.test.ts').test('tests/unit/a.test.ts'), true);
assert.equal(scopesMayOverlap(['src/**'], ['src/api/**']), true);
assert.equal(scopesMayOverlap(['src/api/**'], ['tests/**']), false);

assert.throws(() => validateWorkstreams([
  { id: 'A1', title: 'A', role: 'implementer', scope: ['src/**'], dependsOn: [], criterionIds: ['AC-1'], required: true },
  { id: 'A2', title: 'B', role: 'implementer', scope: ['src/api/**'], dependsOn: [], criterionIds: ['AC-2'], required: true },
], criteria), /overlapping scopes/);
const serializedOverlap = serializeOverlappingWorkstreams([
  { id: 'A1', title: 'A', role: 'implementer', scope: ['src/**'], dependsOn: [], criterionIds: ['AC-1'], required: true },
  { id: 'A2', title: 'B', role: 'implementer', scope: ['src/api/**'], dependsOn: [], criterionIds: ['AC-2'], required: true },
]);
assert.deepEqual(serializedOverlap.addedDependencies, [{ workstreamId: 'A2', dependsOn: 'A1' }]);
validateWorkstreams(serializedOverlap.workstreams, criteria);
const alreadyOrderedOverlap = serializeOverlappingWorkstreams([
  { id: 'A1', title: 'A', role: 'implementer', scope: ['src/**'], dependsOn: ['A2'], criterionIds: ['AC-1'], required: true },
  { id: 'A2', title: 'B', role: 'implementer', scope: ['src/api/**'], dependsOn: [], criterionIds: ['AC-2'], required: true },
]);
assert.deepEqual(alreadyOrderedOverlap.addedDependencies, []);
validateWorkstreams(alreadyOrderedOverlap.workstreams, criteria);

assert.throws(() => validateWorkstreams([
  { id: 'C1', title: 'A', role: 'implementer', scope: ['a/**'], dependsOn: ['C2'], criterionIds: ['AC-1'], required: true },
  { id: 'C2', title: 'B', role: 'implementer', scope: ['b/**'], dependsOn: ['C1'], criterionIds: ['AC-2'], required: true },
], criteria), /cycle/);

const state = createInitialState({ runId: 'test', objective: 'test', repoRoot: '/tmp/repo', baseRef: 'main', baseCommit: 'abc' });
transition(state, 'discovery');
transition(state, 'planning');
transition(state, 'implementation');
transition(state, 'integration');
transition(state, 'verification');
transition(state, 'review');
transition(state, 'accepted');
assert.equal(state.phase, 'accepted');
assert.throws(() => transition(state, 'repair'), /Illegal phase transition/);

console.log('core-smoke: OK');
