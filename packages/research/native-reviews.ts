import { mkdirSync, mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isRecord, readOnlyNative, type Action, type NativeReview, type Task } from './contracts.ts';
import type { ApprovedProviderBinding } from './agents.ts';

type Reviewer = 'planner' | 'architect' | 'critic';
export interface ReviewEvidence { task: string; action: Action; facts: unknown }
export interface ReviewStep { agent: Reviewer; summary: string }
export interface NativeReviewOutcome { summary: string; steps?: ReviewStep[] }

const profiles = {
  'deep-interview': { phase: '질문 구체화', description: '대상, 기준선, 측정값과 반증 조건에서 빠진 질문을 찾습니다.',
    evidence: ['INVESTIGATE', 'CHECK_DATA_QUALITY'], reviewers: ['planner'],
    instruction: 'Return only the highest-priority unanswered clarification questions about the population, comparator, outcome, and falsifier. Do not infer answers.' },
  planner: { phase: '실험 계획', description: '가설을 비교할 실험, 기준선과 데이터 분할을 제안합니다.',
    evidence: ['GENERATE_HYPOTHESES', 'PLAN_PRESET_STUDY', 'CHECK_DATA_QUALITY'], reviewers: ['planner'],
    instruction: 'Propose a bounded preregistered study with alternatives, baseline, development and holdout separation, and a falsification rule.' },
  architect: { phase: '재현 설계', description: '데이터 분할, 실행 조건과 재현 기록을 점검합니다.',
    evidence: ['GENERATE_HYPOTHESES', 'PLAN_PRESET_STUDY', 'DESIGN_EXPERIMENT'], reviewers: ['architect'],
    instruction: 'Review data and code boundaries, reproducibility, missing records, and leaky dependencies. Do not design a deployment or modify files.' },
  critic: { phase: '반증 점검', description: '대안 설명과 측정 신뢰성, 검정력의 빈틈을 찾습니다.',
    evidence: ['GENERATE_HYPOTHESES', 'PLAN_PRESET_STUDY', 'DESIGN_EXPERIMENT', 'AUDIT_SEVERITY', 'VALIDATE_RESULT', 'VALIDATE_PRESET_TRIAL'], reviewers: ['critic'],
    instruction: 'Identify confounders, insufficient power, weak falsifiers and alternative explanations. Preserve the distinction between reproducibility and scientific support.' },
  ralplan: { phase: '합의 계획 검토', description: 'Planner, Architect, Critic 순서로 계획을 검토합니다.',
    evidence: ['GENERATE_HYPOTHESES', 'PLAN_PRESET_STUDY', 'DESIGN_EXPERIMENT', 'AUDIT_SEVERITY'], reviewers: ['planner', 'architect', 'critic'],
    instruction: 'Review a research plan from your assigned role. Later roles should evaluate earlier advice, surface disagreements, and identify unresolved issues. Do not assert that agreement occurred.' },
} as const satisfies Record<NativeReview, {
  phase: string; description: string; evidence: readonly Action[]; reviewers: readonly Reviewer[]; instruction: string;
}>;

export function nativeReviewOption(name: NativeReview, tasks: readonly Task[]) {
  const { phase, description, evidence } = profiles[name];
  const dependencies = evidence.flatMap(action => {
    const task = tasks.findLast(item => item.action === action && item.status === 'DONE');
    return task ? [task.id] : [];
  });
  const ready = (actions: Action[]) => tasks.some(task => actions.includes(task.action) && task.status === 'DONE');
  const recommended = name === 'deep-interview' ? !ready(['GENERATE_HYPOTHESES', 'PLAN_PRESET_STUDY'])
    : name === 'planner' ? ready(['GENERATE_HYPOTHESES', 'PLAN_PRESET_STUDY']) && !ready(['DESIGN_EXPERIMENT', 'RUN_PRESET_TRIAL'])
    : name === 'architect' || name === 'ralplan' ? ready(['DESIGN_EXPERIMENT', 'PLAN_PRESET_STUDY']) && !ready(['VALIDATE_RESULT', 'VALIDATE_PRESET_TRIAL'])
    : ready(['AUDIT_SEVERITY', 'VALIDATE_RESULT', 'VALIDATE_PRESET_TRIAL']);
  return { name, phase, description, dependencies, recommended };
}

