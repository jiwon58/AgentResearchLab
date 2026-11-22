import type { Hypothesis } from '../research/science.ts';
import { evaluateAttacks, evaluateFormal } from './logic.ts';
import { attackKinds, gate, missingToulmin, type Closing, type CouncilArgument, type Evidence, type Finding,
  type GateStatus, type Graph, type GraphEdge, type GraphNode, type Objection, type Opening, type Relation } from './schema.ts';

export function assessEvidence(refs: string[], catalogue: Evidence[]) {
  const evidence = new Map(catalogue.map(item => [item.id, item]));
  const found = refs.flatMap(ref => evidence.get(ref) ?? []);
  const verified = found.filter(item => item.verified);
  const snapshots = new Map<string, Set<string>>();
  for (const item of verified) {
    const groups = snapshots.get(item.snapshot) ?? new Set<string>();
    if (item.independenceGroup) groups.add(item.independenceGroup);
    snapshots.set(item.snapshot, groups);
  }
  const groups = new Set([...snapshots.values()].flatMap(set => set.size === 1 ? [...set] : []));
  const missing = refs.filter(ref => !evidence.has(ref));
  const duplicates = found.length !== new Set(found.map(item => item.snapshot)).size;
  const status = !refs.length || missing.length ? 'FAIL' : snapshots.size < 2 || groups.size < 2 || verified.length !== found.length ? 'INCONCLUSIVE' : 'PASS';
  return { gate: gate(status, missing.length ? ['MISSING_PROVENANCE'] : !refs.length ? ['NO_EVIDENCE']
    : status === 'PASS' ? ['VERIFIED_INDEPENDENT_SOURCES'] : ['INSUFFICIENT_SOURCE_INDEPENDENCE'], refs),
  missing, duplicates, uniqueSnapshots: snapshots.size, independentGroups: groups.size };
}

export function closeDebate(opening: Opening, objections: Objection[], closing: Closing, newEvidenceRefs: string[] = []) {
  return { stages: [
    { phase: 'CONFRONTATION', issues: opening.issues },
    { phase: 'OPENING', commonPremises: opening.commonPremises, evidenceCriteria: opening.evidenceCriteria },
    { phase: 'ARGUMENTATION', objections },
    { phase: 'CONCLUSION', unresolved: closing.unresolved, proposedExperiment: closing.proposedExperiment, reportedConsensus: closing.consensus },
  ], rounds: 1, newEvidenceRefs, stopReason: newEvidenceRefs.length ? 'AGREED_ROUND_LIMIT' : 'NO_NEW_VERIFIED_EVIDENCE_OR_PREREGISTERED_TEST',
  empiricalDecision: 'NOT_APPLICABLE' as const };
}

const aggregate = (values: GateStatus[]): GateStatus => values.includes('FAIL') ? 'FAIL' : values.includes('INCONCLUSIVE') ? 'INCONCLUSIVE'
  : values.includes('PASS') ? 'PASS' : 'NOT_APPLICABLE';

