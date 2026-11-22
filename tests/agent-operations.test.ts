import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockAgentRuntime, proposal, type AgentContext, type AgentRuntime } from '../packages/research/agents.ts';
import { compilePreset, snapshotRevisions } from '../packages/research/contracts.ts';
import { ResearchOrchestrator } from '../packages/research/orchestrator.ts';
import { comparePaired, type TrialMetrics } from '../packages/research/revisions.ts';
import { parseMeasurements, type Row } from '../packages/research/science.ts';
import { openStore } from '../packages/research/store.ts';
import { betaBinomialConfirmation, checkBackdoor } from '../packages/scientific-reasoning/causal.ts';

test('a stalled Director receives one persistent independent review and cannot spin indefinitely', async () => {
  const store = await openStore(':memory:');
  class StalledDirector extends MockAgentRuntime {
    override async think(context: AgentContext, signal: AbortSignal) {
      if (context.claim.task.action === 'REPLAN') return { proposals: [] };
      return super.think(context, signal);
    }
  }
  try {
    const lab = new ResearchOrchestrator(store, new StalledDirector());
    const run = store.create('Diagnose a stalled manufacturing study', compilePreset());
    const view = await lab.runToCheckpoint(run.id);
    assert.equal(view.run.status, 'EXHAUSTED');
    const reviews = view.tasks.filter(task => task.action === 'REVIEW_STAGNATION');
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].role, 'meta-reviewer');
    assert.equal(reviews[0].status, 'DONE');
    assert.equal(view.scientificSim.findings[0].category, 'RESEARCH_STAGNATION');
    assert.equal((await lab.runToCheckpoint(run.id)).tasks.length, view.tasks.length);
  } finally { store.close(); }
});

test('resident identity persists across projects while private state and delegation inboxes remain scoped', async () => {
  const store = await openStore(':memory:');
  try {
    const lab = new ResearchOrchestrator(store, new MockAgentRuntime());
    const run = store.create('Examine a manufacturing dataset independently', compilePreset());
    const view = await lab.runToCheckpoint(run.id);
    const other = store.create('Another manufacturing run', compilePreset());
    const old = store.member(run.id, 'hypothesis'), next = store.member(other.id, 'hypothesis');
    assert.ok(old.agent_id);
    assert.equal(old.agent_id, next.agent_id);
    assert.notEqual(old.session_key, next.session_key);
    assert.match(view.residents.find(member => member.role === 'hypothesis')?.seed?.content_hash ?? '', /^[a-f0-9]{64}$/);
    assert.ok(view.messages.some(message => message.kind === 'TASK_DELEGATED' && message.sender === 'hypothesis'));
    assert.ok(store.messages(run.id, 'hypothesis').every(message => message.recipient === 'hypothesis'));
    assert.ok(store.messages(run.id, 'hypothesis').some(message => message.kind === 'TASK_RESULT'));
    assert.equal(store.messages(other.id, 'hypothesis').length, 0);
    assert.equal(store.memory(other.id, 'hypothesis').length, 0);
    assert.equal(store.submit(other.id, 'meta-reviewer', proposal(other, 'REVIEW_STAGNATION', 'meta-reviewer')).decision, 'REJECTED');
  } finally { store.close(); }
});

const seeds = [42, 101, 509];
const trials: TrialMetrics[] = seeds.map(seed => ({ seed, validated: true, failed: 0, quality: 12, batches: 20, tasks: 23 }));
const benchmark = (bindingId: string, baseline = trials, candidate = trials.map(item => ({ ...item, batches: 19 }))) => ({
  kind: 'ROUTER_CONNECTED_SYNTHETIC_STUDY', bindingId, protocol: 'a'.repeat(64), developmentSeeds: [11, 23], heldOutSeeds: seeds,
  candidates: { policy: { configuration: { maxParallel: 2 }, parentId: null, baseline, candidate } },
});

