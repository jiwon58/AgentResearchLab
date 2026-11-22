import { hash } from './contracts.ts';
import { breedGenome } from './kernel.ts';
import { random } from './science.ts';

interface Example { signals: number[]; label: number }
const seedDefinition = Object.freeze({ version: 1, code: 0x5555, role: 'skeptic', tools: 'READ_ONLY',
  contracts: Object.freeze(['popper', 'dung']), evaluator: 'synthetic-diagnostic-ranking/v1' });
export const immutableSeed = Object.freeze({ ...seedDefinition, hash: hash(seedDefinition) });

interface Genome {
  revision: string; code: number; parents: string[]; generation: number; strategy: string;
}
interface Observation { fitness: number; diversity: number[] }
const weights = (genome: number) => Array.from({ length: 8 }, (_, index) => (genome >>> (2 * index)) & 3);
function examples(seed: number, count: number, transfer = false): Example[] {
  const next = random(seed);
  return Array.from({ length: count }, () => {
    const label = Math.floor(next() * 3);
    const signals = Array.from({ length: 8 }, (_, index) => next() * (transfer ? 1.2 : 1) + (index === label ? 0.72 : 0)
      + (index === label + 3 ? 0.26 : 0));
    return { signals, label };
  });
}

function evaluate(code: number, input: Example[]): Observation {
  const traits = weights(code);
  let correct = 0;
  for (const example of input) {
    let winner = 0;
    let best = -Infinity;
    for (let label = 0; label < 3; label++) {
      const score = traits[label] * example.signals[label] + traits[label + 3] * example.signals[label + 3]
        - (traits[6] * example.signals[6] + traits[7] * example.signals[7]) * (label === 0 ? 0.16 : 0.04);
      if (score > best) { best = score; winner = label; }
    }
    if (winner === example.label) correct++;
  }
  return { fitness: correct / input.length, diversity: [traits.slice(0, 3).filter(x => x > 0).length, traits[6] + traits[7]] };
}

function genome(code: number, parents: string[], generation: number, strategy: string): Genome {
  return { code, parents, generation, strategy, revision: hash({ seed: immutableSeed.hash, code, parents, generation, strategy }) };
}

export const evolutionConditions = ['static', 'ga', 'sim-ga', 'map-elites-sim', 'coevolution', 'specialization', 'continual'] as const;
type Condition = (typeof evolutionConditions)[number] | 'sim-roots';
interface Fitness { revision: string; code: number; fitness: number }
export interface EvolutionConfig { population: number; generations: number; mutation: number; crossover: number; elite: number; seeds: number[]; }
export const smokeEvolution = Object.freeze({ population: 4, generations: 2, mutation: 30, crossover: 50, elite: 1, seeds: [42] });
export const benchmarkEvolution = Object.freeze({ population: 12, generations: 10, mutation: 30, crossover: 50, elite: 2, seeds: [42, 101, 509, 823, 1619] });

function challenge(examples: Example[], code: number): Example[] {
  return examples.map(example => {
    if (code === 0) return example;
    const distractor = (example.label + 1 + (code & 1)) % 3;
    const intensity = 0.08 * (1 + ((code >> 1) & 3));
    return { label: example.label, signals: example.signals.map((value, index) =>
      index === distractor ? value + intensity : index === example.label + 3 ? Math.max(0, value - intensity) : value) };
  });
}

