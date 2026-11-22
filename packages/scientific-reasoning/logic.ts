import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { gate, type Formalization } from './schema.ts';

type Attack = [string, string];
export const formalIssues = ['MISSING_PROVENANCE', 'CONTRADICTORY_PREMISES', 'INVALID_INFERENCE', 'UNSUPPORTED_RULE'] as const;
type FormalIssue = typeof formalIssues[number];

function kernel(binary: string, command: string, args: string[]): unknown {
  if (!isAbsolute(binary)) throw new Error('LAB_RUST_BIN must be absolute');
  const child = spawnSync(binary, ['v1', command, ...args], { encoding: 'utf8', windowsHide: true, timeout: 2000, maxBuffer: 32768 });
  if (child.error || child.status !== 0) throw new Error('Scientific logic kernel could not evaluate the input');
  return JSON.parse(child.stdout);
}

export function evaluateAttacks(vertices: string[], attacks: Attack[], selected: string[] = [], binary?: string) {
  if (vertices.length > 128 || attacks.length > 500 || new Set(vertices).size !== vertices.length || new Set(selected).size !== selected.length
    || new Set(attacks.map(edge => JSON.stringify(edge))).size !== attacks.length
    || !selected.every(id => vertices.includes(id)) || !attacks.every(([a, b]) => vertices.includes(a) && vertices.includes(b))) {
    throw new Error('Invalid argumentation framework');
  }
  if (binary) {
    const raw = kernel(binary, 'argumentation', [String(vertices.length), attacks.map(([a, b]) => `${vertices.indexOf(a)}:${vertices.indexOf(b)}`).join(','),
      selected.map(id => vertices.indexOf(id)).join(',')]) as { accepted?: unknown; defended?: unknown; conflictFree?: unknown };
    const extract = (value: unknown) => {
      if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(index => !Number.isInteger(index) || index < 0 || index >= vertices.length)) {
        throw new Error('Invalid Rust logic output');
      }
      return value.map(index => vertices[index]);
    };
    if (typeof raw.conflictFree !== 'boolean') throw new Error('Invalid Rust logic output');
    return { implementation: 'rust-logic-v1', accepted: extract(raw.accepted), defended: extract(raw.defended), conflictFree: raw.conflictFree };
  }
  function defense(group: string[]) {
    const countered = new Set(attacks.filter(([attacker]) => group.includes(attacker)).map(([, target]) => target));
    return vertices.filter(vertex => attacks.every(([attacker, target]) => target !== vertex || countered.has(attacker)));
  }
  let accepted: string[] = [];
  while (true) {
    const next = defense(accepted);
    if (next.length === accepted.length) break;
    accepted = next;
  }
  return { implementation: 'typescript-logic-v1', accepted, defended: defense(selected),
    conflictFree: attacks.every(([a, b]) => !selected.includes(a) || !selected.includes(b)) };
}

export function evaluateFormal(input: Formalization | undefined, sources: string[], binary?: string, reviewedMapping = false) {
  if (!input) return { symbolic: gate('INCONCLUSIVE', ['NO_FORMALIZATION']), alignment: gate('INCONCLUSIVE', ['NO_REVIEWED_MAPPING']), issues: [] as FormalIssue[] };
  const vocabulary = new Map<string, number>();
  const encode = (value: string) => {
    if (!/^!?[a-z][a-z0-9_]{0,46}$/.test(value)) return 0;
    const key = value.replace(/^!/, '');
    if (!vocabulary.has(key)) vocabulary.set(key, vocabulary.size + 1);
    return vocabulary.get(key)! * (value.startsWith('!') ? -1 : 1);
  };
  const atoms = input.premises.map(p => encode(p.literal));
  const conclusion = encode(input.conclusion);
  const antecedent = input.implication ? encode(input.implication.antecedent) : 0;
  const consequent = input.implication ? encode(input.implication.consequent) : 0;
  const provenance = input.premises.map(p => sources.indexOf(p.evidenceRef));
  if (input.rule === 'MODUS_PONENS') provenance.push(sources.indexOf(input.implication?.evidenceRef ?? ''));
  const alignment = reviewedMapping ? gate('PASS', ['MAPPING_REVIEWED']) : gate('INCONCLUSIVE', ['NO_REVIEWED_MAPPING']);
  if (!conclusion || atoms.includes(0) || input.implication && (!antecedent || !consequent)) {
    return { symbolic: gate('INCONCLUSIVE', ['UNSUPPORTED_LITERAL']), alignment, issues: [] as FormalIssue[] };
  }
  let issues: FormalIssue[] = [];
  if (binary) {
    const output = kernel(binary, 'formal', [input.rule, atoms.join(','), provenance.join(','), String(sources.length),
      String(antecedent), String(consequent), String(conclusion)]);
    if (!Array.isArray(output) || !output.every(code => formalIssues.includes(code))) throw new Error('Invalid Rust inference response');
    issues = output;
  } else {
    if (!atoms.length || provenance.includes(-1)) issues.push('MISSING_PROVENANCE');
    if (atoms.some(atom => atoms.includes(-atom))) issues.push('CONTRADICTORY_PREMISES');
    if (input.rule === 'FACT' ? !atoms.includes(conclusion)
      : input.rule === 'MODUS_PONENS' && (!atoms.includes(antecedent) || consequent !== conclusion)) issues.push('INVALID_INFERENCE');
    if (!['FACT', 'MODUS_PONENS'].includes(input.rule)) issues.push('UNSUPPORTED_RULE');
  }
  return { symbolic: gate(issues.some(code => code !== 'UNSUPPORTED_RULE') ? 'FAIL' : issues.length ? 'INCONCLUSIVE' : 'PASS',
    issues.length ? issues : ['SYMBOLIC_DERIVATION_VALID']), alignment, issues };
}
