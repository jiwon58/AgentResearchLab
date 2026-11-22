import { createHash } from 'node:crypto';

export const legacyRoles = ['director', 'evidence', 'hypothesis', 'skeptic', 'methodology', 'experiment', 'evolution'] as const;
export const councilRoles = [...legacyRoles, 'argumentation', 'moderator', 'severity', 'programme'] as const;
export const roles = [...councilRoles, 'meta-reviewer'] as const;
export type Role = (typeof roles)[number];
export const actionRoles = {
  INVESTIGATE: 'evidence', CHECK_DATA_QUALITY: 'methodology', GENERATE_HYPOTHESES: 'hypothesis', CRITIQUE: 'skeptic',
  REVIEW_ARGUMENTS: 'methodology', DESIGN_EXPERIMENT: 'experiment', RUN_EXPERIMENT: 'experiment',
  VALIDATE_RESULT: 'methodology', REFINE_HYPOTHESES: 'hypothesis', REPLAN: 'director',
  REQUEST_EVOLUTION: 'evolution', COMPLETE: 'director',
  CONSTRUCT_ARGUMENTS: 'argumentation', OPEN_DEBATE: 'moderator', MODERATE_DEBATE: 'moderator',
  AUDIT_SEVERITY: 'severity', REVIEW_PROGRAMME: 'programme',
  REVIEW_STAGNATION: 'meta-reviewer',
  PLAN_PRESET_STUDY: 'hypothesis', RUN_PRESET_TRIAL: 'experiment', VALIDATE_PRESET_TRIAL: 'methodology',
  DELEGATE_NATIVE_REVIEW: 'methodology',
} as const satisfies Record<string, Role>;
export type Action = keyof typeof actionRoles;
export const prerequisites: Partial<Record<Action, Action[]>> = {
  GENERATE_HYPOTHESES: ['INVESTIGATE', 'CHECK_DATA_QUALITY'], CRITIQUE: ['GENERATE_HYPOTHESES'],
  REVIEW_ARGUMENTS: ['GENERATE_HYPOTHESES', 'CRITIQUE'], DESIGN_EXPERIMENT: ['REVIEW_ARGUMENTS'],
  RUN_EXPERIMENT: ['DESIGN_EXPERIMENT'], VALIDATE_RESULT: ['RUN_EXPERIMENT'],
  REFINE_HYPOTHESES: ['GENERATE_HYPOTHESES', 'VALIDATE_RESULT'], COMPLETE: ['VALIDATE_RESULT', 'REFINE_HYPOTHESES'],
};
const councilPrerequisites: Partial<Record<Action, Action[]>> = {
  GENERATE_HYPOTHESES: prerequisites.GENERATE_HYPOTHESES,
  CONSTRUCT_ARGUMENTS: ['GENERATE_HYPOTHESES'], OPEN_DEBATE: ['CONSTRUCT_ARGUMENTS'],
  CRITIQUE: ['GENERATE_HYPOTHESES', 'OPEN_DEBATE'], MODERATE_DEBATE: ['OPEN_DEBATE', 'CRITIQUE'],
  REVIEW_ARGUMENTS: ['GENERATE_HYPOTHESES', 'CRITIQUE', 'MODERATE_DEBATE'], DESIGN_EXPERIMENT: prerequisites.DESIGN_EXPERIMENT,
  AUDIT_SEVERITY: ['DESIGN_EXPERIMENT'], RUN_EXPERIMENT: ['DESIGN_EXPERIMENT', 'AUDIT_SEVERITY'],
  VALIDATE_RESULT: prerequisites.VALIDATE_RESULT,
  REVIEW_PROGRAMME: ['GENERATE_HYPOTHESES', 'VALIDATE_RESULT'],
  REFINE_HYPOTHESES: ['GENERATE_HYPOTHESES', 'VALIDATE_RESULT', 'REVIEW_PROGRAMME'], COMPLETE: prerequisites.COMPLETE,
};
const presetTrialRequirements: Partial<Record<Action, Action[]>> = {
  PLAN_PRESET_STUDY: [], RUN_PRESET_TRIAL: ['PLAN_PRESET_STUDY'], VALIDATE_PRESET_TRIAL: ['RUN_PRESET_TRIAL'], COMPLETE: ['VALIDATE_PRESET_TRIAL'],
};
const presetPlanningRequirements: Partial<Record<Action, Action[]>> = { PLAN_PRESET_STUDY: [], COMPLETE: ['PLAN_PRESET_STUDY'] };
export const isTrialPreset = (plan: Plan) => plan.researchType === 'ml-optimization' || plan.researchType === 'algorithm-research';
export const researchRequirements = (plan: Plan) => plan.researchType !== 'causal-discovery'
  ? isTrialPreset(plan) ? presetTrialRequirements : presetPlanningRequirements
  : plan.reasoning === 'council-v1' ? councilPrerequisites : prerequisites;
