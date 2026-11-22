export function el(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

export function diagram(nodes, name, selected, onSelect, detail) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const layers = new Map();
  const visiting = new Set();
  function layer(node) {
    if (layers.has(node.id)) return layers.get(node.id);
    if (visiting.has(node.id)) return -1;
    visiting.add(node.id);
    const depth = Math.max(0, ...node.parents.filter(id => id !== node.id && byId.has(id)).map(id => layer(byId.get(id)) + 1));
    visiting.delete(node.id);
    layers.set(node.id, depth);
    return depth;
  }

  const viewport = el('div', undefined, 'diagram-viewport');
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', name);
  viewport.tabIndex = 0;
  const board = el('div', undefined, 'diagram-board');
  const canvas = el('canvas', undefined, 'diagram-edges');
  canvas.setAttribute('aria-hidden', 'true');
  const columns = [];
  const buttons = new Map();
  // Build the columns before attaching nodes, keeping keyboard order left to right.
  for (const node of nodes) {
    const depth = layer(node);
    columns[depth] ??= el('div', undefined, 'diagram-column');
    const control = el('button', undefined, 'diagram-node');
    control.type = 'button';
    control.dataset.nodeId = node.id;
    control.append(el('strong', node.title), ...(node.caption ? [el('span', node.caption)] : []), ...(node.badge ? [node.badge] : []));
    columns[depth].append(control);
    buttons.set(node.id, control);
    control.addEventListener('click', () => select(node));
  }
  board.append(canvas, ...columns);
  viewport.append(board);
  const inspector = el('div', undefined, 'diagram-inspector');
  inspector.setAttribute('aria-live', 'polite');
  const fragment = document.createDocumentFragment();
  fragment.append(viewport, inspector);

  function draw(active) {
    if (!board.isConnected) return;
    const width = board.offsetWidth;
    const height = board.offsetHeight;
    const scale = Math.min(window.devicePixelRatio || 1, 12000 / Math.max(width, height, 1));
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(scale, scale);
    const origin = board.getBoundingClientRect();
    const edges = nodes.flatMap(node => node.parents.filter(id => buttons.has(id) && id !== node.id)
      .map(parent => ({ parent, child: node.id, focused: parent === active || node.id === active })));
    for (const { parent, child, focused } of edges.sort((a, b) => Number(a.focused) - Number(b.focused))) {
      const from = buttons.get(parent).getBoundingClientRect();
      const to = buttons.get(child).getBoundingClientRect();
      const x1 = from.right - origin.left, y1 = from.top + from.height / 2 - origin.top;
      const x2 = to.left - origin.left - 2, y2 = to.top + to.height / 2 - origin.top;
      const middle = (x1 + x2) / 2;
      ctx.strokeStyle = focused ? '#08766a' : '#849eaf';
      ctx.lineWidth = focused ? 2 : 1.2;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(middle, y1, middle, y2, x2, y2);
      ctx.moveTo(x2 - 5, y2 - 3);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x2 - 5, y2 + 3);
      ctx.stroke();
    }
  }

  function select(node) {
    for (const [id, control] of buttons) control.setAttribute('aria-pressed', String(id === node.id));
    if (detail) inspector.replaceChildren(detail(node));
    draw(node.id);
    onSelect?.(node.id);
  }
  const initial = byId.get(selected) ?? nodes[0];
  if (initial) {
    select(initial);
    requestAnimationFrame(() => draw(initial.id));
  }
  return fragment;
}
