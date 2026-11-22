import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessEvidence, closeDebate, reviewCouncil } from '../packages/scientific-reasoning/council.ts';
import { auditSeverity, empiricalGate, evaluateProgramme } from '../packages/scientific-reasoning/evaluation.ts';
import { evaluateAttacks, evaluateFormal } from '../packages/scientific-reasoning/logic.ts';
import { gate, parseArguments, type Formalization } from '../packages/scientific-reasoning/schema.ts';
import { argumentsFor, hypotheses } from '../packages/research/science.ts';
import { MockAgentRuntime } from '../packages/research/agents.ts';
import { compilePreset } from '../packages/research/contracts.ts';
import { ResearchOrchestrator } from '../packages/research/orchestrator.ts';
import { openStore } from '../packages/research/store.ts';

const rust = process.env.LAB_RUST_BIN;
const panel = { id: 'source-1', snapshot: 'production-panel', independenceGroup: 'plant-A', verified: true };
const argument = { ...argumentsFor([hypotheses[0]], panel.id)[0], claimType: 'association' as const };
const valid: Formalization = { rule: 'MODUS_PONENS', premises: [{ literal: 'p', evidenceRef: panel.id }],
  implication: { antecedent: 'p', consequent: 'q', evidenceRef: panel.id }, conclusion: 'q' };
const opening = { issues: ['Alternative explanation'], commonPremises: ['Observational'], evidenceCriteria: ['Independent sources'] };
const agreement = { unresolved: [], proposedExperiment: 'Replicate on a held-out panel', consensus: true };
const good = gate('PASS', ['REVIEWED']);

test('Toulmin records a missing warrant, separates unsupported claims and flags premature agreement', () => {
  const args = parseArguments([{ ...argument, warrant: '', evidenceReferences: ['unregistered'] }], [hypotheses[0]]);
  const output = reviewCouncil({ hypotheses: [hypotheses[0]], args, evidence: [panel], objections: [], opening, closing: agreement, at: 42, kernel: rust });
  assert.equal(output.reviews[0].gates.A.status, 'FAIL');
  assert.equal(output.reviews[0].gates.D.status, 'FAIL');
  assert.deepEqual(output.findings.map(item => item.code), ['MISSING_WARRANT', 'UNSUPPORTED_CLAIM', 'PREMATURE_CONSENSUS']);
  assert.deepEqual(output.eligibleHypotheses, []);
  assert.ok(output.graph.edges.every(edge => output.graph.nodes.some(node => node.id === edge.from) && output.graph.nodes.some(node => node.id === edge.to)));
});

test('Rust and TypeScript distinguish mutual attack, defense, and conflict freedom', () => {
  const a = ['a', 'b', 'c'];
  const mutual: [string, string][] = [['a', 'b'], ['b', 'a']];
  assert.deepEqual(evaluateAttacks(a.slice(0, 2), mutual, [], rust).accepted, []);
  assert.equal(evaluateAttacks(a, mutual, ['a', 'b'], rust).conflictFree, false);
  const defense: [string, string][] = [...mutual, ['c', 'b']];
  const got = evaluateAttacks(a, defense, ['a', 'c'], rust);
  assert.deepEqual(got.accepted, ['a', 'c']);
  assert.deepEqual(got.defended, ['a', 'c']);
  assert.equal(got.conflictFree, true);
  assert.throws(() => evaluateAttacks(a, [['a', 'missing']], [], rust));
  assert.throws(() => evaluateAttacks(a, [...mutual, mutual[0]], [], rust));
});

test('symbolic inconsistency, unsupported rules, missing provenance and semantic uncertainty are separate', () => {
  const unchecked = evaluateFormal(valid, [panel.id], rust);
  assert.equal(unchecked.symbolic.status, 'PASS');
  assert.equal(unchecked.alignment.status, 'INCONCLUSIVE');
  assert.equal(evaluateFormal({ ...valid, conclusion: 'unrelated' }, [panel.id], rust).symbolic.status, 'FAIL');
  assert.ok(evaluateFormal({ ...valid, premises: [...valid.premises, { literal: '!p', evidenceRef: panel.id }] }, [panel.id], rust).issues.includes('CONTRADICTORY_PREMISES'));
  assert.ok(evaluateFormal(valid, [], rust).issues.includes('MISSING_PROVENANCE'));
  assert.ok(evaluateFormal({ ...valid, rule: 'UNPROVEN_RULE' }, [panel.id], rust).issues.includes('UNSUPPORTED_RULE'));
  assert.equal(evaluateFormal({ ...valid, conclusion: 'ambiguous natural language' }, [panel.id], rust).symbolic.status, 'INCONCLUSIVE');
});

