import { gate, type Gate, type Graph } from './schema.ts';
import type { Hypothesis } from '../research/science.ts';

export function auditSeverity(spec: { preregistered: boolean; reliability?: boolean; independentUnits?: number;
  targetUnits?: number; powerPlanEvidence?: string }) {
  const missing = [!spec.preregistered && 'NO_PREREGISTRATION', spec.reliability !== true && 'MEASUREMENT_RELIABILITY_UNVERIFIED',
    (!spec.independentUnits || !spec.targetUnits || !spec.powerPlanEvidence) && 'NO_VALIDATED_POWER_PLAN'].filter(Boolean) as string[];
  const belowTarget = Boolean(spec.independentUnits && spec.targetUnits && spec.independentUnits < spec.targetUnits);
  return gate(missing.length || belowTarget ? 'INCONCLUSIVE' : 'PASS',
    [...missing, ...(belowTarget ? ['INSUFFICIENT_INDEPENDENT_UNITS'] : []), ...(!missing.length && !belowTarget ? ['PREDECLARED_SEVERITY_CRITERIA_MET'] : [])],
    spec.powerPlanEvidence ? [spec.powerPlanEvidence] : []);
}

export function empiricalGate(input: { observed: string; reproduction: string; prerequisites: Gate[];
  claimType: 'association' | 'causal' | 'exploratory'; measurementError?: boolean }) {
  if (input.claimType === 'exploratory') return gate('NOT_APPLICABLE', ['EXPLORATORY_CLAIM']);
  if (input.claimType === 'causal') return gate('INCONCLUSIVE', ['NO_CAUSAL_IDENTIFICATION']);
  if (input.measurementError) return gate('INCONCLUSIVE', ['MEASUREMENT_ERROR_ALTERNATIVE']);
  if (input.reproduction !== 'PASS' || input.prerequisites.some(check => check.status !== 'PASS')) {
    return gate('INCONCLUSIVE', [input.reproduction === 'PASS' ? 'REQUIRED_GATES_NOT_SATISFIED' : 'INDEPENDENT_REPRODUCTION_NOT_ESTABLISHED']);
  }
  if (input.observed === 'FAIL') return gate('FAIL', ['PREREGISTERED_CRITERION_NOT_MET']);
  if (input.observed === 'PASS') return gate('PASS', ['PREREGISTERED_ASSOCIATION_CRITERION_MET']);
  return gate('INCONCLUSIVE', ['EXPERIMENT_INCONCLUSIVE']);
}

export function evaluateProgramme(previous: Hypothesis[], current: Hypothesis[], confirmed: Set<string>, preregistered: Set<string>) {
  const signature = (h: Hypothesis) => `${h.signal}:${h.lag}:${h.direction}`;
  const known = new Set(previous.map(signature));
  const novel = current.filter(h => !known.has(signature(h)));
  const confirmedNovel = novel.filter(h => confirmed.has(h.id) && preregistered.has(h.id));
  const postHoc = current.filter(h => h.parentIds.length > 0 && !preregistered.has(h.id) && !novel.includes(h));
  return { classification: !previous.length ? 'BASELINE' : confirmedNovel.length ? 'EMPIRICALLY_PROGRESSIVE'
    : novel.some(h => preregistered.has(h.id)) ? 'TESTABLE_PROGRESS' : postHoc.length ? 'POST_HOC_ONLY' : 'NO_NEW_PREDICTION',
  gate: gate(!previous.length ? 'NOT_APPLICABLE' : confirmedNovel.length ? 'PASS' : 'INCONCLUSIVE',
    confirmedNovel.length ? ['NEW_PREDICTION_INDEPENDENTLY_CONFIRMED'] : ['NO_CONFIRMED_INCREMENT']),
  novelPredictions: novel.map(h => h.id), independentlyConfirmedPredictions: confirmedNovel.map(h => h.id), postHocRevisions: postHoc.map(h => h.id) };
}

export function appendObservedEvidence(graph: Graph, source: string, observation: string, observed: { hypothesisId: string; outcome: string }[],
  assessments: Record<string, Gate>, at: number): Graph {
  const id = `experiment-result:${source}`;
  const known = new Set(graph.nodes.map(node => node.id));
  return { nodes: [...graph.nodes, { id, kind: 'EVIDENCE', value: observation, evidenceIds: [source], agent: 'methodology', createdAt: at, status: 'INCONCLUSIVE' }],
    edges: [...graph.edges, ...observed.filter(row => row.outcome !== 'INCONCLUSIVE' && known.has(`hypothesis:${row.hypothesisId}`)).map((row, index) => ({
      id: `observed-${index + 1}`, from: row.outcome === 'PASS' ? id : `hypothesis:${row.hypothesisId}`,
      to: row.outcome === 'PASS' ? `hypothesis:${row.hypothesisId}` : id,
      relation: row.outcome === 'PASS' ? 'SUPPORTS' as const : 'CONTRADICTED_BY' as const, evidenceIds: [source],
      agent: 'methodology', createdAt: at, status: assessments[row.hypothesisId].status,
    }))] };
}