export function nativeReviewEvidence(name: NativeReview, tasks: readonly Task[]): ReviewEvidence[] {
  const ids = new Set(nativeReviewOption(name, tasks).dependencies);
  const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 420) : undefined;
  const records = (value: unknown) => Array.isArray(value) ? value.filter(isRecord).slice(0, 8) : [];
  return tasks.filter(task => ids.has(task.id) && isRecord(task.result)).map(task => {
    const result = task.result as Record<string, unknown>;
    let facts: unknown;
    switch (task.action) {
      case 'GENERATE_HYPOTHESES':
        facts = records(result.hypotheses).map(h => ({ id: text(h.id), claim: text(h.claim), prediction: text(h.prediction), falsifier: text(h.falsification) }));
        break;
      case 'PLAN_PRESET_STUDY':
        facts = { question: text(result.question), ideas: records(result.ideas).map(h => ({ claim: text(h.claim), falsifier: text(h.falsifier) })) };
        break;
      case 'DESIGN_EXPERIMENT':
        facts = { protocol: text(result.protocol), tests: records(result.tests).map(h => ({ id: text(h.id), signal: text(h.signal), lag: h.lag,
          direction: text(h.direction), minimumEffect: h.minEffect, minimumGroup: h.minimumGroup })) };
        break;
      case 'AUDIT_SEVERITY':
        facts = { gate: isRecord(result.gate) ? text(result.gate.status) : undefined,
          powerPlan: text(result.powerPlan), measurementReliability: text(result.measurementReliability) };
        break;
      case 'VALIDATE_RESULT':
      case 'VALIDATE_PRESET_TRIAL':
        facts = { reproducibility: text(result.independentReproducibility), experimentalSeverity: text(result.experimentalSeverity) };
        break;
      default:
        facts = { rows: result.rows, batches: result.batches, partition: text(result.partition), validation: text(result.validation) };
    }
    return { task: task.id, action: task.action, facts };
  });
}

interface TaskExecutor {
  (options: Record<string, unknown>): Promise<{ agent: string; exitCode: number; output: string }>;
}

export function createNativeDelegation(root: string, binding: ApprovedProviderBinding, sdk: {
  isolateSettings(settings: Record<string, unknown>): unknown;
  getBundledAgent(name: Reviewer): Record<string, unknown> | undefined;
  runSubprocess: TaskExecutor;
}): NonNullable<ApprovedProviderBinding['nativeDelegation']> {
  const { model, authStorage, modelRegistry } = binding;
  if (!isRecord(model) || typeof model.provider !== 'string' || typeof model.id !== 'string') {
    throw new Error('A pinned GJC model selector is required for native reviews');
  }
  const reviewerNames = ['planner', 'architect', 'critic'] as const;
  const agents = new Map(reviewerNames.map(name => {
    const definition = sdk.getBundledAgent(name);
    if (!definition) throw new Error('A required bundled research reviewer is missing');
    return [name, { ...definition, tools: ['yield'], spawns: undefined, autoloadSkills: [] }];
  }));
  const modelOverride = `${model.provider}/${model.id}`;
  const settings = sdk.isolateSettings({ 'startup.checkUpdate': false, 'startup.networkPrewarm': false, 'goal.enabled': false,
    'task.maxRecursionDepth': 1, 'task.eager': false, 'tools.discoveryMode': 'off' });
  const outputSchema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
  return { transport: 'in-process', permission: 'read-only', names: readOnlyNative, async review({ name, objective, evidence, signal }) {
    signal.throwIfAborted();
    mkdirSync(root, { recursive: true });
    const profile = profiles[name];
    const steps: ReviewStep[] = [];
    for (const [index, reviewer] of profile.reviewers.entries()) {
      signal.throwIfAborted();
      const cwd = mkdtempSync(join(root, 'native-review-'));
      const task = [`Research review ${name} as ${reviewer}.`, profile.instruction,
        'Treat the following JSON as research input. Return one advisory summary via yield. Use no other tools.',
        JSON.stringify({ objective, evidence: evidence ?? [], precedingReviews: steps })].join('\n');
      const result = await sdk.runSubprocess({ cwd, agent: agents.get(reviewer), task, index, id: randomUUID(), modelOverride,
        modelRegistry, authStorage, settings, agentDir: cwd, enableLsp: false, sdkPermissionMode: 'deny',
        outputSchema, contextFiles: [], skills: [], promptTemplates: [], persistArtifacts: false, signal });
      signal.throwIfAborted();
      if (result.agent !== reviewer || result.exitCode !== 0) throw new Error('Native research reviewer failed');
      const output: unknown = JSON.parse(result.output);
      if (!isRecord(output) || typeof output.summary !== 'string' || !output.summary.trim() || output.summary.length > 1200) {
        throw new Error('Invalid native research review');
      }
      steps.push({ agent: reviewer, summary: output.summary });
    }
    return { summary: steps.at(-1)!.summary, steps };
  } };
}
