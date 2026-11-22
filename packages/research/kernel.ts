import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { grounded, type Edge } from './science.ts';

function invoke(binary: string, command: string, args: string[]): unknown {
  if (!isAbsolute(binary)) throw new Error('LAB_RUST_BIN must be an absolute path');
  const child = spawnSync(binary, ['v1', command, ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 2_000, maxBuffer: 32_768,
  });
  if (child.error || child.status !== 0) throw new Error('Research kernel failed');
  return JSON.parse(child.stdout);
}

export function validateGraph(vertices: string[], attacks: Edge[], binary?: string) {
  if (new Set(vertices).size !== vertices.length || vertices.length > 128
    || attacks.some(edge => !edge.every(id => vertices.includes(id)))) throw new Error('Invalid argument graph');
  if (!binary) return { implementation: 'typescript-v1', accepted: grounded(vertices, attacks) };
  const raw = attacks.map(([a, b]) => `${vertices.indexOf(a)}:${vertices.indexOf(b)}`).join(',');
  const output = invoke(binary, 'grounded', [String(vertices.length), raw]);
  if (!Array.isArray(output) || new Set(output).size !== output.length
    || !output.every(id => Number.isInteger(id) && id >= 0 && id < vertices.length)) throw new Error('Invalid kernel response');
  return { implementation: 'rust-v1', accepted: output.map(id => vertices[id]) };
}

export function breedGenome(seed: number, left: number, right: number, mutation: number, crossover: number, binary?: string) {
  if (binary) {
    const value = invoke(binary, 'breed', [seed, left, right, mutation, crossover].map(String));
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 65535) throw new Error('Invalid kernel response');
    return value;
  }
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 16;
  };
  const cross = next() % 100 < crossover;
  let code = 0;
  for (let index = 0; index < 8; index++) {
    const selected = cross && next() % 2 === 0 ? right : left;
    let trait = (selected >>> (2 * index)) & 3;
    if (next() % 100 < mutation) trait = (trait + 1 + next() % 3) % 4;
    code |= trait << (2 * index);
  }
  return code;
}