export const availableActions = (plan: Plan) => [...new Set(['REPLAN', 'REVIEW_STAGNATION', ...Object.keys(researchRequirements(plan)),
  ...(plan.native?.length ? ['DELEGATE_NATIVE_REVIEW'] : []),
  ...(plan.researchType === 'causal-discovery' ? ['INVESTIGATE', 'CHECK_DATA_QUALITY', 'REQUEST_EVOLUTION'] : [])])] as Action[];
export const projectRoles = (plan: Plan): readonly Role[] => plan.control === 'adaptive-v2' ? roles
  : plan.reasoning === 'council-v1' ? councilRoles : legacyRoles;
export type Topology = 'SINGLE_AGENT' | 'PARALLEL_INDEPENDENT' | 'HIERARCHICAL' | 'SCIENTIFIC_DEBATE' | 'DEPENDENCY_DAG';
export type Decision = 'APPROVED' | 'REJECTED' | 'NEEDS_REVISION' | 'NEEDS_HUMAN_APPROVAL';
export type TaskStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';
export type RunStatus = 'ACTIVE' | 'PAUSED' | 'SUCCESS' | 'EXHAUSTED' | 'INCONCLUSIVE' | 'BUDGET_EXCEEDED' | 'NEEDS_HUMAN' | 'FAILED';
export const readOnlyNative = ['planner', 'architect', 'critic', 'deep-interview', 'ralplan'] as const;
export type NativeReview = (typeof readOnlyNative)[number];

export interface Proposal {
  proposal_id: string;
  research_id: string;
  proposer_agent_id: Role;
  action_type: Action;
  objective: string;
  target_agent_ids: [Role];
  rationale: string;
  evidence_refs: string[];
  assumptions: string[];
  dependencies: string[];
  expected_information_gain: number;
  estimated_resources: { time_ms: number };
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  uncertainty: number;
  alternative_actions: string[];
  native_review?: NativeReview;
}

export interface Task {
  id: string;
  research_id: string;
  role: Role;
  action: Action;
  status: TaskStatus;
  attempt: number;
  proposal: Proposal;
  result?: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hash(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (isRecord(item)) return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])]));
    return item;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 2000;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 24 && v.every(text);
const fraction = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;

export function parseProposal(v: unknown): Proposal {
  if (!isRecord(v) || !text(v.proposal_id) || !text(v.research_id) || !text(v.objective) || !text(v.rationale)
    || !roles.includes(v.proposer_agent_id as Role) || typeof v.action_type !== 'string' || !Object.hasOwn(actionRoles, v.action_type)
    || !Array.isArray(v.target_agent_ids) || v.target_agent_ids.length !== 1 || !roles.includes(v.target_agent_ids[0])
    || ![v.evidence_refs, v.assumptions, v.dependencies, v.alternative_actions].every(strings)
    || !fraction(v.expected_information_gain) || !fraction(v.uncertainty)
    || !['LOW', 'MEDIUM', 'HIGH'].includes(String(v.risk_level)) || !isRecord(v.estimated_resources)
    || typeof v.estimated_resources.time_ms !== 'number' || !Number.isSafeInteger(v.estimated_resources.time_ms)
    || v.estimated_resources.time_ms < 1 || v.estimated_resources.time_ms > 60_000) {
    throw new Error('Invalid research proposal');
  }
  // Project the allowlisted fields so model-supplied code, tools or configuration never enter execution state.
  const p = v as unknown as Proposal;
  if (p.action_type === 'DELEGATE_NATIVE_REVIEW' && !readOnlyNative.includes(p.native_review as NativeReview)) {
    throw new Error('Expected an approved read-only native reviewer');
  }
  return {
    proposal_id: p.proposal_id, research_id: p.research_id, proposer_agent_id: p.proposer_agent_id,
    action_type: p.action_type, objective: p.objective, target_agent_ids: [p.target_agent_ids[0]], rationale: p.rationale,
    evidence_refs: p.evidence_refs, assumptions: p.assumptions, dependencies: p.dependencies,
    expected_information_gain: p.expected_information_gain, estimated_resources: { time_ms: p.estimated_resources.time_ms },
    risk_level: p.risk_level, uncertainty: p.uncertainty, alternative_actions: p.alternative_actions,
    ...(p.action_type === 'DELEGATE_NATIVE_REVIEW' ? { native_review: p.native_review } : {}),
  };
}