test('promotion rechecks independent paired trials, rejects regressions, and affects only new runs', async () => {
  const store = await openStore(':memory:');
  try {
    const binding = 'configured-test-router';
    const plan = compilePreset({ strategy: 'evolutionary-hybrid' }, 'router', binding);
    const old = store.create('Baseline frozen run', plan);
    assert.throws(() => store.activateRevision('policy', binding, store.comparison({ kind: 'MOCK_AGENT_SYNTHETIC_STUDY' })));
    const poorer = trials.map(item => ({ ...item, batches: 18, quality: 9 }));
    assert.equal(comparePaired(trials, poorer, 'policy').eligible, false);
    assert.throws(() => store.activateRevision('policy', binding, store.comparison(benchmark(binding, trials, poorer))));
    assert.throws(() => store.activateRevision('policy', binding, store.comparison({ ...benchmark(binding), developmentSeeds: [42, 23] })));
    const qualified = store.comparison(benchmark(binding));
    const active = store.activateRevision('policy', binding, qualified);
    const current = store.create('New study with approved policy', store.withOperationalRevisions(plan));
    assert.equal(current.plan.policy?.id, active.id);
    assert.equal(current.plan.policy?.maxParallel, 2);
    assert.equal(store.run(old.id).plan.policy, undefined);
    assert.throws(() => store.rollbackRevision('policy', binding, 'stale'));
    assert.equal(store.rollbackRevision('policy', binding, active.id), null);
    assert.equal(store.run(current.id).plan.policy?.id, active.id);
    assert.equal(store.withOperationalRevisions(plan).policy, undefined);
    assert.equal(store.revisionStatus(binding).actions.length, 2);
  } finally { store.close(); }
});

test('approved measurements are immutable, batch-split, and not copied into agent context', async () => {
  const store = await openStore(':memory:');
  const records: Row[] = Array.from({ length: 240 }, (_, hour) => ({ hour, batch: Math.floor(hour / 30), phase: 0,
    temperature: hour % 10, pressure: hour % 13, load: hour % 8, defect: hour % 10 >= 5 ? 1 : 0 }));
  try {
    const imported = store.registerDataset(records, 'b'.repeat(64));
    assert.throws(() => parseMeasurements([...records].reverse()));
    assert.throws(() => store.registerDataset([{ hour: 0 }], 'b'.repeat(64)));
    const lab = new ResearchOrchestrator(store, new MockAgentRuntime());
    const run = store.create('Use the approved isolated panel', store.withApprovedDataset(compilePreset(), imported.id));
    const view = await lab.runToCheckpoint(run.id);
    assert.equal((view.researchLedger.evidence as { dataset: string }).dataset, imported.id);
    assert.equal((view.progressLedger.experiment as { datasetVersion: string }).datasetVersion, imported.id);
    assert.equal((view.progressLedger.validation as { independentReproducibility: string }).independentReproducibility, 'PASS');
    assert.doesNotMatch(JSON.stringify(view), /"records":/);
    const different = store.registerDataset(records.map(row => ({ ...row, load: row.load + 1 })), 'c'.repeat(64));
    assert.notEqual(different.id, imported.id);
    assert.equal(store.run(run.id).plan.dataset, imported.id);
    assert.equal(store.dataset(imported.id).records[0].load, records[0].load);
  } finally { store.close(); }
});

test('research presets execute only registered trials or preserve plans as inconclusive', async () => {
  const store = await openStore(':memory:');
  try {
    const lab = new ResearchOrchestrator(store, new MockAgentRuntime());
    const cases = [
      { type: 'algorithm-research', status: 'SUCCESS', metric: 'COMPARISONS_LOWER_IS_BETTER' },
      { type: 'ml-optimization', status: 'SUCCESS', metric: 'ACCURACY_HIGHER_IS_BETTER' },
      { type: 'idea-discovery', status: 'INCONCLUSIVE', metric: undefined },
      { type: 'custom-research', status: 'INCONCLUSIVE', metric: undefined },
    ] as const;
    for (const { type, status, metric } of cases) {
      const run = store.create('Profile a bounded local preset', compilePreset({ researchType: type }));
      assert.equal(store.submit(run.id, 'director', proposal(run, 'INVESTIGATE', 'director')).reason, 'ACTION_OUTSIDE_PRESET');
      const view = await lab.runToCheckpoint(run.id);
      assert.equal(view.run.status, status);
      assert.equal((view.progressLedger.experiment as { metric: string } | null)?.metric, metric);
      assert.ok(view.researchLedger.presetStudy);
    }
  } finally { store.close(); }
});

test('Bayesian confirmation requires a proper declared prior and backdoor checking refuses invalid adjustment', () => {
  assert.deepEqual(betaBinomialConfirmation({ alpha: 1, beta: 1, successes: 3, trials: 5 }).posterior, { alpha: 4, beta: 3 });
  assert.throws(() => betaBinomialConfirmation({ alpha: 0, beta: 1, successes: 3, trials: 5 }));
  const nodes = ['confounder', 'exposure', 'outcome', 'mediator'].map(id => ({ id, observed: true }));
  const arrows: [string, string][] = [['confounder', 'exposure'], ['confounder', 'outcome'], ['exposure', 'mediator'], ['mediator', 'outcome']];
  assert.equal(checkBackdoor(nodes, arrows, 'exposure', 'outcome', []).satisfiesCriterion, false);
  assert.deepEqual(checkBackdoor(nodes, arrows, 'exposure', 'outcome', ['confounder']), {
    satisfiesCriterion: true, reason: 'BACKDOOR_PATHS_BLOCKED_IN_DECLARED_DAG', assumptionsVerified: false,
  });
  assert.equal(checkBackdoor(nodes, arrows, 'exposure', 'outcome', ['mediator']).reason, 'EXPOSURE_DESCENDANT');
  assert.throws(() => checkBackdoor(nodes, [...arrows, ['outcome', 'confounder']], 'exposure', 'outcome', []));
});

