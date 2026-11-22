import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MockAgentRuntime, proposal } from '../packages/research/agents.ts';
import { demoObjective, manufacturingTrial } from '../packages/research/benchmark.ts';
import { compilePreset } from '../packages/research/contracts.ts';
import { evaluateEvolution, immutableSeed, smokeEvolution } from '../packages/research/evolution.ts';
import { breedGenome, validateGraph } from '../packages/research/kernel.ts';
import { ResearchOrchestrator } from '../packages/research/orchestrator.ts';
import { openStore } from '../packages/research/store.ts';
import { argumentComplete, experimentPlan, hypotheses, runExperiment, validateExperiment } from '../packages/research/science.ts';
import { ArtifactStore, inspectApprovedDataset } from '../packages/research/artifacts.ts';

test('starts three distinct resident identities and completes the synthetic research DAG', async () => {
  const store = await openStore(':memory:');
  try {
    const lab = new ResearchOrchestrator(store, new MockAgentRuntime(), process.env.LAB_RUST_BIN);
    const run = store.create(demoObjective, compilePreset());
    const result = await lab.runToCheckpoint(run.id);
    assert.equal(result.run.status, 'INCONCLUSIVE');
    const validation = result.progressLedger.validation as ReturnType<typeof validateExperiment>;
    assert.equal(validation.independentReproducibility, 'PASS');
    assert.equal(validation.causalIdentification, 'NOT_EVALUATED');
    assert.deepEqual(validation.empiricalSupport.map(row => row.outcome), ['PASS', 'FAIL', 'FAIL']);
    assert.equal(new Set(result.residents.map(agent => agent.session_key)).size, 12);
    assert.ok(result.researchLedger.argumentGraph?.edges.some(edge => edge.relation === 'CONTRADICTED_BY'));
    assert.ok(result.scientificSim.findings.some(finding => finding.category === 'WEAK_EXPERIMENTAL_DESIGN'));
    assert.ok(result.residents.every(agent => !agent.sessionBound));
    assert.ok(result.events.some(event => event.kind === 'agent.delegated'));
    assert.ok(result.events.some(event => event.payload.topology === 'PARALLEL_INDEPENDENT'));
    assert.ok(result.events.some(event => event.payload.topology === 'SCIENTIFIC_DEBATE'));
    assert.ok(result.events.some(event => event.payload.topology === 'DEPENDENCY_DAG'));
    assert.ok(store.memory(run.id, 'evidence').some(record => record.visibility === 'private'));
    assert.ok(store.memory(run.id, 'director').every(record => record.visibility === 'shared' || record.owner === 'director'));
    const second = store.create(demoObjective, compilePreset());
    assert.deepEqual(store.memory(second.id, 'director'), []);
    assert.notEqual(store.member(second.id, 'director').session_key, store.member(run.id, 'director').session_key);
  } finally { store.close(); }
});

test('validates scope, role, evidence, forward dependencies and idempotency', async () => {
  const store = await openStore(':memory:');
  try {
    const run = store.create(demoObjective, compilePreset());
    const safe = proposal(run, 'INVESTIGATE', 'director');
    assert.equal(store.submit(run.id, 'director', null).reason, 'INVALID_SCHEMA');
    assert.equal(store.submit(run.id, 'evidence', safe).reason, 'SCOPE_MISMATCH');
    assert.equal(store.submit(run.id, 'director', { ...safe, proposal_id: 'wrong-role', target_agent_ids: ['director'] }).reason, 'ROLE_MISMATCH');
    assert.equal(store.submit(run.id, 'director', proposal(run, 'RUN_EXPERIMENT', 'director', ['future'])).decision, 'NEEDS_REVISION');
    assert.equal(store.submit(run.id, 'director', { ...safe, proposal_id: 'bad-evidence', evidence_refs: ['unverified'] }).decision, 'NEEDS_REVISION');
    assert.equal(store.submit(run.id, 'skeptic', proposal(run, 'COMPLETE', 'skeptic')).decision, 'NEEDS_HUMAN_APPROVAL');
    assert.equal(store.submit(run.id, 'director', safe).decision, 'APPROVED');
    assert.equal(store.submit(run.id, 'director', safe).decision, 'APPROVED');
    assert.equal(store.submit(run.id, 'director', { ...safe, rationale: 'A different request' }).reason, 'IDEMPOTENCY_CONFLICT');
    assert.equal(store.submit(run.id, 'director', { ...safe, proposal_id: 'repeat' }).reason, 'DUPLICATE_WORK');
    assert.equal(store.tasks(run.id).length, 1);
  } finally { store.close(); }
});

