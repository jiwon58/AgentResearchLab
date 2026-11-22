import { hash, isRecord, isTrialPreset, type Action, type Task, type Topology } from './contracts.ts';
import { type AgentContext, type AgentRuntime, nextManufacturingProposals, proposal } from './agents.ts';
import { type Claim, type ResearchStore, type TaskOutcome } from './store.ts';
import { argumentComplete, argumentsFor, datasetVersion, evidence, experimentPlan, parseHypotheses, runExperiment,
  validateExperiment, type Edge, type ExperimentPlan, type ExperimentResult, type Hypothesis } from './science.ts';
import { validateGraph } from './kernel.ts';
import type { ArtifactStore } from './artifacts.ts';
import { RouterError } from './router.ts';
import { reviewCouncil, type CouncilReview } from '../scientific-reasoning/council.ts';
import { appendObservedEvidence, auditSeverity, empiricalGate, evaluateProgramme } from '../scientific-reasoning/evaluation.ts';
import { addAbduction, parseArguments, parseClosing, parseObjections, parseOpening,
  type Closing, type CouncilArgument, type Finding, type Gate, type Objection, type Opening } from '../scientific-reasoning/schema.ts';
import { readPresetStudy, runPresetStudy, type PresetStudy } from './preset-studies.ts';
import { nativeReviewEvidence, nativeReviewOption } from './native-reviews.ts';
import { buildResearchFlow } from './research-flow.ts';
import { profileMl, runDataMl } from './data-ml.ts';

const resultOf = <T>(tasks: Task[], action: Action) => {
  const match = tasks.filter(task => task.action === action && task.status === 'DONE').at(-1);
  if (!match) throw new Error('Required task output unavailable');
  return match.result as T;
};

function ancestors(tasks: Task[], task: Task): Task[] {
  const available = new Map(tasks.map(item => [item.id, item]));
  const found = new Set<string>();
  const pending = [...task.proposal.dependencies];
  while (pending.length) {
    const id = pending.pop()!;
    if (found.has(id)) continue;
    const parent = available.get(id);
    if (!parent || parent.status !== 'DONE') throw new Error('Dependency unavailable');
    found.add(id);
    pending.push(...parent.proposal.dependencies);
  }
  return tasks.filter(item => found.has(item.id));
}

export function chooseTopology(tasks: Task[]): Topology {
  const batch = tasks.filter(task => task.status === 'QUEUED');
  const ready = batch.filter(task => task.proposal.dependencies.every(id => tasks.some(t => t.id === id && t.status === 'DONE')));
  if (new Set(ready.map(task => task.role)).size > 1) return 'PARALLEL_INDEPENDENT';
  if (ready.some(task => ['OPEN_DEBATE', 'CRITIQUE', 'MODERATE_DEBATE', 'REVIEW_ARGUMENTS'].includes(task.action))) return 'SCIENTIFIC_DEBATE';
  if (ready.some(task => task.proposal.proposer_agent_id !== 'director')) return 'HIERARCHICAL';
  if (batch.some(task => task.proposal.dependencies.length)) return 'DEPENDENCY_DAG';
  return 'SINGLE_AGENT';
}

type ExperimentValidation = ReturnType<typeof validateExperiment> & { scientific?: Record<string, Gate> };

export class ResearchOrchestrator {
  private readonly active = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  readonly store: ResearchStore;
  private readonly runtime: AgentRuntime;
  private readonly kernel?: string;
  private readonly artifacts?: ArtifactStore;

  constructor(store: ResearchStore, runtime: AgentRuntime, kernel?: string, artifacts?: ArtifactStore) {
    this.store = store;
    this.runtime = runtime;
    this.kernel = kernel;
    this.artifacts = artifacts;
  }

  tick(project: string): Promise<void> {
    const pending = this.active.get(project);
    if (pending) return pending;
    const promise = this.advance(project).finally(() => this.active.delete(project));
    this.active.set(project, promise);
    return promise;
  }