test('Native review requires an approved read-only capability and an explicit operator decision', async () => {
  const store = await openStore(':memory:');
  try {
    const base = compilePreset({}, 'gjc');
    const run = store.create('Review the experiment with a trusted native fixture', snapshotRevisions(base, { native: ['critic'] }));
    const request = { ...proposal(run, 'DELEGATE_NATIVE_REVIEW', 'director'), native_review: 'critic' };
    assert.equal(store.submit(run.id, 'director', { ...request, native_review: 'executor' }).decision, 'REJECTED');
    assert.equal(store.submit(run.id, 'director', { ...request, proposal_id: 'unavailable-planner', native_review: 'planner' }).decision, 'REJECTED');
    assert.equal(store.submit(run.id, 'director', request).decision, 'NEEDS_HUMAN_APPROVAL');
    assert.equal(store.claim(run.id), undefined);
    let calls = 0;
    const fixture: AgentRuntime = { kind: 'gjc', nativeReviews: ['critic'],
      think: async () => { throw new Error('Native reviews do not flow through normal prompting'); },
      nativeReview: async (name, objective) => { calls++; assert.equal(name, 'critic'); assert.equal(objective, run.objective); return { summary: 'Advisory review' }; },
    };
    assert.equal(store.reviewProposal(run.id, request.proposal_id, true).decision, 'APPROVED');
    await new ResearchOrchestrator(store, fixture).tick(run.id);
    assert.equal(calls, 1);
    assert.deepEqual(store.tasks(run.id).find(task => task.id === request.proposal_id)?.result,
      { name: 'critic', summary: 'Advisory review', disposition: 'ADVISORY' });
  } finally { store.close(); }
});

test('a research branch keeps lineage, compares preregistered novelty, and withholds claims for reused measurements', async () => {
  const store = await openStore(':memory:');
  class BranchRuntime extends MockAgentRuntime {
    override async think(context: AgentContext, signal: AbortSignal) {
      const result = await super.think(context, signal);
      if (context.branch && context.claim.task.action === 'GENERATE_HYPOTHESES' && Array.isArray(result.hypotheses)) {
        return { ...result, hypotheses: result.hypotheses.map((item, index) => index === 0 ? {
          ...item, lag: 0, prediction: 'Temperature at the measurement hour separates the defect groups.',
        } : item) };
      }
      return result;
    }
  }
  try {
    const lab = new ResearchOrchestrator(store, new BranchRuntime());
    const parent = store.create('Compare temperature predictions before branching', compilePreset());
    assert.throws(() => store.branchResearch(parent.id));
    await lab.runToCheckpoint(parent.id);
    const branch = store.branchResearch(parent.id);
    assert.notEqual(branch.plan.seed, parent.plan.seed);
    assert.notEqual(store.member(branch.id, 'hypothesis').session_key, store.member(parent.id, 'hypothesis').session_key);
    const forked = await lab.runToCheckpoint(branch.id);
    assert.equal(forked.branch?.parent, parent.id);
    assert.equal((forked.researchLedger.programme as { classification: string }).classification, 'TESTABLE_PROGRESS');
    assert.equal(forked.run.status, 'INCONCLUSIVE');
    const sample = Array.from({ length: 240 }, (_, hour) => ({ hour, batch: Math.floor(hour / 30), phase: 0,
      temperature: hour % 10, pressure: hour % 13, load: hour % 8, defect: hour % 10 >= 5 ? 1 : 0 }));
    const dataset = store.registerDataset(sample, 'e'.repeat(64));
    const locked = store.create('Approved source is not newly independent', store.withApprovedDataset(compilePreset(), dataset.id));
    await lab.runToCheckpoint(locked.id);
    const reused = await lab.runToCheckpoint(store.branchResearch(locked.id).id);
    assert.equal(reused.branch?.independentPartition, false);
    const check = reused.progressLedger.validation as { scientific: Record<string, { reasons: string[] }> };
    assert.deepEqual(check.scientific.H1.reasons, ['PRIOR_DATASET_REUSED_BY_BRANCH']);
  } finally { store.close(); }
});
