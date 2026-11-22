import { createHash } from 'node:crypto';
import { hash, isRecord } from './contracts.ts';

export function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

type Signal = 'temperature' | 'pressure' | 'load';
export interface Row { hour: number; batch: number; phase: number; temperature: number; pressure: number; load: number; defect: number }
export interface DataSnapshot { id: string; records: Row[] }
export interface Hypothesis {
  id: string; claim: string; signal: Signal; lag: 0 | 1; direction: 'positive' | 'negative'; minEffect: number;
  prediction: string; falsification: string; parentIds: string[];
  abduction?: { scope: string; auxiliaryAssumptions: string[]; expectedObservation: string; distinguishingPrediction: string };
}
export interface Argument {
  id: string; hypothesisId: string; claim: string; data: string; warrant: string; backing: string;
  qualifier: string; rebuttal: string; assumptions: string[]; evidenceReferences: string[];
  testablePredictions: string[]; falsificationConditions: string[];
}
export const datasetVersion = 'manufacturing-synthetic-v1';

export function parseMeasurements(input: unknown): Row[] {
  if (!Array.isArray(input) || input.length < 80 || input.length > 10_000) throw new Error('Expected at least 80 approved measurements');
  const batches = new Set<number>();
  let last: Row | undefined;
  const records = input.map(value => {
    if (!isRecord(value)) throw new Error('Invalid measurement record');
    const { hour, batch, phase, temperature, pressure, load, defect } = value as unknown as Row;
    if (![hour, batch, phase].every(n => Number.isSafeInteger(n) && n >= 0) || ![temperature, pressure, load].every(Number.isFinite)
      || (defect !== 0 && defect !== 1) || (last && hour <= last.hour) || (last?.batch !== batch && batches.has(batch))) {
      throw new Error('Expected chronological measurements in contiguous batches');
    }
    batches.add(batch);
    last = { hour, batch, phase, temperature, pressure, load, defect };
    return last;
  });
  if (batches.size < 4) throw new Error('At least four distinct batch labels are required for splitting');
  return records;
}

function rows(seed: number): Row[] {
  const next = random(seed);
  let previous = 0;
  return Array.from({ length: 720 }, (_, hour) => {
    const batch = Math.floor(hour / 30);
    const phase = hour % 3;
    const load = next();
    const hiddenCalibration = (batch % 5) / 5;
    const temperature = 0.45 * load + 0.4 * next() + 0.15 * hiddenCalibration;
    const pressure = 0.6 * temperature + 0.4 * next();
    const defect = Number(next() < 0.08 + 0.5 * previous + 0.12 * hiddenCalibration + 0.06 * phase);
    previous = temperature;
    return { hour, batch, phase, temperature, pressure, load, defect };
  });
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const round = (n: number) => Math.round(n * 1e6) / 1e6;

function partitions(seed: number, source?: DataSnapshot) {
  const data = source?.records ?? rows(seed);
  const batches = [...new Set(data.map(row => row.batch))];
  const cut = data.findIndex(row => row.batch === batches[Math.floor(batches.length / 2)]);
  return { development: data.slice(0, cut), held: data.slice(cut) };
}

export function evidence(seed: number, source?: DataSnapshot) {
  const data = partitions(seed, source).development;
  return {
    dataset: source?.id ?? datasetVersion, snapshot: hash(data), partition: 'development', rows: data.length,
    columns: Object.keys(data[0]), batches: new Set(data.map(row => row.batch)).size,
    defectRate: round(mean(data.map(row => row.defect))), policy: source ? 'APPROVED_READ_ONLY' : 'SYNTHETIC_READ_ONLY',
  };
}

export const hypotheses: readonly Hypothesis[] = Object.freeze([
  { id: 'H1', claim: 'Higher prior-hour temperature is associated with next-hour defects', signal: 'temperature', lag: 1,
    direction: 'positive', minEffect: 0.06, prediction: 'Prior-hour temperature upper half has higher defect risk',
    falsification: 'The held-out defect risk difference is below 0.06', parentIds: [] },
  { id: 'H2', claim: 'Contemporaneous pressure is associated with defects', signal: 'pressure', lag: 0,
    direction: 'positive', minEffect: 0.06, prediction: 'Current pressure upper half has higher defect risk',
    falsification: 'The held-out defect risk difference is below 0.06', parentIds: [] },
  { id: 'H3', claim: 'Contemporaneous load is associated with defects', signal: 'load', lag: 0,
    direction: 'positive', minEffect: 0.06, prediction: 'Current load upper half has higher defect risk',
    falsification: 'The held-out defect risk difference is below 0.06', parentIds: [] },
]);

export function parseHypotheses(value: unknown): Hypothesis[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 8) throw new Error('Expected 3–8 hypotheses');
  const output = value.map((item): Hypothesis => {
    if (!isRecord(item) || typeof item.id !== 'string' || !/^[\w-]{1,32}$/.test(item.id)
      || !['temperature', 'pressure', 'load'].includes(String(item.signal)) || (item.lag !== 0 && item.lag !== 1)
      || (item.direction !== 'positive' && item.direction !== 'negative') || typeof item.minEffect !== 'number'
      || item.minEffect < 0.04 || item.minEffect > 0.4 || !['claim', 'prediction', 'falsification'].every(key =>
        typeof item[key] === 'string' && String(item[key]).trim().length > 0 && String(item[key]).length <= 500)) {
      throw new Error('Invalid hypothesis');
    }
    return { id: item.id, signal: item.signal as Signal, lag: item.lag, direction: item.direction, minEffect: item.minEffect,
      claim: String(item.claim), prediction: String(item.prediction), falsification: String(item.falsification), parentIds: [] };
  });
  if (new Set(output.map(h => h.id)).size !== output.length
    || new Set(output.map(h => `${h.signal}/${h.lag}/${h.direction}`)).size !== output.length) throw new Error('Duplicate hypothesis');
  return output;
}

