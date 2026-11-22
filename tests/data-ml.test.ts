import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockAgentRuntime, reasoningPrompt, type AgentContext } from '../packages/research/agents.ts';
import { compilePreset } from '../packages/research/contracts.ts';
import { mlCandidates, parseMlFile, profileMl, runDataMl } from '../packages/research/data-ml.ts';
import { ResearchOrchestrator } from '../packages/research/orchestrator.ts';
import { openStore } from '../packages/research/store.ts';

const classification = {
  kind: 'classification', format: 'csv', delimiter: ';', split: 'grouped', target: 'label', group: 'group',
  features: ['value', 'noise'],
  content: ['value;noise;label;group;private_column', ...Array.from({ length: 120 }, (_, i) =>
    `${i % 2 ? 20 + i / 120 : -20 + i / 120};${i % 7};${i % 2 ? 'yes' : 'no'};"그룹;${Math.floor(i / 2)}";PRIVATE_MARKER`)].join('\r\n'),
};
const regressionRows = Array.from({ length: 120 }, (_, i) => ({
  signal: i + 0.5, extra: (i * 3) % 11, target: 3 * (i + 0.5) + 4 * ((i * 3) % 11) + 2, duplicate: 3 * (i + 0.5) + 4 * ((i * 3) % 11) + 2,
}));
const regression = { kind: 'regression', format: 'json', split: 'grouped', target: 'target',
  features: ['signal', 'extra'], content: JSON.stringify(regressionRows) };

test('tabular research pins approved data and completes collection, quality checks and held-out validation', async () => {
  const store = await openStore(':memory:');
  class Capture extends MockAgentRuntime {
    lastPlanning?: ReturnType<typeof reasoningPrompt>;
    override async think(context: AgentContext, signal: AbortSignal) {
      if (context.claim.task.action === 'PLAN_PRESET_STUDY') this.lastPlanning = reasoningPrompt(context);
      return super.think(context, signal);
    }
  }
  try {
    const entry = store.registerMlDataset(classification);
    const plan = store.withMlDataset(compilePreset({ researchType: 'tabular-ml' }), entry.id);
    assert.deepEqual(plan.mlDataset, { id: entry.id, kind: 'classification' });
    assert.equal(store.registerMlDataset(classification).id, entry.id);
    assert.equal(store.mlDatasets().length, 1);
    const runtime = new Capture();
    const run = store.create('Compare registered classifiers on approved measurements', plan);
    const view = await new ResearchOrchestrator(store, runtime).runToCheckpoint(run.id);
    assert.equal(view.run.status, 'SUCCESS');
    assert.equal(view.progressLedger.validation && (view.progressLedger.validation as { independentReproducibility: string }).independentReproducibility, 'PASS');
    assert.equal(view.tasks.find(task => task.action === 'COLLECT_ML_DATA')?.role, 'data-collector');
    assert.equal(view.tasks.find(task => task.action === 'PROFILE_ML_DATA')?.role, 'data-quality');
    assert.equal(view.researchFlow.stages[0].status, 'DONE');
    const output = view.progressLedger.experiment as ReturnType<typeof runDataMl>;
    assert.equal(output.metric, 'BALANCED_ACCURACY');
    assert.equal(output.results.filter(row => row.heldOutScore !== null).length, 2);
    assert.equal(output.results.find(row => row.candidate === output.selected)?.heldOutScore, 1);
    assert.doesNotMatch(JSON.stringify(runtime.lastPlanning), /PRIVATE_MARKER|그룹|noise|heldOutRows|partitionDigest/);
  } finally { store.close(); }
});

test('registered regression compares development scores and evaluates only the selected model and baseline on held-out rows', () => {
  const { dataset, id, sourceVersion } = parseMlFile(regression);
  const snapshot = { ...dataset, id, sourceVersion };
  const profile = profileMl(snapshot);
  assert.equal(profile.trainingRows + profile.developmentRows + profile.heldOutRows, 120);
  const result = runDataMl(snapshot, [...mlCandidates.regression]);
  assert.equal(result.selected, 'ridge');
  assert.equal(result.metric, 'MEAN_ABSOLUTE_ERROR');
  const selected = result.results.find(row => row.candidate === result.selected)!;
  const baseline = result.results.find(row => row.candidate === result.baseline)!;
  assert(selected.heldOutScore! < baseline.heldOutScore!);
  assert.equal(result.results.find(row => row.candidate === 'single-feature-linear')?.heldOutScore, null);
  assert.deepEqual(runDataMl(snapshot, [...mlCandidates.regression]), result);
});

test('registration rejects members of the same group crossing an ordered split and copied target features', () => {
  assert.throws(() => parseMlFile({ ...regression, split: 'ordered', group: 'batch',
    content: JSON.stringify(regressionRows.map((row, i) => ({ ...row, batch: i % 5 }))) }), /동일한 그룹/);
  assert.throws(() => parseMlFile({ ...regression, features: ['signal', 'duplicate'] }), /대상 열과 값이 같은/);
  assert.throws(() => parseMlFile({ ...regression, features: ['target'] }), /서로 달라야/);
});