  async runToCheckpoint(project: string, maximumTicks = 100) {
    for (let tick = 0; tick < maximumTicks && this.store.run(project).status === 'ACTIVE'; tick++) {
      const before = this.store.events(project).length;
      await this.tick(project);
      if (before === this.store.events(project).length) break;
    }
    return this.view(project);
  }

  pause(project: string) { return this.store.changeStatus(project, 'PAUSED', 'OPERATOR_PAUSED_ADMISSION'); }
  resume(project: string) { return this.store.changeStatus(project, 'ACTIVE', 'OPERATOR_RESUMED'); }
  cancelTask(project: string, id: string) {
    const cancelled = this.store.cancelTask(project, id);
    if (cancelled) this.controllers.get(`${project}/${id}`)?.abort();
    return cancelled;
  }

  private async advance(project: string) {
    const run = this.store.run(project);
    if (run.status !== 'ACTIVE') return;
    if (run.plan.runtime !== this.runtime.kind || run.plan.runtimeBinding !== this.runtime.bindingId) {
      throw new Error('Run runtime does not match the configured host');
    }
    const current = this.store.tasks(project);
    const completed = current.find(task => task.action === 'COMPLETE' && task.status === 'DONE');
    const activeReview = current.some(task => task.action === 'DELEGATE_NATIVE_REVIEW' && ['QUEUED', 'RUNNING'].includes(task.status));
    if (completed && !activeReview) {
      if (this.store.proposals(project).some(item => item.payload.action_type === 'DELEGATE_NATIVE_REVIEW'
        && item.decision === 'NEEDS_HUMAN_APPROVAL')) return;
      if (run.plan.researchType !== 'causal-discovery') {
        const status = isTrialPreset(run.plan) ? resultOf<{ independentReproducibility: string }>(current, 'VALIDATE_PRESET_TRIAL')
          .independentReproducibility === 'PASS' ? 'SUCCESS' : 'FAILED' : 'INCONCLUSIVE';
        this.store.changeStatus(project, status, 'REGISTERED_PRESET_RECORDED');
        return;
      }
      const validation = resultOf<ExperimentValidation>(current, 'VALIDATE_RESULT');
      const supported = run.plan.reasoning ? Object.values(validation.scientific ?? {}).some(value => value.status === 'PASS')
        : validation.empiricalSupport.some(item => item.outcome === 'PASS');
      const status = validation.independentReproducibility === 'FAIL' ? 'FAILED'
        : supported ? 'SUCCESS' : 'INCONCLUSIVE';
      this.store.changeStatus(project, status, 'INDEPENDENT_RESULT_RECORDED');
      return;
    }
    if (!current.some(task => task.status === 'QUEUED' || task.status === 'RUNNING')) {
      const failed = current.some(task => task.status === 'FAILED' && !['REVIEW_STAGNATION', 'DELEGATE_NATIVE_REVIEW'].includes(task.action)
        && !current.some(next => next.action === task.action && next.status === 'DONE'));
      const canReview = run.plan.control === 'adaptive-v2' && run.plan.strategy !== 'deterministic'
        && !current.some(task => task.action === 'REVIEW_STAGNATION') && current.length < run.plan.maxTasks;
      if (failed) {
        this.store.checkpoint(project, 'stagnation.detected', { reason: 'TASK_RETRIES_EXHAUSTED' });
        if (canReview) this.store.submit(project, 'director', proposal(run, 'REVIEW_STAGNATION', 'director'));
        else {
          this.store.changeStatus(project, 'NEEDS_HUMAN', 'TASK_RETRIES_EXHAUSTED');
          return;
        }
      } else if (current.length >= run.plan.maxTasks) {
        this.store.changeStatus(project, 'BUDGET_EXCEEDED', 'TASK_LIMIT');
        return;
      } else if (run.plan.researchType === 'tabular-ml' && !current.length) {
        const collect = proposal(run, 'COLLECT_ML_DATA', 'director');
        const admitted = this.store.submit(project, 'director', collect);
        if (admitted.decision === 'APPROVED' && run.plan.maxTasks > 1) {
          this.store.submit(project, 'director', proposal(run, 'PROFILE_ML_DATA', 'director', [collect.proposal_id]));
        }
      } else if (run.plan.strategy === 'deterministic') {
        for (const p of nextManufacturingProposals(run, current)) this.store.submit(project, 'director', p);
      } else {
        const lastPlan = current.findLast(task => task.action === 'REPLAN');
        const latest = current.filter(task => !['REPLAN', 'REVIEW_STAGNATION'].includes(task.action) && task.status === 'DONE').slice(-4);
        const snapshot = hash(latest.map(task => task.id));
        if (lastPlan?.id === `replan-${snapshot}`) {
          this.store.checkpoint(project, 'stagnation.detected', { reason: 'NO_NEW_WORK', lastPlan: lastPlan.id });
          const pendingReview = this.store.proposals(project).some(p => p.decision === 'NEEDS_HUMAN_APPROVAL');
          if (canReview && !pendingReview) this.store.submit(project, 'director', proposal(run, 'REVIEW_STAGNATION', 'director'));
          else {
            this.store.changeStatus(project, pendingReview ? 'NEEDS_HUMAN' : 'EXHAUSTED', 'NO_NEW_WORK');
            return;
          }
        } else this.store.submit(project, 'director', proposal(run, 'REPLAN', 'director', latest.map(task => task.id), `-${snapshot}`));
      }
    }
    const refreshed = this.store.tasks(project);
    const adaptive = run.plan.strategy === 'hybrid-adaptive' || run.plan.strategy === 'evolutionary-hybrid';
    const topology = adaptive ? chooseTopology(refreshed) : 'SINGLE_AGENT';
    const limit = topology === 'PARALLEL_INDEPENDENT' ? Math.min(run.plan.maxParallel, run.plan.policy?.maxParallel ?? run.plan.maxParallel) : 1;
    const claims: Claim[] = [];
    for (let slot = 0; slot < limit; slot++) {
      const claim = this.store.claim(project);
      if (!claim) break;
      claims.push(claim);
    }
    if (claims.length) this.store.checkpoint(project, 'topology.selected', { topology, tasks: claims.map(claim => claim.task.id) });
    await Promise.all(claims.map(claim => this.execute(claim)));
  }

