import type { AgentRuntime } from './agents.ts';
import { demoObjective } from './benchmark.ts';
import { compilePreset, hash, snapshotRevisions, type MemoryMode, type Strategy } from './contracts.ts';
import { evaluateEvolution, smokeEvolution, statistics } from './evolution.ts';
import { breedGenome } from './kernel.ts';
import { ResearchOrchestrator } from './orchestrator.ts';
import { openStore, type ResearchStore } from './store.ts';
import { comparePaired, type RevisionKind, type TrialMetrics } from './revisions.ts';
export interface OperationalCandidate {
  configuration: { maxParallel: number } | { code: number }; parentId: string | null;
  evaluation: ReturnType<typeof comparePaired>; baseline: TrialMetrics[]; candidate: TrialMetrics[];
}

interface ConnectedOptions { full?: boolean; timeoutMs?: number; kernel?: string; checkpoint?: ResearchStore }

export async function compareConnectedResearch(runtime: AgentRuntime, options: ConnectedOptions = {}) {
  if (runtime.kind !== 'router' || !runtime.bindingId) throw new Error('Connected benchmark requires an explicitly configured Router');
  const bindingId = runtime.bindingId;
  const store = options.checkpoint;
  const policyParent = store?.activeRevision('policy', bindingId);
  const genomeParent = store?.activeRevision('genome', bindingId);
  const baselineParallel = policyParent?.configuration.maxParallel ?? 3;
  const baselineCode = genomeParent?.configuration.code ?? 0;
  const developmentSeeds = [11, 23];
  const heldOutSeeds = options.full ? Array.from({ length: 20 }, (_, i) => 42 + i * 997) : [42, 101, 509];
  const limits = { tasks: 36, timeoutMs: options.timeoutMs ?? 10_000, retries: 0 };
  const protocol = hash({ version: 'router-research/v2', bindingId, developmentSeeds, heldOutSeeds, limits,
    policyParent: policyParent?.id, genomeParent: genomeParent?.id, kernel: Boolean(options.kernel) });

  async function trial(seed: number, strategy: Strategy, memory: MemoryMode, parallel: number, code: number): Promise<TrialMetrics> {
    const key = hash({ seed, strategy, memory, parallel, code });
    const saved = store?.benchmarkTrial<TrialMetrics>(protocol, key);
    if (saved) return saved;
    const temporary = await openStore(':memory:');
    try {
      const base = compilePreset({ seed, strategy, memory, maxParallel: parallel, maxTasks: limits.tasks, timeoutMs: limits.timeoutMs, retries: limits.retries }, 'router', bindingId);
      const plan = code ? snapshotRevisions(base, { genome: { id: `evaluation:${code}`, code } }) : base;
      const run = temporary.create(demoObjective, plan);
      const lab = new ResearchOrchestrator(temporary, runtime, options.kernel);
      const view = await lab.runToCheckpoint(run.id);
      const validation = view.progressLedger.validation as { independentReproducibility?: string } | null;
      const review = view.researchLedger.arguments as { reviews?: { gates: Record<string, { status: string }> }[] } | null;
      const reviews = review?.reviews ?? [];
      const passes = reviews.reduce((score, item) => score
        + Number(item.gates.A.status === 'PASS') + Number(item.gates.C.status === 'PASS'), 0);
      const quality = reviews.length ? Math.round(16 * passes / (2 * reviews.length)) : 0;
      const result = { seed, validated: validation?.independentReproducibility === 'PASS' && ['SUCCESS', 'INCONCLUSIVE'].includes(view.run.status),
        failed: view.progressLedger.failed, quality, batches: view.events.filter(e => e.kind === 'topology.selected').length, tasks: view.tasks.length };
      return store?.recordBenchmarkTrial(protocol, key, result) ?? result;
    } finally { temporary.close(); }
  }

  async function group(seeds: number[], strategy: Strategy, memory: MemoryMode, parallel: number, code = baselineCode) {
    const rows = [];
    for (const seed of seeds) rows.push(await trial(seed, strategy, memory, parallel, code));
    return rows;
  }

  const policyDevelopment = [];
  for (const maxParallel of [1, 2, 3].filter(cap => cap !== baselineParallel)) {
    const rows = await group(developmentSeeds, 'evolutionary-hybrid', 'both', maxParallel);
    policyDevelopment.push({ maxParallel, rows, clean: rows.every(row => row.validated && !row.failed), batches: rows.reduce((sum, row) => sum + row.batches, 0) });
  }
  const selectedPolicy = policyDevelopment.filter(option => option.clean).sort((a, b) => a.batches - b.batches)[0]?.maxParallel ?? baselineParallel;
  const codes = new Set([1, 2, 4]);
  for (const seed of [41, 79, 113]) codes.add(1 + (breedGenome(seed, baselineCode, 15, 40, 50, options.kernel) % 15));
  codes.delete(baselineCode);
  const genomeDevelopment = [];
  async function develop(code: number) {
    const rows = await group(developmentSeeds, 'hybrid-adaptive', 'both', 3, code);
    return { code, parent: baselineCode, rows, clean: rows.every(row => row.validated && !row.failed), quality: rows.reduce((sum, row) => sum + row.quality, 0) };
  }
  for (const code of codes) genomeDevelopment.push(await develop(code));
  type Guidance = { code: number | null; status: 'PROPOSED' | 'UNAVAILABLE' };
  let guided = store?.benchmarkTrial<Guidance>(protocol, 'model-guided-development');
  if (!guided) {
    try {
      const code = await runtime.proposeGenome?.(genomeDevelopment.map(item => ({ code: item.code, quality: item.quality, validated: item.clean })),
        AbortSignal.timeout(limits.timeoutMs));
      guided = code === undefined ? { code: null, status: 'UNAVAILABLE' } : { code, status: 'PROPOSED' };
    } catch { guided = { code: null, status: 'UNAVAILABLE' }; }
    store?.recordBenchmarkTrial(protocol, 'model-guided-development', guided);
  }
  if (guided.code !== null && guided.code !== baselineCode && !codes.has(guided.code)) genomeDevelopment.push(await develop(guided.code));
  const selectedCode = genomeDevelopment.filter(option => option.clean).sort((a, b) => b.quality - a.quality)[0]?.code ?? baselineCode;

  const orchestration = [];
  for (const strategy of ['deterministic', 'cognitive-director', 'hybrid-adaptive', 'evolutionary-hybrid'] as const) {
    const runs = await group(heldOutSeeds, strategy, 'both', strategy === 'evolutionary-hybrid' ? selectedPolicy : 3);
    orchestration.push({ strategy, runs, batches: statistics(runs.map(row => row.batches)), validationRate: statistics(runs.map(row => Number(row.validated))) });
  }
  const memory = [];
  for (const mode of ['none', 'private', 'shared', 'both'] as const) {
    const runs = await group(heldOutSeeds, 'hybrid-adaptive', mode, 3);
    memory.push({ mode, runs, batches: statistics(runs.map(row => row.batches)) });
  }
  const policyBaseline = await group(heldOutSeeds, 'evolutionary-hybrid', 'both', baselineParallel);
  const policyTrial = orchestration.find(group => group.strategy === 'evolutionary-hybrid')!.runs;
  const genomeBaseline = await group(heldOutSeeds, 'hybrid-adaptive', 'both', 3);
  const genomeTrial = await group(heldOutSeeds, 'hybrid-adaptive', 'both', 3, selectedCode);
  const agentConditions = [];
  // Re-run each proxy condition's selected trait mask through the same model and held-out protocol.
  // This measures transfer of the proxy suggestion rather than pretending the proxy training used the model.
  const proxies = evaluateEvolution(smokeEvolution);
  const staticSeed = await group(heldOutSeeds, 'hybrid-adaptive', 'both', 3, 0);
  for (const condition of proxies.conditions) {
    const code = condition.condition === 'static' ? 0 : condition.runs[0].selected.code & 15;
    const runs = await group(heldOutSeeds, 'hybrid-adaptive', 'both', 3, code);
    agentConditions.push({ condition: condition.condition, code, runs, quality: statistics(runs.map(row => row.quality)),
      relativeToStatic: comparePaired(staticSeed, runs, 'genome') });
  }
  const candidates: Record<RevisionKind, OperationalCandidate> = {
    policy: { configuration: { maxParallel: selectedPolicy }, parentId: policyParent?.id ?? null, baseline: policyBaseline, candidate: policyTrial,
      evaluation: comparePaired(policyBaseline, policyTrial, 'policy') },
    genome: { configuration: { code: selectedCode }, parentId: genomeParent?.id ?? null, baseline: genomeBaseline, candidate: genomeTrial,
      evaluation: comparePaired(genomeBaseline, genomeTrial, 'genome') },
  };
  return { kind: 'ROUTER_CONNECTED_SYNTHETIC_STUDY', scope: options.full ? 'full-connected' : 'smoke-connected', protocol, bindingId,
    developmentSeeds, heldOutSeeds, limits, orchestration, memory, policyDevelopment, genomeDevelopment, guided, agentConditions, candidates,
    notes: ['Model transport uses the configured Router. Research observations and known evaluation criteria are synthetic.',
      'Development and held-out seeds differ. Candidate choice is frozen before the held-out runs. Activation requires an operator decision.'] };
}
