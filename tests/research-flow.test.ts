import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proposal } from '../packages/research/agents.ts';
import { actionRoles, compilePreset, type Action, type Task, type TaskStatus } from '../packages/research/contracts.ts';
import { buildResearchFlow } from '../packages/research/research-flow.ts';

function task(plan: ReturnType<typeof compilePreset>, action: Action, status: TaskStatus, dependencies: string[] = [], suffix = ''): Task {
  const run = { id: 'research', objective: 'Track a research flow', status: 'ACTIVE' as const, plan };
  const given = proposal(run, action, 'director', dependencies, suffix);
  return { id: given.proposal_id, research_id: run.id, role: actionRoles[action], action, status, attempt: 1, proposal: given };
}

test('research flow exposes actual blockers, retries and pending approvals independently of stage completion', () => {
  const plan = compilePreset();
  const design = task(plan, 'DESIGN_EXPERIMENT', 'RUNNING');
  const experiment = task(plan, 'RUN_EXPERIMENT', 'QUEUED', [design.id]);
  const approval = task(plan, 'DELEGATE_NATIVE_REVIEW', 'QUEUED');
  const approvals = [{ id: approval.id, payload: approval.proposal, decision: 'NEEDS_HUMAN_APPROVAL' }];
  const active = buildResearchFlow(plan, 'ACTIVE', [design, experiment], approvals);
  assert.equal(active.current, 'design');
  assert.deepEqual(active.stages.find(stage => stage.id === 'experiment')?.waiting, [{ task: experiment.id, blockers: [design.id] }]);
  assert.equal(active.stages.find(stage => stage.id === 'experiment')?.status, 'BLOCKED');
  assert.deepEqual(active.supportApprovalIds, [approval.id]);
  const failed = { ...experiment, status: 'FAILED' as const };
  const retry = task(plan, 'RUN_EXPERIMENT', 'DONE', [design.id], '-retry');
  const finished = buildResearchFlow(plan, 'INCONCLUSIVE', [{ ...design, status: 'DONE' }, failed, retry], approvals);
  assert.equal(finished.current, 'experiment');
  assert.equal(finished.stages.find(stage => stage.id === 'experiment')?.status, 'DONE');
  assert.equal(finished.stages.find(stage => stage.id === 'validation')?.status, 'NOT_RUN');
  assert.deepEqual(finished.supportApprovalIds, []);
});

test('a planning-only research preset does not display experiment stages', () => {
  const plan = compilePreset({ researchType: 'idea-discovery', strategy: 'deterministic' });
  const outline = task(plan, 'PLAN_PRESET_STUDY', 'DONE');
  const outcome = task(plan, 'COMPLETE', 'DONE', [outline.id]);
  const flow = buildResearchFlow(plan, 'INCONCLUSIVE', [outline, outcome], []);
  assert.deepEqual(flow.stages.map(stage => [stage.id, stage.status]), [['plan', 'DONE'], ['validation', 'DONE']]);
});