  private async execute(claim: Claim) {
    const { task } = claim;
    const run = this.store.run(task.research_id);
    const tasks = this.store.tasks(run.id);
    const context = { run, claim, tasks, memory: this.store.memory(run.id, task.role), messages: this.store.messages(run.id, task.role),
      branch: this.store.branchContext(run.id) };
    const controller = new AbortController();
    const key = `${run.id}/${task.id}`;
    this.controllers.set(key, controller);
    const timeout = setTimeout(() => controller.abort(new Error('Task deadline reached')), task.proposal.estimated_resources.time_ms);
    try {
      const outcome = await this.perform(context, controller.signal);
      controller.signal.throwIfAborted();
      this.store.finish(claim, outcome);
    } catch (error) {
      this.store.finish(claim, { error: controller.signal.aborted ? 'TASK_TIMEOUT' : error instanceof RouterError ? error.code : 'TASK_EXECUTION_FAILED' });
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(key);
    }
  }

  private async perform(context: AgentContext, signal: AbortSignal): Promise<TaskOutcome> {
    const { run, claim: { task }, tasks } = context;
    const history = ancestors(tasks, task);
    const measurements = () => run.plan.dataset ? this.store.dataset(run.plan.dataset) : undefined;
    const mlSnapshot = () => {
      if (!run.plan.mlDataset) throw new Error('A pinned ML dataset is required');
      const snapshot = this.store.mlDataset(run.plan.mlDataset.id);
      if (snapshot.kind !== run.plan.mlDataset.kind) throw new Error('ML task no longer matches its dataset');
      return snapshot;
    };
    const runTrial = (plan: PresetStudy) => run.plan.researchType === 'tabular-ml' ? runDataMl(mlSnapshot(), plan.candidates)
      : runPresetStudy(run.plan.researchType, plan, run.plan.seed);
    switch (task.action) {
      case 'REPLAN': {
        const response = await this.runtime.think(context, signal);
        if (!isRecord(response) || !Array.isArray(response.proposals)) throw new Error('Missing proposals');
        const followups = response.proposals.filter(item => !isRecord(item) || item.action_type !== 'REPLAN');
        return { result: { considered: response.proposals.length, runtime: this.runtime.kind }, followups };
      }
      case 'REVIEW_STAGNATION': {
        const response = await this.runtime.think(context, signal);
        if (!isRecord(response) || typeof response.recommendation !== 'string' || !response.recommendation.trim()
          || response.recommendation.length > 1800) throw new Error('Invalid recovery review');
        return { result: { recommendation: response.recommendation, interpretation: 'ADVISORY' },
          followups: Array.isArray(response.proposals) ? response.proposals : [],
          findings: [{ code: 'RESEARCH_STAGNATION', subject: 'run', refs: tasks.filter(t => t.status === 'FAILED').map(t => t.id) }] };
      }
      case 'COLLECT_ML_DATA': {
        const snapshot = mlSnapshot();
        return { result: { datasetVersion: snapshot.id, sourceVersion: snapshot.sourceVersion, rows: snapshot.rows.length,
          access: 'OPERATOR_REGISTERED_READ_ONLY' } };
      }
      case 'PROFILE_ML_DATA': {
        const profile = profileMl(mlSnapshot());
        if (profile.exactTargetMatches.length) throw new Error('A training feature duplicates the target');
        return { result: profile };
      }
      case 'PLAN_PRESET_STUDY': {
        const response = await this.runtime.think(context, signal);
        if (!isRecord(response)) throw new Error('Missing preset study plan');
        return { result: readPresetStudy(response.plan, run.plan.researchType, run.plan.mlDataset?.kind) };
      }
      case 'DELEGATE_NATIVE_REVIEW': {
        const name = task.proposal.native_review;
        if (this.runtime.kind !== 'gjc' || !name || !run.plan.native?.includes(name) || !this.runtime.nativeReview
          || !this.runtime.nativeReviews?.includes(name)) throw new Error('An approved native reviewer is required');
        const selectedEvidence = new Set(task.proposal.dependencies);
        const review = await this.runtime.nativeReview(name, run.objective, signal,
          nativeReviewEvidence(name, history.filter(item => selectedEvidence.has(item.id))));
        return { result: { name, ...review, disposition: 'ADVISORY' } };
      }
      case 'RUN_PRESET_TRIAL': {
        const result = runTrial(resultOf<PresetStudy>(history, 'PLAN_PRESET_STUDY'));
        return { result: { ...result, ...(this.artifacts ? { artifact: this.artifacts.put(result) } : {}) } };
      }
      case 'VALIDATE_PRESET_TRIAL': {
        const { artifact, ...observed } = resultOf<ReturnType<typeof runTrial> & { artifact?: { sha256: string } }>(history, 'RUN_PRESET_TRIAL');
        const replay = runTrial(resultOf<PresetStudy>(history, 'PLAN_PRESET_STUDY'));
        const persisted = !artifact || !this.artifacts || hash(this.artifacts.read(artifact.sha256)) === hash(observed);
        const reproduced = persisted && replay.selected !== null && hash(replay) === hash(observed);
        return { result: { independentReproducibility: reproduced ? 'PASS' : 'FAIL',
          comparison: run.plan.researchType === 'tabular-ml' ? 'REGISTERED_TABULAR_DATA' : 'SYNTHETIC_REGISTERED_FIXTURES',
          selected: replay.selected, validator: 'preset-deterministic-replay/v1' } };
      }
      case 'INVESTIGATE': return { result: evidence(run.plan.seed, measurements()) };
      case 'CHECK_DATA_QUALITY': {
        const snapshot = evidence(run.plan.seed, measurements());
        return { result: { rows: snapshot.rows, batches: snapshot.batches, snapshot: snapshot.snapshot, validation: 'DEVELOPMENT_SCHEMA_VERIFIED' } };
      }
      case 'GENERATE_HYPOTHESES': {
        const response = await this.runtime.think(context, signal);
        if (!isRecord(response) || !Array.isArray(response.hypotheses)) throw new Error('Missing hypotheses');
        const parsed = parseHypotheses(response.hypotheses).map(hypothesis => ({ ...hypothesis,
          parentIds: context.branch?.hypotheses.filter(previous => previous.signal === hypothesis.signal).slice(0, 1).map(previous => previous.id) ?? [] }));
        return { result: { hypotheses: run.plan.reasoning ? addAbduction(parsed, response.hypotheses) : parsed },
          followups: Array.isArray(response.proposals) ? response.proposals : [] };
      }
      case 'CONSTRUCT_ARGUMENTS': {
        const response = await this.runtime.think(context, signal);
        if (!isRecord(response)) throw new Error('Missing Toulmin arguments');
        const { hypotheses } = resultOf<{ hypotheses: Hypothesis[] }>(history, 'GENERATE_HYPOTHESES');
        return { result: { arguments: parseArguments(response.arguments, hypotheses) }, followups: Array.isArray(response.proposals) ? response.proposals : [] };
      }
      case 'OPEN_DEBATE': {
        const response = await this.runtime.think(context, signal);
        if (!isRecord(response)) throw new Error('Missing debate opening');
        return { result: { opening: parseOpening(response.opening) }, followups: Array.isArray(response.proposals) ? response.proposals : [] };
      }
      case 'CRITIQUE': {
        const response = await this.runtime.think(context, signal);
        if (!isRecord(response) || typeof response.critique !== 'string' || !response.critique.trim() || response.critique.length > 4000) {
          throw new Error('Invalid critique');
        }
        const objections = run.plan.reasoning ? parseObjections(response.objections,
          resultOf<{ arguments: CouncilArgument[] }>(history, 'CONSTRUCT_ARGUMENTS').arguments.map(argument => argument.id)) : undefined;
        return { result: { critique: response.critique, objections }, followups: Array.isArray(response.proposals) ? response.proposals : [] };
      }
      case 'MODERATE_DEBATE': {
        const response = await this.runtime.think(context, signal);
        if (!isRecord(response)) throw new Error('Missing debate conclusion');
        return { result: { closing: parseClosing(response.closing) } };
      }
      case 'REVIEW_ARGUMENTS': {
        const { hypotheses } = resultOf<{ hypotheses: Hypothesis[] }>(history, 'GENERATE_HYPOTHESES');
        const evidenceTask = history.find(t => t.action === 'INVESTIGATE')!;
        if (run.plan.reasoning) {
          const { graph, findings, ...result } = reviewCouncil({ hypotheses,
            args: resultOf<{ arguments: CouncilArgument[] }>(history, 'CONSTRUCT_ARGUMENTS').arguments,
            evidence: [{ id: evidenceTask.id, snapshot: (evidenceTask.result as ReturnType<typeof evidence>).snapshot, verified: true }],
            objections: resultOf<{ objections: Objection[] }>(history, 'CRITIQUE').objections,
            opening: resultOf<{ opening: Opening }>(history, 'OPEN_DEBATE').opening,
            closing: resultOf<{ closing: Closing }>(history, 'MODERATE_DEBATE').closing, at: Date.now(), kernel: this.kernel,
          });
          return { result, graph, findings };
        }
        const args = argumentsFor(hypotheses, evidenceTask.id);
        const critic = { id: 'critic-confounding', ...resultOf<{ critique: string }>(history, 'CRITIQUE') };
        const attacks: Edge[] = args.map(a => [critic.id, a.id]);
        return { result: { arguments: args, critic, attacks, accepted: validateGraph([...args.map(a => a.id), critic.id], attacks, this.kernel),
          dimensions: { argumentCompleteness: args.every(argumentComplete) ? 'PASS' : 'FAIL', evidenceProvenance: 'PASS',
            falsifiability: 'PASS', formalValidity: 'NOT_EVALUATED', empiricalSupport: 'NOT_EVALUATED' } } };
      }
      case 'DESIGN_EXPERIMENT': {
        const { hypotheses } = resultOf<{ hypotheses: Hypothesis[] }>(history, 'GENERATE_HYPOTHESES');
        if (run.plan.reasoning) {
          const review = resultOf<CouncilReview>(history, 'REVIEW_ARGUMENTS');
          const eligible = hypotheses.filter(h => review.eligibleHypotheses.includes(h.id));
          if (!eligible.length) throw new Error('Council did not clear an experiment');
          return { result: experimentPlan(run.plan.seed, eligible, measurements()) };
        }
        const review = resultOf<{ dimensions: { argumentCompleteness: string } }>(history, 'REVIEW_ARGUMENTS');
        if (review.dimensions.argumentCompleteness !== 'PASS') throw new Error('Argument gate failed');
        return { result: experimentPlan(run.plan.seed, hypotheses, measurements()) };
      }
      case 'AUDIT_SEVERITY': {
        const plan = resultOf<ExperimentPlan>(history, 'DESIGN_EXPERIMENT');
        const batchCount = plan.heldOutBatchCount ?? 12;
        const severity = auditSeverity({ preregistered: Boolean(plan.digest), independentUnits: batchCount });
        const findings: Finding[] = severity.status === 'PASS' ? [] : [{ code: 'WEAK_EXPERIMENTAL_DESIGN', subject: plan.digest, refs: [plan.digest] }];
        return { result: { gate: severity, analysisUnit: 'batch', plannedHoldoutBatches: batchCount, measurementReliability: 'UNVERIFIED',
          powerPlan: 'UNAVAILABLE', permittedUse: 'EXPLORATORY_ONLY', planDigest: plan.digest }, findings };
      }
      case 'RUN_EXPERIMENT': {
        const result = runExperiment(resultOf<ExperimentPlan>(history, 'DESIGN_EXPERIMENT'), measurements());
        return { result: { ...result, ...(this.artifacts ? { artifact: this.artifacts.put(result) } : {}) } };
      }
      case 'VALIDATE_RESULT': {
        const plan = resultOf<ExperimentPlan>(history, 'DESIGN_EXPERIMENT');
        const result = resultOf<ExperimentResult & { artifact?: { sha256: string } }>(history, 'RUN_EXPERIMENT');
        if (this.artifacts && result.artifact) {
          const { artifact, ...record } = result;
          if (hash(this.artifacts.read(artifact.sha256)) !== hash(record)) throw new Error('Artifact does not match the job result');
        }
        const validation = validateExperiment(plan, result, measurements());
        if (!run.plan.reasoning) return { result: validation };
        const review = resultOf<CouncilReview>(history, 'REVIEW_ARGUMENTS');
        const severity = resultOf<{ gate: Gate }>(history, 'AUDIT_SEVERITY').gate;
        const scientific = Object.fromEntries(review.reviews.map(row => [row.hypothesisId, context.branch && !context.branch.independentPartition
          ? { status: 'INCONCLUSIVE', reasons: ['PRIOR_DATASET_REUSED_BY_BRANCH'], refs: [plan.datasetVersion] } satisfies Gate : empiricalGate({
          observed: validation.empiricalSupport.find(item => item.hypothesisId === row.hypothesisId)?.outcome ?? 'INCONCLUSIVE',
          reproduction: validation.independentReproducibility, prerequisites: [...Object.values(row.gates), severity], claimType: row.claimType,
        })]));
        const reviewTask = history.findLast(item => item.action === 'REVIEW_ARGUMENTS')!;
        const graph = this.store.argumentGraph(run.id, reviewTask.id);
        const experiment = history.findLast(item => item.action === 'RUN_EXPERIMENT')!;
        return { result: { ...validation, experimentalSeverity: severity.status, formalValidity: review.dimensions.formalValidity,
          scientific, unresolved: ['Batch and calibration effects', 'Measurement reliability', 'Sensitivity to the alternative explanation'] },
        graph: graph && validation.independentReproducibility === 'PASS' ? appendObservedEvidence(graph, experiment.id,
          validation.dataset, validation.empiricalSupport, scientific, Date.now()) : undefined };
      }
      case 'REVIEW_PROGRAMME': {
        const { hypotheses } = resultOf<{ hypotheses: Hypothesis[] }>(history, 'GENERATE_HYPOTHESES');
        const validation = resultOf<ExperimentValidation>(history, 'VALIDATE_RESULT');
        const experiment = resultOf<ExperimentPlan>(history, 'DESIGN_EXPERIMENT');
        const confirmed = new Set(Object.entries(validation.scientific ?? {}).filter(([, check]) => check.status === 'PASS').map(([id]) => id));
        return { result: { ...evaluateProgramme(context.branch?.hypotheses ?? [], hypotheses, confirmed, new Set(experiment.tests.map(test => test.id))),
          nextSteps: ['Preregister an independent batch-level power plan', 'Calibrate and replicate sensor measurements', 'Test discriminating predictions on a separately collected dataset'] } };
      }
      case 'REFINE_HYPOTHESES': {
        const initial = resultOf<{ hypotheses: Hypothesis[] }>(history, 'GENERATE_HYPOTHESES').hypotheses;
        const report = resultOf<ExperimentValidation>(history, 'VALIDATE_RESULT');
        if (run.plan.reasoning) return { result: { hypotheses: initial.map(h => ({ ...h, id: `${h.id}-r2`, parentIds: [h.id],
          status: report.scientific?.[h.id]?.status ?? 'INCONCLUSIVE', assessmentOnly: true })) } };
        return { result: { hypotheses: initial.map(h => ({ ...h, id: `${h.id}-r2`, parentIds: [h.id],
          status: report.empiricalSupport.find(row => row.hypothesisId === h.id)?.outcome ?? 'INCONCLUSIVE' })) } };
      }
      case 'REQUEST_EVOLUTION': return { result: { status: 'RECORDED_FOR_INDEPENDENT_EVALUATION', dataset: datasetVersion } };
      case 'COMPLETE': return { result: { validation: task.proposal.dependencies, disposition: 'VALIDATION_RECORDED' } };
    }
  }