test('reopens SQLite, recovers a lease and fences a stale owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gajae-recovery-'));
  const path = join(directory, 'test.sqlite');
  let store = await openStore(path);
  try {
    const run = store.create(demoObjective, compilePreset({ timeoutMs: 100 }));
    store.submit(run.id, 'director', proposal(run, 'INVESTIGATE', 'director'));
    const old = store.claim(run.id, 100)!;
    assert.equal(store.claim(run.id, 101), undefined);
    store.close();
    store = await openStore(path);
    assert.equal(store.tasks(run.id)[0].status, 'RUNNING');
    const recovered = store.claim(run.id, 5201)!;
    assert.equal(recovered.task.attempt, 2);
    assert.equal(store.finish(old, { result: 'stale' }, 5202), false);
    assert.equal(store.finish(recovered, { result: 'recovered' }, 5202), true);
    assert.equal(store.tasks(run.id)[0].result, 'recovered');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('pause prevents admission but retains follow-ups from an already claimed director turn', async () => {
  const store = await openStore(':memory:');
  try {
    const run = store.create(demoObjective, compilePreset());
    store.submit(run.id, 'director', proposal(run, 'REPLAN', 'director'));
    const task = store.claim(run.id)!;
    assert.equal(store.changeStatus(run.id, 'PAUSED', 'test'), true);
    assert.equal(store.finish(task, { result: {}, followups: [proposal(run, 'INVESTIGATE', 'director')] }), true);
    assert.equal(store.claim(run.id), undefined);
    assert.equal(store.tasks(run.id).find(task => task.action === 'INVESTIGATE')?.status, 'QUEUED');
    assert.equal(store.changeStatus(run.id, 'ACTIVE', 'test'), true);
    assert.equal(store.claim(run.id)?.task.action, 'INVESTIGATE');
  } finally { store.close(); }
});

test('cancellation fences leased results and cancels blocked descendants', async () => {
  const store = await openStore(':memory:');
  try {
    const run = store.create(demoObjective, compilePreset());
    const evidence = proposal(run, 'INVESTIGATE', 'director');
    const quality = proposal(run, 'CHECK_DATA_QUALITY', 'director');
    store.submit(run.id, 'director', evidence);
    store.submit(run.id, 'director', quality);
    store.submit(run.id, 'director', proposal(run, 'GENERATE_HYPOTHESES', 'director', [evidence.proposal_id, quality.proposal_id]));
    const claim = store.claim(run.id)!;
    assert.equal(store.cancelTask(run.id, claim.task.id), true);
    assert.equal(store.finish(claim, { result: 'stale' }), false);
    assert.equal(store.tasks(run.id).find(task => task.action === 'GENERATE_HYPOTHESES')?.status, 'CANCELLED');
  } finally { store.close(); }
});

test('operator decisions release only approved proposals that still pass current policy', async () => {
  const store = await openStore(':memory:');
  try {
    const run = store.create(demoObjective, compilePreset());
    const moderate = { ...proposal(run, 'INVESTIGATE', 'evidence'), risk_level: 'MEDIUM' };
    const high = { ...proposal(run, 'CHECK_DATA_QUALITY', 'director'), risk_level: 'HIGH' };
    assert.equal(store.submit(run.id, 'evidence', moderate).decision, 'NEEDS_HUMAN_APPROVAL');
    assert.equal(store.submit(run.id, 'director', high).reason, 'RISK_OUTSIDE_EXECUTION_POLICY');
    assert.equal(store.claim(run.id), undefined);
    assert.equal(store.reviewProposal(run.id, high.proposal_id, true).reason, 'PROPOSAL_NOT_PENDING_REVIEW');
    assert.equal(store.changeStatus(run.id, 'NEEDS_HUMAN', 'test'), true);
    assert.equal(store.reviewProposal(run.id, moderate.proposal_id, true).decision, 'APPROVED');
    assert.equal(store.run(run.id).status, 'ACTIVE');
    assert.equal(store.claim(run.id)?.task.id, moderate.proposal_id);
    assert.equal(store.reviewProposal(run.id, moderate.proposal_id, true).reason, 'PROPOSAL_NOT_PENDING_REVIEW');
  } finally { store.close(); }
});

test('retains benchmark trial receipts and rejects replacements after reopening', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gajae-benchmark-'));
  const path = join(directory, 'test.sqlite');
  try {
    const first = await openStore(path);
    first.recordBenchmarkTrial('protocol-1', 'trial-1', { complete: true });
    first.close();
    const second = await openStore(path);
    assert.deepEqual(second.benchmarkTrial('protocol-1', 'trial-1'), { complete: true });
    assert.deepEqual(second.recordBenchmarkTrial('protocol-1', 'trial-1', { complete: false }), { complete: true });
    assert.equal(second.benchmarkTrial('protocol-2', 'trial-1'), undefined);
    second.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('stores content-addressed reports and reads only metadata from an approved data file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gajae-artifacts-'));
  try {
    const store = new ArtifactStore(directory);
    const record = { dataset: 'synthetic', result: 'PASS' };
    const receipt = store.put(record);
    assert.equal(store.put(record).sha256, receipt.sha256);
    assert.deepEqual(store.read(receipt.sha256), record);
    assert.throws(() => store.read('../test'));
    writeFileSync(join(directory, `${receipt.sha256}.json`), '{"changed":true}');
    assert.throws(() => store.read(receipt.sha256));
    const file = join(directory, 'dataset.json');
    writeFileSync(file, JSON.stringify([{ note: 'Instruction inside source data', temperature: 42 }]));
    const metadata = inspectApprovedDataset(file);
    assert.equal(metadata.rows, 1);
    assert.deepEqual(metadata.columns, ['note', 'temperature']);
    assert.ok(!JSON.stringify(metadata).includes('Instruction inside source data'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('distinguishes frozen experiment outcomes from provenance and causal evidence', () => {
  const plan = experimentPlan(42, [...hypotheses]);
  const result = runExperiment(plan);
  assert.throws(() => runExperiment({ ...plan, digest: 'edited' }));
  assert.equal(validateExperiment(plan, { ...result, dataDigest: 'edited' }).independentReproducibility, 'FAIL');
  assert.equal(validateExperiment(plan, result).causalIdentification, 'NOT_EVALUATED');
  assert.equal(argumentComplete({ claim: 'missing a warrant' }), false);
});

test('computes grounded acceptance and matches the optional Rust operator', () => {
  assert.deepEqual(validateGraph(['a', 'b', 'c', 'd'], [['a', 'b'], ['b', 'c'], ['d', 'd']], process.env.LAB_RUST_BIN).accepted, ['a', 'c']);
  assert.throws(() => validateGraph(['a'], [['a', 'unknown']]));
  assert.equal(breedGenome(9, 1234, 3456, 30, 50, process.env.LAB_RUST_BIN), breedGenome(9, 1234, 3456, 30, 50));
});

test('matches candidate budgets and tracks extra adversary evaluations and SIM variants', async () => {
  const left = await manufacturingTrial(42, 'hybrid-adaptive', 'none', 2);
  const right = await manufacturingTrial(42, 'hybrid-adaptive', 'both', 2);
  assert.equal(left.fingerprint, right.fingerprint);
  const result = evaluateEvolution(smokeEvolution);
  assert.equal(result.seed.hash, immutableSeed.hash);
  assert.ok(result.conditions.every(row => row.runs[0].evaluations === 8));
  const opponents = result.conditions.find(row => row.condition === 'coevolution')!.runs[0];
  assert.equal(opponents.opponentEvaluations, 4);
  assert.equal(opponents.hallOfFame[0], 0);
  assert.deepEqual(result.simAblation.map(row => row.condition), ['ga', 'sim-roots', 'sim-ga']);
});