function evolve(condition: Condition, seed: number, config: EvolutionConfig, prior?: Genome, kernel?: string) {
  const next = random(seed);
  const development = examples(seed, 40);
  const selection = examples(seed ^ 0x2958f301, 40);
  const root = genome(immutableSeed.code, [], 0, 'seed');
  const lineage = new Map([[root.revision, root]]);
  if (prior) lineage.set(prior.revision, prior);
  const archive = new Map<string, Fitness>();
  const hallOfFame = [0];
  const opponentHistory: { generation: number; opponent: number; accuracy: number }[] = [];
  const sim: { generation: number; rootCause: string; predicted: number; observed: number | null; adoption: string }[] = [];
  let population = Array.from({ length: config.population }, (_, index) => index === 0 ? root : index === 1 && prior ? prior
    : genome(breedGenome(Math.floor(next() * 0x100000000), root.code, root.code, config.mutation, 0, kernel), [root.revision], 0, condition));
  const history: Fitness[][] = [];
  let evaluations = 0;
  let opponentEvaluations = 0;
  let adversary = 1;
  for (let generation = 0; generation < config.generations; generation++) {
    const pool = condition === 'static' ? Array.from({ length: config.population }, () => root) : population;
    const opponents = [...hallOfFame, adversary];
    const opponentSample = condition === 'coevolution' ? development.map((example, index) =>
      challenge([example], opponents[index % opponents.length])[0]) : development;
    const scored = pool.map(candidate => {
      lineage.set(candidate.revision, candidate);
      const fit = evaluate(candidate.code, opponentSample);
      evaluations++;
      if (condition === 'map-elites-sim') {
        const cell = fit.diversity.join(':');
        if ((archive.get(cell)?.fitness ?? -1) < fit.fitness) archive.set(cell, { revision: candidate.revision, code: candidate.code, fitness: fit.fitness });
      }
      return { candidate, fitness: fit.fitness };
    }).sort((a, b) => b.fitness - a.fitness || a.candidate.code - b.candidate.code);
    history.push(scored.map(item => ({ revision: item.candidate.revision, code: item.candidate.code, fitness: item.fitness })));
    if (sim.length) {
      const previous = sim.at(-1)!;
      if (previous.observed === null && condition !== 'sim-roots') previous.observed = scored[0].fitness;
    }
    if (generation + 1 === config.generations || condition === 'static') continue;
    if (condition === 'coevolution') {
      const adversaries = [0, adversary, 1 + Math.floor(next() * 8), 1 + Math.floor(next() * 8)];
      const ranked = adversaries.map(opponent => {
        const accuracy = evaluate(scored[0].candidate.code, challenge(development, opponent)).fitness;
        opponentEvaluations++;
        return { opponent, accuracy };
      }).sort((a, b) => a.accuracy - b.accuracy || a.opponent - b.opponent);
      adversary = ranked[0].opponent;
      if (!hallOfFame.includes(adversary)) hallOfFame.push(adversary);
      opponentHistory.push({ generation, ...ranked[0] });
    }
    const parents = () => {
      const a = Math.floor(next() * scored.length), b = Math.floor(next() * scored.length);
      return scored[Math.min(a, b)].candidate;
    };
    const elites = scored.slice(0, config.elite).map(item => item.candidate);
    const base = scored[0];
    const guided = condition === 'sim-ga' || condition === 'map-elites-sim' || condition === 'sim-roots';
    const cause = 'Development cases with low signal separation';
    const priorSignal = sim.at(-1);
    const mutation = guided && priorSignal?.observed !== null && priorSignal?.observed !== undefined
      && priorSignal.observed < priorSignal.predicted ? Math.min(100, config.mutation + 10) : config.mutation;
    if (guided) sim.push({ generation: generation + 1, rootCause: cause, predicted: Math.min(1, base.fitness + 0.02), observed: null, adoption: 'CANDIDATE_ONLY' });
    population = [...elites, ...Array.from({ length: config.population - elites.length }, () => {
      const left = parents(), right = parents();
      const archiveCandidates = [...archive.values()];
      const sampled = archiveCandidates[Math.floor(next() * archiveCandidates.length)];
      const donor = condition === 'map-elites-sim' && sampled ? lineage.get(sampled.revision)! : right;
      let code = breedGenome(Math.floor(next() * 0x100000000), left.code, donor.code, mutation, config.crossover, kernel);
      if (guided && base.fitness < 0.8) {
        // Explore the strongest diagnostic traits when development accuracy stagnates.
        const trait = Math.floor(next() * 3) * 2;
        code = (code & ~(3 << trait)) | (2 << trait);
      }
      if (condition === 'specialization') code = (code & ~0b11_11) | 0b00_11;
      return genome(code, [left.revision, donor.revision], generation + 1, condition);
    })];
  }
  const last = history.at(-1)!;
  const candidates = last.map(item => ({ item, selection: evaluate(item.code, selection).fitness }));
  candidates.sort((a, b) => b.selection - a.selection || a.item.code - b.item.code);
  const selected = lineage.get(candidates[0].item.revision)!;
  const selectedScore = candidates[0].selection;
  const baselineSelection = evaluate(root.code, selection).fitness;
  const chosen = selectedScore > baselineSelection ? selected : root;
  // This evaluation happens after the candidate is frozen, and is never used to choose the winner.
  const held = examples(seed ^ 0xb3d29516, 60);
  const transfer = examples(seed ^ 0x579caf07, 60, true);
  const heldOut = evaluate(chosen.code, held).fitness;
  const baseline = evaluate(root.code, held).fitness;
  return { selected: chosen, selectionScore: selectedScore, heldOut, baseline, transfer: evaluate(chosen.code, transfer).fitness,
    regression: heldOut < baseline, evaluations, selectionEvaluations: candidates.length + 1, lineage: [...lineage.values()], history,
    opponentEvaluations, hallOfFame: condition === 'coevolution' ? hallOfFame : [], opponentHistory,
    archive: Object.fromEntries(archive), sim, adoption: chosen === root ? 'SEED_RETAINED' : 'OFFLINE_CANDIDATE' };
}

export function statistics(values: number[]) {
  if (!values.length) return { n: 0, mean: null, variance: null, approximate95: null };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.length < 2 ? null : values.reduce((acc, number) => acc + (number - mean) ** 2, 0) / (values.length - 1);
  const df = values.length - 1;
  const critical = [0, 0, 12.706, 4.303, 3.182, 2.776, 2.571][values.length] ?? (1.96 + 2.373 / df + 2.824 / df ** 2);
  const margin = variance === null ? null : critical * Math.sqrt(variance / values.length);
  return { n: values.length, mean, variance, approximate95: margin === null ? null : [mean - margin, mean + margin] };
}

export function evaluateEvolution(config: EvolutionConfig = smokeEvolution, kernel?: string) {
  const evaluateCondition = (condition: Condition) => {
    let prior: Genome | undefined;
    const runs = config.seeds.map(seed => {
      const receipt = evolve(condition, seed, config, condition === 'continual' ? prior : undefined, kernel);
      if (condition === 'continual') prior = receipt.selected;
      return { seed, ...receipt };
    });
    return { condition, runs, heldOut: statistics(runs.map(run => run.heldOut)),
      pairedDelta: statistics(runs.map(run => run.heldOut - run.baseline)), regressionRate: statistics(runs.map(run => Number(run.regression))).mean };
  };
  const conditions = evolutionConditions.map(evaluateCondition);
  return {
    kind: 'DETERMINISTIC_SYNTHETIC_PROXY', kernel: kernel ? 'rust-v1' : 'typescript-v1', config, seed: immutableSeed,
    conditions,
    simAblation: [conditions.find(item => item.condition === 'ga')!, evaluateCondition('sim-roots'), conditions.find(item => item.condition === 'sim-ga')!],
  };
}
