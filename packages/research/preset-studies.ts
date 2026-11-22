import { hash, isRecord, type Preset } from './contracts.ts';
import { random } from './science.ts';

const catalogue: Partial<Record<Preset['researchType'], readonly string[]>> = {
  'algorithm-research': ['insertion-sort', 'merge-sort', 'selection-sort'],
  'ml-optimization': ['majority', 'single-feature-threshold', 'linear-centroid'],
};
export const availablePresetCandidates = (type: Preset['researchType']) => catalogue[type] ?? [];

export interface PresetStudy {
  question: string;
  candidates: string[];
  ideas: { claim: string; falsifier: string }[];
}

const bounded = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= 600;
export function readPresetStudy(input: unknown, type: Preset['researchType']): PresetStudy {
  if (!isRecord(input) || !bounded(input.question)) throw new Error('Expected a research question');
  const allowed = availablePresetCandidates(type);
  if (allowed.length) {
    if (!Array.isArray(input.candidates) || input.candidates.length < 2 || input.candidates.length > allowed.length
      || new Set(input.candidates).size !== input.candidates.length || !input.candidates.every(name => allowed.includes(name))
      || !input.candidates.includes(allowed[0])) throw new Error('Expected an approved baseline and at least one registered alternative');
    return { question: input.question, candidates: [...input.candidates] as string[], ideas: [] };
  }
  if (!Array.isArray(input.ideas) || input.ideas.length < 2 || input.ideas.length > 6) throw new Error('Expected competing testable ideas');
  const ideas = input.ideas.map(idea => {
    if (!isRecord(idea) || !bounded(idea.claim) || !bounded(idea.falsifier)) throw new Error('A candidate idea requires a falsifier');
    return { claim: idea.claim, falsifier: idea.falsifier };
  });
  if (new Set(ideas.map(idea => idea.claim.trim().toLowerCase())).size !== ideas.length) throw new Error('Candidate ideas must be distinct');
  return { question: input.question, candidates: [], ideas };
}

function sortTrial(name: string, input: number[]) {
  let comparisons = 0;
  const before = (a: number, b: number) => { comparisons++; return a <= b; };
  const values = [...input];
  function merge(items: number[]): number[] {
    if (items.length < 2) return items;
    const middle = Math.floor(items.length / 2);
    const left = merge(items.slice(0, middle)), right = merge(items.slice(middle));
    const result: number[] = [];
    let a = 0, b = 0;
    while (a < left.length && b < right.length) result.push(before(left[a], right[b]) ? left[a++] : right[b++]);
    return result.concat(left.slice(a), right.slice(b));
  }
  if (name === 'insertion-sort') {
    for (let index = 1; index < values.length; index++) {
      const value = values[index];
      let position = index;
      while (position > 0 && !before(values[position - 1], value)) { values[position] = values[position - 1]; position--; }
      values[position] = value;
    }
  } else if (name === 'selection-sort') {
    for (let index = 0; index < values.length - 1; index++) {
      let lowest = index;
      for (let test = index + 1; test < values.length; test++) if (before(values[test], values[lowest])) lowest = test;
      [values[index], values[lowest]] = [values[lowest], values[index]];
    }
  } else if (name === 'merge-sort') values.splice(0, values.length, ...merge(values));
  else throw new Error('Unsupported sorting candidate');
  const oracle = [...input].sort((a, b) => a - b);
  return { comparisons, correct: values.length === oracle.length && values.every((item, index) => item === oracle[index]) };
}

interface Example { x: number[]; y: number }
function classifierData(seed: number, count: number): Example[] {
  const next = random(seed);
  return Array.from({ length: count }, () => {
    const x = [next(), next(), next()];
    return { x, y: Number(x[0] + 0.65 * x[1] - 0.3 * x[2] + 0.2 * next() >= 0.8) };
  });
}

function predictor(name: string, training: Example[]) {
  if (name === 'majority') {
    const decision = Number(training.filter(row => row.y === 1).length >= training.length / 2);
    return (_x: number[]) => decision;
  }
  if (name === 'single-feature-threshold') {
    const choices = Array.from({ length: 19 }, (_, i) => (i + 1) / 20);
    const scores = choices.map(threshold => training.filter(row => Number(row.x[0] >= threshold) === row.y).length);
    const best = choices[scores.indexOf(Math.max(...scores))];
    return (x: number[]) => Number(x[0] >= best);
  }
  if (name !== 'linear-centroid') throw new Error('Unsupported classifier candidate');
  const groups = [training.filter(row => row.y === 0), training.filter(row => row.y === 1)];
  if (groups.some(group => !group.length)) return predictor('majority', training);
  const means = groups.map(group => Array.from({ length: 3 }, (_, feature) => group.reduce((sum, row) => sum + row.x[feature], 0) / group.length));
  const distance = (a: number[], b: number[]) => a.reduce((sum, value, feature) => sum + (value - b[feature]) ** 2, 0);
  return (input: number[]) => Number(distance(input, means[1]) < distance(input, means[0]));
}

export function runPresetStudy(type: Preset['researchType'], input: PresetStudy, seed: number) {
  const plan = readPresetStudy(input, type);
  const developmentSeed = (seed ^ 0x6748a1ee) >>> 0;
  const heldOutSeed = (seed ^ 0x295708bf) >>> 0;
  const digest = hash({ type, plan, seed, version: 'registered-preset/v1' });
  if (type === 'algorithm-research') {
    function sample(s: number) {
      const next = random(s);
      return Array.from({ length: 10 }, (_, i) => Array.from({ length: 16 + i * 3 }, () => Math.floor(next() * 15) - 7));
    }
    const development = sample(developmentSeed), held = sample(heldOutSeed);
    const results = plan.candidates.map(candidate => {
      const score = (data: number[][]) => data.map(input => sortTrial(candidate, input));
      const dev = score(development), final = score(held);
      return { candidate, developmentCost: dev.reduce((sum, row) => sum + row.comparisons, 0), heldOutCost: final.reduce((sum, row) => sum + row.comparisons, 0),
        correct: [...dev, ...final].every(row => row.correct) };
    });
    return { kind: 'SORTING_BENCHMARK', digest, selected: results.filter(row => row.correct).sort((a, b) => a.developmentCost - b.developmentCost)[0]?.candidate ?? null,
      cases: held.length, metric: 'COMPARISONS_LOWER_IS_BETTER', results };
  }
  if (type !== 'ml-optimization') throw new Error('This preset records a study design without an executable protocol');
  const train = classifierData(seed, 180), validation = classifierData(developmentSeed, 90), held = classifierData(heldOutSeed, 90);
  const results = plan.candidates.map(candidate => {
    const predict = predictor(candidate, train);
    const accuracy = (rows: Example[]) => rows.filter(row => predict(row.x) === row.y).length / rows.length;
    return { candidate, developmentAccuracy: accuracy(validation), heldOutAccuracy: accuracy(held) };
  });
  return { kind: 'SYNTHETIC_CLASSIFIER_BENCHMARK', digest, selected: [...results].sort((a, b) => b.developmentAccuracy - a.developmentAccuracy)[0].candidate,
    cases: held.length, metric: 'ACCURACY_HIGHER_IS_BETTER', results };
}