export function argumentsFor(hs: Hypothesis[], evidenceRef: string): Argument[] {
  return hs.map(h => ({
    id: `argument-${h.id}`, hypothesisId: h.id, claim: h.claim, data: 'Development snapshot defines the variables and observation units',
    warrant: 'A preregistered held-out comparison can test the directional association', backing: 'Risk difference with frozen threshold',
    qualifier: 'Observational association', rebuttal: 'Batch, operating phase and unobserved calibration can confound the association',
    assumptions: ['Within-batch lags are correctly aligned', 'Development thresholds are applied unchanged'],
    evidenceReferences: [evidenceRef], testablePredictions: [h.prediction], falsificationConditions: [h.falsification],
  }));
}

export function argumentComplete(argument: Partial<Argument>) {
  const prose = [argument.claim, argument.data, argument.warrant, argument.backing, argument.qualifier, argument.rebuttal];
  return prose.every(item => typeof item === 'string' && item.trim().length > 0)
    && [argument.evidenceReferences, argument.testablePredictions, argument.falsificationConditions]
      .every(items => Array.isArray(items) && items.length > 0 && items.every(item => typeof item === 'string' && item.trim().length > 0));
}

export type Edge = [string, string];
export function grounded(vertices: string[], attacks: Edge[]): string[] {
  const accepted = new Set<string>();
  for (;;) {
    const countered = new Set(attacks.filter(([src]) => accepted.has(src)).map(([, dest]) => dest));
    const added = vertices.filter(id => !accepted.has(id) && attacks.every(([src, dest]) => dest !== id || countered.has(src)));
    if (!added.length) return vertices.filter(id => accepted.has(id));
    added.forEach(id => accepted.add(id));
  }
}

const protocol = 'frozen-median-risk-difference/v1';
export function experimentPlan(seed: number, candidates: Hypothesis[], source?: DataSnapshot) {
  const { development, held } = partitions(seed, source);
  const tests = candidates.map(h => {
    const values = development.map(row => row[h.signal]).sort((a, b) => a - b);
    return { ...h, threshold: values[Math.floor(values.length / 2)], minimumGroup: 40 };
  });
  return { protocol, seed, datasetVersion: source?.id ?? datasetVersion, tests,
    ...(source ? { heldOutBatchCount: new Set(held.map(row => row.batch)).size } : {}),
    digest: hash({ protocol, seed, tests, ...(source ? { source: source.id } : {}) }) };
}

