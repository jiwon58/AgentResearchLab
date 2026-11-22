import type { Argument, Hypothesis } from '../research/science.ts';

export type GateStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'NOT_APPLICABLE';
export const scientificFailures = ['UNSUPPORTED_CLAIM', 'INVALID_INFERENCE', 'MISSING_WARRANT', 'CONTRADICTORY_PREMISES',
  'UNFALSIFIABLE_HYPOTHESIS', 'WEAK_EXPERIMENTAL_DESIGN', 'INVALID_CAUSAL_CLAIM', 'EVIDENCE_REUSE_BIAS',
  'PREMATURE_CONSENSUS', 'RESEARCH_STAGNATION'] as const;
export type ScientificFailure = typeof scientificFailures[number];
export interface Finding { code: ScientificFailure; subject: string; refs: string[] }
export interface Gate { status: GateStatus; reasons: string[]; refs: string[] }
export const gate = (status: GateStatus, reasons: string[], refs: string[] = []): Gate => ({ status, reasons, refs });

export interface Formalization {
  rule: string;
  premises: { literal: string; evidenceRef: string }[];
  implication?: { antecedent: string; consequent: string; evidenceRef: string };
  conclusion: string;
}
export type CouncilArgument = Argument & { formalization?: Formalization; claimType: 'association' | 'causal' | 'exploratory' };
export const attackKinds = ['REBUTS', 'UNDERMINES', 'UNDERCUTS'] as const;
export type AttackKind = typeof attackKinds[number];
export type Relation = AttackKind | 'SUPPORTS' | 'DERIVED_FROM' | 'TESTED_BY' | 'CONTRADICTED_BY';
export interface Objection { id: string; target: string; relation: AttackKind; reason: string; evidenceRefs: string[]; criticalQuestion: string }
export interface Opening { issues: string[]; commonPremises: string[]; evidenceCriteria: string[] }
export interface Closing { unresolved: string[]; proposedExperiment: string; consensus: boolean }
export interface Evidence { id: string; snapshot: string; independenceGroup?: string; verified: boolean }
export interface GraphNode {
  id: string; kind: 'HYPOTHESIS' | 'ARGUMENT' | 'CLAIM' | 'PREMISE' | 'INFERENCE_RULE' | 'EVIDENCE' | 'OBJECTION' | 'PREDICTION' | 'EXPERIMENT';
  value: string; evidenceIds: string[]; agent: string; createdAt: number; status: GateStatus;
}
export interface GraphEdge {
  id: string; from: string; to: string; relation: Relation; evidenceIds: string[]; agent: string; createdAt: number; status: GateStatus;
}
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid structured reasoning output');
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum = 600): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error('Invalid reasoning text');
  return value.trim();
}

function list(value: unknown, minimum = 0, maximum = 12): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error('Invalid reasoning list');
  return value.map(item => text(item));
}

const toulminFields = ['claim', 'data', 'warrant', 'backing', 'qualifier', 'rebuttal'] as const;

export function addAbduction(hypotheses: Hypothesis[], source: unknown[]) {
  return hypotheses.map((hypothesis, index) => {
    const fields = record(record(source[index]).abduction);
    return { ...hypothesis, abduction: { scope: text(fields.scope), auxiliaryAssumptions: list(fields.auxiliaryAssumptions, 1, 8),
      expectedObservation: text(fields.expectedObservation), distinguishingPrediction: text(fields.distinguishingPrediction) } };
  });
}

export function missingToulmin(argument: Partial<Argument>) {
  return [...toulminFields.filter(key => !argument[key]?.trim()),
    ...(['assumptions', 'evidenceReferences', 'testablePredictions', 'falsificationConditions'] as const)
      .filter(key => !argument[key]?.some(item => Boolean(item.trim())))];
}

function formalization(value: unknown): Formalization | undefined {
  if (value == null) return;
  const input = record(value);
  if (!Array.isArray(input.premises) || input.premises.length > 24) throw new Error('Invalid premises');
  const premises = input.premises.map(item => {
    const p = record(item);
    return { literal: text(p.literal, 48), evidenceRef: typeof p.evidenceRef === 'string' ? p.evidenceRef.slice(0, 160) : '' };
  });
  const implication = input.implication == null ? undefined : record(input.implication);
  return { rule: text(input.rule, 40), premises, conclusion: text(input.conclusion, 48),
    implication: implication && { antecedent: text(implication.antecedent, 48), consequent: text(implication.consequent, 48),
      evidenceRef: typeof implication.evidenceRef === 'string' ? implication.evidenceRef.slice(0, 160) : '' } };
}

export function parseArguments(value: unknown, hypotheses: Hypothesis[]): CouncilArgument[] {
  if (!Array.isArray(value) || value.length !== hypotheses.length || value.length > 8) throw new Error('One Toulmin argument per hypothesis required');
  const output = value.map(item => {
    const input = record(item);
    const id = text(input.hypothesisId, 32);
    if (!hypotheses.some(candidate => candidate.id === id)) throw new Error('Unknown hypothesis reference');
    if (input.claimType !== 'association' && input.claimType !== 'causal' && input.claimType !== 'exploratory') {
      throw new Error('A supported claim type is required');
    }
    const prose = Object.fromEntries(toulminFields.map(key => [key, input[key] == null || input[key] === '' ? '' : text(input[key])])) as Pick<Argument, typeof toulminFields[number]>;
    return { id: `argument-${id}`, hypothesisId: id, ...prose, claimType: input.claimType, formalization: formalization(input.formalization),
      assumptions: list(input.assumptions ?? []), evidenceReferences: list(input.evidenceReferences ?? []),
      testablePredictions: list(input.testablePredictions ?? []), falsificationConditions: list(input.falsificationConditions ?? []) } satisfies CouncilArgument;
  });
  if (new Set(output.map(arg => arg.id)).size !== output.length) throw new Error('Duplicate Toulmin argument');
  return output;
}

export function parseOpening(value: unknown): Opening {
  const input = record(value);
  return { issues: list(input.issues, 1, 6), commonPremises: list(input.commonPremises, 1, 6), evidenceCriteria: list(input.evidenceCriteria, 1, 6) };
}

export function parseClosing(value: unknown): Closing {
  const input = record(value);
  if (typeof input.consensus !== 'boolean') throw new Error('Debate consensus must be declared explicitly');
  return { unresolved: list(input.unresolved, 0, 8), proposedExperiment: text(input.proposedExperiment), consensus: input.consensus };
}

export function parseObjections(value: unknown, allowedTargets: string[]): Objection[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) throw new Error('Expected bounded structured objections');
  return value.map((item, index) => {
    const input = record(item);
    const target = text(input.target, 60);
    if (!allowedTargets.includes(target) || !attackKinds.includes(input.relation as AttackKind)) throw new Error('Invalid attack relation');
    return { id: `objection-${index + 1}`, target, relation: input.relation as AttackKind,
      reason: text(input.reason), evidenceRefs: list(input.evidenceRefs ?? []), criticalQuestion: text(input.criticalQuestion) };
  });
}