test('evidence aliases cannot manufacture an independent source', () => {
  const alias = { ...panel, id: 'alias', independenceGroup: 'claimed-different' };
  const sameGroup = { ...panel, id: 'other', snapshot: 'second-panel' };
  const assessment = assessEvidence([panel.id, alias.id, sameGroup.id], [panel, alias, sameGroup]);
  assert.equal(assessment.duplicates, true);
  assert.equal(assessment.gate.status, 'INCONCLUSIVE');
  const otherPlant = { ...sameGroup, independenceGroup: 'plant-B' };
  assert.equal(assessEvidence([panel.id, otherPlant.id], [panel, otherPlant]).gate.status, 'PASS');
});

test('weak power, measurement error, and observational causality cannot pass the empirical gate', () => {
  const weak = auditSeverity({ preregistered: true, reliability: true, independentUnits: 6, targetUnits: 30, powerPlanEvidence: 'frozen-power-plan' });
  assert.equal(weak.status, 'INCONCLUSIVE');
  assert.ok(weak.reasons.includes('INSUFFICIENT_INDEPENDENT_UNITS'));
  const positive = { observed: 'PASS', reproduction: 'PASS', claimType: 'association' as const };
  assert.equal(empiricalGate({ ...positive, prerequisites: [good, weak] }).status, 'INCONCLUSIVE');
  assert.equal(empiricalGate({ ...positive, prerequisites: [good], claimType: 'causal' }).status, 'INCONCLUSIVE');
  assert.equal(empiricalGate({ ...positive, prerequisites: [good], observed: 'FAIL', measurementError: true }).status, 'INCONCLUSIVE');
  assert.equal(empiricalGate({ ...positive, prerequisites: [good] }).status, 'PASS');
});

test('a post-hoc threshold change is not a novel prediction and consensus cannot override data', () => {
  const start = hypotheses[0];
  const revised = { ...start, id: 'post-hoc', minEffect: 0.04, parentIds: [start.id] };
  assert.equal(evaluateProgramme([start], [revised], new Set([revised.id]), new Set()).classification, 'POST_HOC_ONLY');
  const newPrediction = { ...start, id: 'independent', lag: 0 as const, parentIds: [start.id] };
  assert.equal(evaluateProgramme([start], [newPrediction], new Set([newPrediction.id]), new Set([newPrediction.id])).classification, 'EMPIRICALLY_PROGRESSIVE');
  const closing = closeDebate(opening, [], agreement);
  assert.deepEqual(closing.stages.map(stage => stage.phase), ['CONFRONTATION', 'OPENING', 'ARGUMENTATION', 'CONCLUSION']);
  assert.equal(closing.empiricalDecision, 'NOT_APPLICABLE');
  assert.equal(empiricalGate({ observed: 'FAIL', reproduction: 'PASS', claimType: 'association', prerequisites: [good] }).status, 'FAIL');
});

test('retains existing run semantics and creates only independently reviewable candidates from repeating scientific failures', async () => {
  const store = await openStore(':memory:');
  try {
    const lab = new ResearchOrchestrator(store, new MockAgentRuntime(), rust);
    const legacy = store.create('Existing observational study', compilePreset({}, 'mock', undefined, 'legacy'));
    const previous = await lab.runToCheckpoint(legacy.id);
    assert.equal(previous.run.status, 'SUCCESS');
    assert.equal(previous.residents.length, 7);
    assert.equal(previous.researchLedger.argumentGraph, null);
    for (let index = 0; index < 2; index++) {
      const run = store.create(`New observational study ${index}`, compilePreset({ strategy: 'deterministic' }));
      const current = await lab.runToCheckpoint(run.id);
      assert.equal(current.run.status, 'INCONCLUSIVE');
      const order = current.tasks.map(task => task.action);
      assert.ok(order.indexOf('OPEN_DEBATE') < order.indexOf('CRITIQUE'));
      assert.ok(order.indexOf('AUDIT_SEVERITY') < order.indexOf('RUN_EXPERIMENT'));
      assert.ok(order.indexOf('REVIEW_PROGRAMME') < order.indexOf('REFINE_HYPOTHESES'));
      if (index === 1) {
        const candidate = current.scientificSim.harnessCandidates.find(item => item.category === 'WEAK_EXPERIMENTAL_DESIGN');
        assert.equal(candidate?.disposition, 'PENDING_INDEPENDENT_EVALUATION');
      }
    }
  } finally { store.close(); }
});