export const philosophies = Object.freeze({
  peirce: 'Generate competing explanations and discriminating predictions.',
  toulmin: 'Record claim, data, warrant, backing, qualifier and rebuttal.',
  popper: 'Pre-register a measurable falsification condition.',
  mayo: 'Check sample size and whether the test could find a meaningful discrepancy.',
  lakatos: 'Preserve earlier revisions and require a novel prediction for progressive change.',
  dung: 'Calculate grounded acceptability independently from empirical support.',
  pragma: 'Establish confrontation and opening criteria, record objections, and preserve unresolved questions at conclusion.',
});

export const rolePhilosophies: Readonly<Record<Role, readonly (keyof typeof philosophies)[]>> = Object.freeze({
  director: ['peirce', 'lakatos'], evidence: ['toulmin', 'mayo'], hypothesis: ['peirce', 'popper', 'lakatos'],
  skeptic: ['popper', 'dung'], methodology: ['toulmin', 'mayo', 'dung'], experiment: ['popper', 'mayo'], evolution: ['lakatos', 'mayo'],
  argumentation: ['toulmin', 'dung'], moderator: ['pragma', 'dung'], severity: ['mayo', 'popper'], programme: ['lakatos', 'peirce'],
  'meta-reviewer': ['lakatos', 'mayo'],
});

export const researchTypes = ['causal-discovery', 'ml-optimization', 'idea-discovery', 'algorithm-research', 'custom-research'] as const;
const strategies = ['deterministic', 'cognitive-director', 'hybrid-adaptive', 'evolutionary-hybrid'] as const;
export type Strategy = (typeof strategies)[number];
export type MemoryMode = 'none' | 'private' | 'shared' | 'both';
export const defaultPreset = Object.freeze({
  version: 1, researchType: 'causal-discovery', strategy: 'hybrid-adaptive', timeoutMs: 10_000,
  maxTasks: 36, maxParallel: 3, retries: 1, memory: 'both', seed: 42, evolution: 'static-baseline',
} as const);
export interface Preset {
  version: 1; researchType: (typeof researchTypes)[number]; strategy: Strategy; timeoutMs: number;
  maxTasks: number; maxParallel: number; retries: number; memory: MemoryMode; seed: number;
  evolution: 'static-baseline' | 'quality-diversity';
}
export type Plan = Preset & { runtime: 'mock' | 'gjc' | 'router'; runtimeBinding?: string; reasoning?: 'council-v1'; control?: 'adaptive-v2';
  policy?: { id: string; maxParallel: number }; genome?: { id: string; code: number }; dataset?: string; native?: NativeReview[]; hash: string };

export function snapshotRevisions(plan: Plan, revisions: Pick<Plan, 'policy' | 'genome' | 'dataset' | 'native'> & { seed?: number }): Plan {
  const { hash: previous, ...snapshot } = { ...plan, ...revisions };
  return Object.freeze({ ...snapshot, hash: hash(snapshot) });
}

export function compilePreset(input: Partial<Preset> = {}, runtime: Plan['runtime'] = 'mock', runtimeBinding?: string,
  reasoning: 'legacy' | 'council-v1' = 'council-v1'): Plan {
  const p = { ...defaultPreset, ...(reasoning === 'legacy' ? { maxTasks: 24 } : {}), ...input };
  if (Object.keys(input).some(key => !Object.hasOwn(defaultPreset, key)) || p.version !== 1 || !researchTypes.includes(p.researchType)
    || !strategies.includes(p.strategy) || !['none', 'private', 'shared', 'both'].includes(p.memory)
    || !['static-baseline', 'quality-diversity'].includes(p.evolution)) throw new Error('Invalid preset');
  for (const [value, min, max] of [[p.timeoutMs, 100, 60_000], [p.maxTasks, 1, 100], [p.maxParallel, 1, 8],
    [p.retries, 0, 3], [p.seed, 0, 0xffffffff]]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid resource or seed setting');
  }
  const snapshot = { ...p, runtime, ...(runtimeBinding ? { runtimeBinding } : {}),
    ...(reasoning === 'council-v1' ? { reasoning, control: 'adaptive-v2' } : {}) } as Omit<Plan, 'hash'>;
  return Object.freeze({ ...snapshot, hash: hash(snapshot) });
}