export type ExperimentPlan = ReturnType<typeof experimentPlan>;
export type ExperimentResult = ReturnType<typeof runExperiment>;
function validExperimentPlan(plan: ExperimentPlan, source?: DataSnapshot) {
  return plan.protocol === protocol && plan.datasetVersion === (source?.id ?? datasetVersion)
    && plan.digest === hash({ protocol, seed: plan.seed, tests: plan.tests, ...(source ? { source: source.id } : {}) });
}

export function runExperiment(plan: ExperimentPlan, source?: DataSnapshot) {
  if (!validExperimentPlan(plan, source)) throw new Error('Plan integrity failure');
  const { held } = partitions(plan.seed, source);
  const observed = plan.tests.map(test => {
    const upper: number[] = [], lower: number[] = [];
    for (let i = test.lag; i < held.length; i++) {
      if (held[i].batch !== held[i - test.lag].batch || held[i].hour - held[i - test.lag].hour !== test.lag) continue;
      const group = held[i - test.lag][test.signal] >= test.threshold ? upper : lower;
      group.push(held[i].defect);
    }
    const effect = upper.length && lower.length ? round(mean(upper) - mean(lower)) : null;
    const signed = effect === null ? null : test.direction === 'positive' ? effect : -effect;
    const outcome = signed === null || Math.min(upper.length, lower.length) < test.minimumGroup ? 'INCONCLUSIVE'
      : signed >= test.minEffect ? 'PASS' : 'FAIL';
    return { hypothesisId: test.id, upper: upper.length, lower: lower.length, effect, outcome };
  });
  return { protocol, codeHash: createHash('sha256').update(runExperiment.toString()).digest('hex'), datasetVersion: plan.datasetVersion,
    planDigest: plan.digest, dataDigest: hash(held), observed };
}

export function validateExperiment(plan: ExperimentPlan, result: ExperimentResult, source?: DataSnapshot) {
  const { held } = partitions(plan.seed, source);
  const observed = plan.tests.map(test => {
    const counts = { upper: 0, upperDefects: 0, lower: 0, lowerDefects: 0 };
    held.forEach((row, index) => {
      const prior = held[index - test.lag];
      if (!prior || prior.batch !== row.batch || row.hour - prior.hour !== test.lag) return;
      if (prior[test.signal] >= test.threshold) {
        counts.upper++;
        counts.upperDefects += row.defect;
      } else {
        counts.lower++;
        counts.lowerDefects += row.defect;
      }
    });
    const { upper, lower, upperDefects, lowerDefects } = counts;
    const effect = upper && lower ? round(upperDefects / upper - lowerDefects / lower) : null;
    const signed = effect === null ? null : effect * (test.direction === 'negative' ? -1 : 1);
    const outcome = signed === null || upper < test.minimumGroup || lower < test.minimumGroup ? 'INCONCLUSIVE'
      : signed >= test.minEffect ? 'PASS' : 'FAIL';
    return { hypothesisId: test.id, upper, lower, effect, outcome };
  });
  const dataset = hash(held);
  const reproduced = validExperimentPlan(plan, source)
    && result.protocol === protocol && result.datasetVersion === plan.datasetVersion && plan.digest === result.planDigest
    && dataset === result.dataDigest && hash(observed) === hash(result.observed);
  return {
    validator: 'synthetic-association-validator/v1', input: plan.digest, dataset,
    independentReproducibility: reproduced ? 'PASS' : 'FAIL', causalIdentification: 'NOT_EVALUATED',
    experimentalSeverity: 'NOT_EVALUATED', formalValidity: 'NOT_EVALUATED',
    empiricalSupport: reproduced ? observed : [],
  };
}
