export function betaBinomialConfirmation(input: { alpha: number; beta: number; successes: number; trials: number }) {
  const { alpha, beta, successes, trials } = input;
  if (![alpha, beta].every(n => Number.isFinite(n) && n > 0 && n <= 1e9)
    || ![successes, trials].every(n => Number.isSafeInteger(n) && n >= 0) || successes > trials) {
    throw new Error('A declared proper prior and valid binomial observations are required');
  }
  const posterior = { alpha: alpha + successes, beta: beta + trials - successes };
  return { model: 'Beta-Binomial', assumptions: ['Conditional independence', 'Common Bernoulli probability'], posterior,
    posteriorMean: posterior.alpha / (posterior.alpha + posterior.beta) };
}

interface CausalNode { id: string; observed: boolean }
type Edge = [string, string];
export function checkBackdoor(nodes: CausalNode[], arrows: Edge[], exposure: string, outcome: string, adjusted: string[]) {
  const ids = new Map(nodes.map(node => [node.id, node]));
  if (nodes.length > 128 || ids.size !== nodes.length || exposure === outcome || !ids.get(exposure)?.observed || !ids.get(outcome)?.observed
    || arrows.length > 1024 || new Set(arrows.map(pair => JSON.stringify(pair))).size !== arrows.length
    || arrows.some(([a, b]) => a === b || !ids.has(a) || !ids.has(b)) || new Set(adjusted).size !== adjusted.length
    || adjusted.some(id => !ids.get(id)?.observed || id === exposure || id === outcome)) throw new Error('Invalid causal graph or adjustment set');
  const children = new Map(nodes.map(({ id }) => [id, arrows.filter(([from]) => from === id).map(([, to]) => to)]));
  const settled = new Set<string>(), visiting = new Set<string>();
  function visit(id: string) {
    if (settled.has(id)) return;
    if (visiting.has(id)) throw new Error('Expected a directed acyclic graph');
    visiting.add(id);
    for (const child of children.get(id)!) visit(child);
    visiting.delete(id);
    settled.add(id);
  }
  nodes.forEach(node => visit(node.id));
  const traverse = (start: string[], neighbours: (id: string) => string[]) => {
    const queue = [...start], seen = new Set(start);
    while (queue.length) {
      for (const next of neighbours(queue.pop()!)) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    return seen;
  };
  const descendants = traverse([exposure], id => children.get(id)!);
  if (adjusted.some(id => descendants.has(id))) return { satisfiesCriterion: false, reason: 'EXPOSURE_DESCENDANT', assumptionsVerified: false };
  const mutilated = arrows.filter(([from]) => from !== exposure);
  const parents = (to: string) => mutilated.filter(([, target]) => target === to).map(([from]) => from);
  const ancestors = traverse([exposure, outcome, ...adjusted], parents);
  const moral = new Map([...ancestors].map(id => [id, new Set<string>()]));
  const connect = (a: string, b: string) => { moral.get(a)!.add(b); moral.get(b)!.add(a); };
  for (const node of ancestors) {
    const incoming = parents(node);
    incoming.forEach((parent, index) => {
      connect(parent, node);
      incoming.slice(index + 1).forEach(other => connect(parent, other));
    });
  }
  const blocked = new Set(adjusted);
  const open = traverse([exposure], node => [...moral.get(node)!].filter(next => !blocked.has(next))).has(outcome);
  return { satisfiesCriterion: !open, reason: open ? 'OPEN_BACKDOOR_PATH' : 'BACKDOOR_PATHS_BLOCKED_IN_DECLARED_DAG', assumptionsVerified: false };
}