export function reviewCouncil(input: {
  hypotheses: Hypothesis[]; args: CouncilArgument[]; evidence: Evidence[]; objections: Objection[];
  opening: Opening; closing: Closing; at: number; kernel?: string;
}) {
  const graph: Graph = { nodes: [], edges: [] };
  const known = new Set(input.evidence.map(item => item.id));
  const findings: Finding[] = [];
  const node = (id: string, kind: GraphNode['kind'], value: string, agent: string, evidenceIds: string[] = [], status: GateStatus = 'INCONCLUSIVE') =>
    graph.nodes.push({ id, kind, value, agent, evidenceIds, createdAt: input.at, status });
  const edge = (from: string, to: string, relation: Relation, agent: string, evidenceIds: string[] = [], status: GateStatus = 'INCONCLUSIVE') =>
    graph.edges.push({ id: `edge-${graph.edges.length + 1}`, from, to, relation, agent, evidenceIds, createdAt: input.at, status });
  const finding = (code: Finding['code'], subject: string, refs: string[] = []) => findings.push({ code, subject, refs });

  for (const item of input.evidence) node(`evidence:${item.id}`, 'EVIDENCE', item.snapshot, 'evidence', [item.id], item.verified ? 'PASS' : 'INCONCLUSIVE');
  const reviews = input.args.map(arg => {
    const hypothesis = input.hypotheses.find(candidate => candidate.id === arg.hypothesisId)!;
    const missing = missingToulmin(arg);
    const evidence = assessEvidence(arg.evidenceReferences, input.evidence);
    const formal = evaluateFormal(arg.formalization, [...known], input.kernel);
    const matchingTest = arg.testablePredictions.includes(hypothesis.prediction) && arg.falsificationConditions.includes(hypothesis.falsification);
    const statuses = {
      A: gate(missing.length ? 'FAIL' : 'PASS', missing.length ? missing : ['TOULMIN_COMPLETE'], arg.evidenceReferences),
      B: gate(formal.symbolic.status === 'FAIL' ? 'FAIL' : formal.symbolic.status === 'PASS' && formal.alignment.status === 'PASS' ? 'PASS' : 'INCONCLUSIVE',
        [...formal.symbolic.reasons, ...formal.alignment.reasons], arg.evidenceReferences),
      C: gate(arg.claimType === 'exploratory' ? 'NOT_APPLICABLE' : matchingTest ? 'PASS' : 'FAIL', [matchingTest ? 'PREDICTION_LINKED' : 'MISSING_MATCHING_TEST']),
      D: evidence.gate,
    };
    if (missing.includes('warrant')) finding('MISSING_WARRANT', arg.id);
    if (evidence.gate.status === 'FAIL' || !arg.claim) finding('UNSUPPORTED_CLAIM', arg.id, evidence.missing);
    if (evidence.duplicates) finding('EVIDENCE_REUSE_BIAS', arg.id, arg.evidenceReferences);
    if (formal.issues.includes('INVALID_INFERENCE') || formal.issues.includes('UNSUPPORTED_RULE')) finding('INVALID_INFERENCE', arg.id);
    if (formal.issues.includes('CONTRADICTORY_PREMISES')) finding('CONTRADICTORY_PREMISES', arg.id);
    if (statuses.C.status === 'FAIL') finding('UNFALSIFIABLE_HYPOTHESIS', arg.id);
    if (arg.claimType === 'causal') finding('INVALID_CAUSAL_CLAIM', arg.id, arg.evidenceReferences);

    const h = `hypothesis:${hypothesis.id}`, c = `claim:${hypothesis.id}`, p = `prediction:${hypothesis.id}`, rule = `rule:${hypothesis.id}`;
    const test = `test:${hypothesis.id}`;
    node(h, 'HYPOTHESIS', hypothesis.claim, 'hypothesis');
    node(c, 'CLAIM', arg.claim, 'argumentation', arg.evidenceReferences, statuses.A.status);
    node(arg.id, 'ARGUMENT', arg.claim, 'argumentation', arg.evidenceReferences, statuses.A.status);
    node(rule, 'INFERENCE_RULE', arg.warrant, 'argumentation', arg.evidenceReferences, statuses.B.status);
    node(p, 'PREDICTION', hypothesis.prediction, 'hypothesis', [], statuses.C.status);
    node(test, 'EXPERIMENT', hypothesis.falsification, 'skeptic');
    edge(arg.id, c, 'SUPPORTS', 'argumentation', arg.evidenceReferences);
    edge(c, h, 'SUPPORTS', 'argumentation', arg.evidenceReferences);
    edge(arg.id, rule, 'DERIVED_FROM', 'argumentation', arg.evidenceReferences, statuses.B.status);
    edge(p, h, 'DERIVED_FROM', 'hypothesis');
    edge(p, test, 'TESTED_BY', 'skeptic', [], statuses.C.status);
    for (const [index, assumption] of arg.assumptions.entries()) {
      const premise = `premise:${hypothesis.id}:${index}`;
      node(premise, 'PREMISE', assumption, 'argumentation', arg.evidenceReferences);
      edge(arg.id, premise, 'DERIVED_FROM', 'argumentation', arg.evidenceReferences);
    }
    for (const ref of new Set(arg.evidenceReferences.filter(ref => known.has(ref)))) edge(`evidence:${ref}`, arg.id, 'SUPPORTS', 'argumentation', [ref], evidence.gate.status);
    return { hypothesisId: hypothesis.id, claimType: arg.claimType, gates: statuses, formal, evidence };
  });

  for (const objection of input.objections) {
    node(objection.id, 'OBJECTION', objection.reason, 'skeptic', objection.evidenceRefs);
    edge(objection.id, objection.target, objection.relation, 'skeptic', objection.evidenceRefs);
    if (objection.evidenceRefs.some(ref => !known.has(ref))) finding('UNSUPPORTED_CLAIM', objection.id, objection.evidenceRefs);
  }
  const vertices = graph.nodes.filter(n => n.kind === 'ARGUMENT' || n.kind === 'OBJECTION').map(n => n.id);
  const attacks = graph.edges.filter(e => attackKinds.some(kind => kind === e.relation)).map(e => [e.from, e.to] as [string, string]);
  const framework = evaluateAttacks(vertices, attacks, [], input.kernel);
  const accepted = { ...framework, defended: framework.accepted, conflictFree: attacks.every(([a, b]) => !framework.accepted.includes(a) || !framework.accepted.includes(b)) };
  const ready = reviews.filter(r => r.gates.A.status === 'PASS' && r.gates.B.status !== 'FAIL' && r.gates.C.status === 'PASS' && r.gates.D.status !== 'FAIL');
  const original = new Set(input.args.flatMap(arg => arg.evidenceReferences));
  const seenSnapshots = new Set(input.evidence.filter(item => original.has(item.id)).map(item => item.snapshot));
  const proposedRefs = new Set(input.objections.flatMap(item => item.evidenceRefs));
  const newEvidence = input.evidence.filter(item => item.verified && proposedRefs.has(item.id) && !seenSnapshots.has(item.snapshot)).map(item => item.id);
  if (input.closing.consensus && reviews.some(item => item.gates.D.status !== 'PASS')) finding('PREMATURE_CONSENSUS', 'debate');
  return { arguments: input.args, critic: { id: 'council-critic', critique: input.objections.map(o => o.reason).join('\n') },
    attacks, accepted, reviews, eligibleHypotheses: ready.map(r => r.hypothesisId), graph, findings,
    debate: closeDebate(input.opening, input.objections, input.closing, newEvidence),
    dimensions: { argumentCompleteness: aggregate(reviews.map(r => r.gates.A.status)), formalValidity: aggregate(reviews.map(r => r.gates.B.status)),
      falsifiability: aggregate(reviews.map(r => r.gates.C.status)), evidenceProvenance: aggregate(reviews.map(r => r.gates.D.status)),
      empiricalSupport: 'INCONCLUSIVE' as const } };
}

export type CouncilReview = ReturnType<typeof reviewCouncil>;
