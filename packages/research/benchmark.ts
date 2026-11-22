import { MockAgentRuntime } from './agents.ts';
import { compilePreset, hash, type MemoryMode, type Strategy } from './contracts.ts';
import { benchmarkEvolution, evaluateEvolution, smokeEvolution, statistics } from './evolution.ts';
import { ResearchOrchestrator } from './orchestrator.ts';
import { openStore, type ResearchStore } from './store.ts';

export const demoObjective = 'Analyze manufacturing sensor measurements and defect rates, and compare falsifiable explanations.';

export async function manufacturingTrial(seed: number, strategy: Strategy, memory: MemoryMode, maxParallel: number, kernel?: string) {
  const store = await openStore(':memory:');
  try {
    const orchestrator = new ResearchOrchestrator(store, new MockAgentRuntime(), kernel);
    const run = store.create(demoObjective, compilePreset({ seed, strategy, memory, maxParallel }, 'mock', undefined, 'legacy'));
    const view = await orchestrator.runToCheckpoint(run.id);
    const validation = view.progressLedger.validation as { independentReproducibility?: string } | null;
    return { seed, status: view.run.status, completed: view.progressLedger.completed,
      batches: view.events.filter(e => e.kind === 'topology.selected').length,
      validated: validation?.independentReproducibility === 'PASS',
      fingerprint: hash({ hypotheses: view.researchLedger.hypotheses, validation }),
      delegationCount: view.events.filter(e => e.kind === 'agent.delegated').length };
  } finally { store.close(); }
}

export async function compareResearch(full: boolean, kernel?: string, checkpoint?: ResearchStore) {
  const config = full ? benchmarkEvolution : smokeEvolution;
  const devSeeds = [11, 23, 41];
  const heldSeeds = full ? Array.from({ length: 20 }, (_, i) => config.seeds[i % config.seeds.length] + i * 1009) : [42, 101, 509];
  const protocol = hash({ version: 'manufacturing-benchmark/v2', config, devSeeds, heldSeeds, kernel: Boolean(kernel) });
  async function trial(group: string, seed: number, strategy: Strategy, memory: MemoryMode, parallel: number) {
    const id = hash({ group, seed, strategy, memory, parallel });
    const saved = checkpoint?.benchmarkTrial<Awaited<ReturnType<typeof manufacturingTrial>>>(protocol, id);
    if (saved) return saved;
    const result = await manufacturingTrial(seed, strategy, memory, parallel, kernel);
    return checkpoint?.recordBenchmarkTrial(protocol, id, result) ?? result;
  }
  const policies = [];
  for (const maxParallel of [1, 2, 3]) {
    const results = [];
    for (const seed of devSeeds) results.push(await trial('policy-development', seed, 'hybrid-adaptive', 'both', maxParallel));
    policies.push({ maxParallel, batches: statistics(results.map(run => run.batches)).mean!, allValidated: results.every(run => run.validated) });
  }
  const base = policies.find(candidate => candidate.maxParallel === 3)!;
  const selected = policies.filter(candidate => candidate.allValidated)
    .sort((a, b) => a.batches - b.batches || a.maxParallel - b.maxParallel)[0] ?? base;
  const revision = { parent: hash(base), strategy: { maxParallel: selected.maxParallel }, development: policies,
    evaluation: 'minimum scheduled batches with reproduction gate', adoption: 'BENCHMARK_ONLY', hash: hash({ base, selected, devSeeds }) };
  const orchestration = [];
  for (const strategy of ['deterministic', 'cognitive-director', 'hybrid-adaptive', 'evolutionary-hybrid'] as const) {
    const runs = [];
    for (const seed of heldSeeds) runs.push(await trial('orchestration', seed, strategy, 'both', strategy === 'evolutionary-hybrid' ? selected.maxParallel : 3));
    orchestration.push({ strategy, runs, batches: statistics(runs.map(run => run.batches)), validationRate: statistics(runs.map(run => Number(run.validated))) });
  }
  const memory = [];
  for (const mode of ['none', 'private', 'shared', 'both'] as const) {
    const runs = [];
    for (const seed of heldSeeds) runs.push(await trial('memory', seed, 'hybrid-adaptive', mode, 3));
    memory.push({ mode, runs, batches: statistics(runs.map(run => run.batches)) });
  }
  const evolution = checkpoint?.benchmarkTrial<ReturnType<typeof evaluateEvolution>>(protocol, 'evolution') ?? evaluateEvolution(config, kernel);
  checkpoint?.recordBenchmarkTrial(protocol, 'evolution', evolution);
  return { kind: 'MOCK_AGENT_SYNTHETIC_STUDY', scope: full ? 'full-local' : 'smoke', protocol,
    developmentSeeds: devSeeds, heldOutSeeds: heldSeeds, orchestration, policyRevision: revision,
    memory, notes: ['Mock agents do not consult memory. The memory comparison checks non-interference.',
      'The selected policy is evaluated only in the benchmark and does not alter operational presets.'],
    evolution };
}