  view(project: string) {
    const run = this.store.run(project);
    const tasks = this.store.tasks(project);
    const events = this.store.events(project);
    const proposals = this.store.proposals(project);
    const completed = tasks.filter(t => t.status === 'DONE');
    const result = (action: Action) => completed.findLast(t => t.action === action)?.result ?? null;
    return {
      run, tasks, events, proposals, branch: this.store.branchContext(project) ?? null,
      researchFlow: buildResearchFlow(run.plan, run.status, tasks, proposals),
      researchRelations: this.store.researchRelations(project), genomeLineage: this.store.genomeLineage(run.plan),
      nativeReviewOptions: (run.plan.native ?? []).map(name => nativeReviewOption(name, tasks)),
      residents: this.store.residentView(project), messages: this.store.messages(project),
      researchLedger: { evidence: result('INVESTIGATE'), dataCollection: result('COLLECT_ML_DATA'), dataProfile: result('PROFILE_ML_DATA'),
        presetStudy: result('PLAN_PRESET_STUDY'), hypotheses: result('REFINE_HYPOTHESES') ?? result('GENERATE_HYPOTHESES'),
        arguments: result('REVIEW_ARGUMENTS'), argumentGraph: this.store.argumentGraph(project), plan: result('DESIGN_EXPERIMENT'),
        severity: result('AUDIT_SEVERITY'), programme: result('REVIEW_PROGRAMME') },
      scientificSim: this.store.scientificSim(project),
      progressLedger: { topology: events.findLast(event => event.kind === 'topology.selected')?.payload ?? null,
        experiment: result('RUN_EXPERIMENT') ?? result('RUN_PRESET_TRIAL'), validation: result('VALIDATE_RESULT') ?? result('VALIDATE_PRESET_TRIAL'), completed: completed.length,
        pending: tasks.filter(t => t.status === 'QUEUED' || t.status === 'RUNNING').length, failed: tasks.filter(t => t.status === 'FAILED').length },
    };
  }
}
