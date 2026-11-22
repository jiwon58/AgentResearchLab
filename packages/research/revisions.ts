import { isRecord } from './contracts.ts';
import { statistics } from './evolution.ts';

export type RevisionKind = 'policy' | 'genome';
export interface TrialMetrics { seed: number; validated: boolean; failed: number; quality: number; batches: number; tasks: number }
export interface RevisionConfiguration { maxParallel?: number; code?: number }

export function comparePaired(baseline: TrialMetrics[], candidate: TrialMetrics[], objective: RevisionKind) {
  const paired = baseline.length === candidate.length && new Set(baseline.map(row => row.seed)).size === baseline.length
    && baseline.every((row, i) => row.seed === candidate[i].seed);
  const clean = paired && baseline.every((row, i) => {
    const next = candidate[i];
    return row.validated && next.validated && row.failed === 0 && next.failed === 0 && next.quality >= row.quality
      && (objective === 'genome' || next.tasks <= row.tasks);
  });
  const changes = paired ? candidate.map((row, i) => objective === 'policy' ? baseline[i].batches - row.batches : row.quality - baseline[i].quality) : [];
  const delta = statistics(changes);
  const improves = changes.length >= 3 && changes.every(value => value >= 0) && (delta.approximate95?.[0] ?? 0) > 0;
  return { eligible: clean && improves, paired, clean, delta,
    criterion: objective === 'policy' ? 'FEWER_BATCHES_WITHOUT_REGRESSION' : 'IMPROVED_ARGUMENT_AND_TEST_GATES_WITHOUT_REGRESSION' };
}

export function readRevisionProof(report: unknown, kind: RevisionKind, binding: string) {
  if (!isRecord(report) || report.kind !== 'ROUTER_CONNECTED_SYNTHETIC_STUDY' || report.bindingId !== binding
    || typeof report.protocol !== 'string' || !/^[a-f0-9]{64}$/.test(report.protocol) || !isRecord(report.candidates)) throw new Error('Missing connected evaluation');
  const candidate = report.candidates[kind];
  if (!isRecord(candidate) || !isRecord(candidate.configuration)
    || candidate.parentId !== null && (typeof candidate.parentId !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.parentId))) throw new Error('Invalid revision proof');
  const field = kind === 'policy' ? 'maxParallel' : 'code';
  const value = candidate.configuration[field];
  if (Object.keys(candidate.configuration).length !== 1 || typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < (kind === 'policy' ? 1 : 0) || value > (kind === 'policy' ? 3 : 15)) throw new Error('Invalid revision configuration');
  const rows = (rows: unknown): TrialMetrics[] => {
    if (!Array.isArray(rows) || rows.length > 20 || rows.some(row => !isRecord(row) || typeof row.validated !== 'boolean'
      || ['seed', 'failed', 'quality', 'batches', 'tasks'].some(key => !Number.isSafeInteger(row[key]) || (row[key] as number) < 0)
      || (row.quality as number) > 16 || (row.tasks as number) > 36 || (row.batches as number) > 36)) throw new Error('Invalid benchmark receipts');
    return rows as TrialMetrics[];
  };
  const baseline = rows(candidate.baseline), evaluated = rows(candidate.candidate);
  if (!Array.isArray(report.heldOutSeeds) || baseline.length !== report.heldOutSeeds.length
    || baseline.some((row, index) => row.seed !== (report.heldOutSeeds as unknown[])[index])) throw new Error('Held-out receipts do not match the protocol');
  if (!Array.isArray(report.developmentSeeds) || new Set(report.developmentSeeds).size < 2
    || report.developmentSeeds.some(seed => !Number.isSafeInteger(seed) || baseline.some(row => row.seed === seed))) {
    throw new Error('Development and held-out partitions must be distinct');
  }
  const evaluation = comparePaired(baseline, evaluated, kind);
  if (!evaluation.eligible) throw new Error('No independently observed paired improvement');
  return { configuration: { [field]: value }, evaluation, parentId: candidate.parentId };
}
