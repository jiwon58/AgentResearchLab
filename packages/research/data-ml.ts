import { createHash } from 'node:crypto';
import { hash, isRecord } from './contracts.ts';
import { random } from './science.ts';

export type MlKind = 'classification' | 'regression';
type MlRow = { x: number[]; y: number; group: string };
export interface MlDataset {
  kind: MlKind; target: string; features: string[]; split: 'grouped' | 'ordered'; group: string | null;
  classes: string[]; rows: MlRow[];
}
export type MlSnapshot = MlDataset & { id: string; sourceVersion: string };
export class MlDataError extends Error {}
export const mlCandidates = {
  classification: ['majority', 'single-feature-threshold', 'linear-centroid'],
  regression: ['mean', 'single-feature-linear', 'ridge'],
} as const;

function readCsv(text: string, delimiter: ',' | ';'): unknown[] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, afterQuote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else field += char;
    } else if (char === delimiter || char === '\n' || char === '\r') {
      row.push(field); field = ''; afterQuote = false;
      if (char !== delimiter) {
        if (char === '\r' && text[i + 1] === '\n') i++;
        if (row.length !== 1 || row[0] !== '') rows.push(row);
        row = [];
      }
    } else if (char === '"' && field === '' && !afterQuote) quoted = true;
    else if (char === '"' || afterQuote) throw new MlDataError('CSV 따옴표 형식을 확인하세요.');
    else field += char;
  }
  if (quoted) throw new MlDataError('닫히지 않은 CSV 따옴표가 있습니다.');
  if (field || row.length || afterQuote) rows.push([...row, field]);
  const header = rows.shift() ?? [];
  const columns = header.map(item => item.trim());
  if (columns.some(item => !item) || new Set(columns).size !== columns.length || rows.some(item => item.length !== columns.length)) {
    throw new MlDataError('CSV 열 이름은 고유해야 하며 각 행은 같은 수의 열을 가져야 합니다.');
  }
  return rows.map(item => Object.fromEntries(columns.map((key, index) => [key, item[index]])));
}

function numeric(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?$/i.test(value.trim())
    ? Number(value) : NaN;
  if (!Number.isFinite(number) || Math.abs(number) > 1e12) throw new MlDataError('선택한 수치 열에 빈 값, 숫자가 아닌 값, 또는 범위 밖 값이 있습니다.');
  return number === 0 ? 0 : number;
}

function category(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new MlDataError('대상 또는 그룹 값이 비어 있습니다.');
  const label = String(value).trim();
  if (!label || label.length > 120) throw new MlDataError('대상 또는 그룹 값의 길이를 확인하세요.');
  return label;
}

export function parseMlFile(input: unknown) {
  if (!isRecord(input) || typeof input.content !== 'string' || Buffer.byteLength(input.content) > 1_000_000
    || !['csv', 'json'].includes(String(input.format)) || (input.kind !== 'classification' && input.kind !== 'regression')
    || (input.split !== 'grouped' && input.split !== 'ordered') || (input.delimiter != null && input.delimiter !== ',' && input.delimiter !== ';')) {
    throw new MlDataError('1MB 이하의 CSV·JSON 파일과 연구 유형, 분할 방식을 지정하세요.');
  }
  const kind = input.kind, split = input.split;
  const validColumn = (value: unknown): value is string => typeof value === 'string' && /^[^\u0000-\u001f\u007f]{1,120}$/u.test(value.trim());
  if (!validColumn(input.target) || !Array.isArray(input.features) || !input.features.length || input.features.length > 24
    || !input.features.every(validColumn) || (input.group != null && input.group !== '' && !validColumn(input.group))) {
    throw new MlDataError('대상 열 하나와 수치 특성 열 1~24개를 지정하세요.');
  }
  const target = input.target.trim(), features = input.features.map(item => item.trim());
  const group = typeof input.group === 'string' && input.group.trim() ? input.group.trim() : null;
  if (new Set(features).size !== features.length || features.includes(target) || (group !== null && (target === group || features.includes(group)))) {
    throw new MlDataError('대상·특성·그룹 열은 서로 달라야 합니다.');
  }
  const text = input.content.replace(/^\uFEFF/, '');
  let raw: unknown;
  try { raw = input.format === 'csv' ? readCsv(text, input.delimiter ?? ',') : JSON.parse(text); }
  catch (error) { if (error instanceof MlDataError) throw error; throw new MlDataError('JSON 형식을 확인하세요.'); }
  if (!Array.isArray(raw) || raw.length < 60 || raw.length > 10_000 || !raw.every(isRecord)) throw new MlDataError('레코드 60~10,000개가 필요합니다.');
  const columnNames = [target, ...features, ...(group ? [group] : [])];
  if (raw.some(row => columnNames.some(name => !Object.hasOwn(row, name)))) throw new MlDataError('파일에서 선택한 열을 찾을 수 없습니다.');
  const classes = kind === 'classification' ? [...new Set(raw.map(row => category(row[target])))].sort() : [];
  if (kind === 'classification' && classes.length !== 2) throw new MlDataError('이진 분류의 대상 열에는 두 범주가 필요합니다.');
  const rows = raw.map(row => {
    const x = features.map(name => numeric(row[name]));
    return { x, y: kind === 'classification' ? classes.indexOf(category(row[target])) : numeric(row[target]),
      group: group ? hash(category(row[group])) : hash(x) };
  });
  const dataset: MlDataset = { kind, target, features, split, group, classes, rows };
  const id = hash(dataset);
  const sourceVersion = createHash('sha256').update(input.content).digest('hex');
  if (profileMl({ ...dataset, id, sourceVersion }).exactTargetMatches.length) {
    throw new MlDataError('학습 구간에서 대상 열과 값이 같은 특성이 있습니다. 해당 특성을 제외하고 다시 등록하세요.');
  }
  return { dataset, id, sourceVersion };
}

function splitMl(dataset: MlDataset) {
  const buckets = new Map<string, MlRow[]>();
  for (const row of dataset.rows) {
    const bucket = buckets.get(row.group) ?? [];
    bucket.push(row);
    buckets.set(row.group, bucket);
  }
  let partitions: MlRow[][];
  if (dataset.split === 'ordered') {
    const first = Math.floor(dataset.rows.length * 0.6), second = Math.floor(dataset.rows.length * 0.8);
    partitions = [dataset.rows.slice(0, first), dataset.rows.slice(first, second), dataset.rows.slice(second)];
  } else {
    const groups = [...buckets.keys()].sort().map(key => buckets.get(key)!);
    const next = random(0x6cb87123);
    for (let i = groups.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [groups[i], groups[j]] = [groups[j], groups[i]];
    }
    partitions = [[], [], []];
    let count = 0;
    for (const group of groups) {
      const section = count < dataset.rows.length * 0.6 ? 0 : count < dataset.rows.length * 0.8 ? 1 : 2;
      for (const row of group) partitions[section].push(row);
      count += group.length;
    }
  }
  const seen = new Map<string, number>();
  for (const [index, rows] of partitions.entries()) {
    if (rows.length < 8 || (dataset.kind === 'classification' && [0, 1].some(label => rows.filter(row => row.y === label).length < 2))) {
      throw new MlDataError('학습·개발·보류 구간의 표본 또는 클래스가 부족합니다. 파일이나 그룹·정렬 방식을 확인하세요.');
    }
    for (const row of rows) {
      for (const key of [`group:${row.group}`, `features:${hash(row.x)}`]) {
        if (seen.has(key) && seen.get(key) !== index) throw new MlDataError('동일한 그룹 또는 특성 조합이 여러 구간에 있습니다. 그룹 열이나 분할 방식을 확인하세요.');
        seen.set(key, index);
      }
    }
  }
  return partitions as [MlRow[], MlRow[], MlRow[]];
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

export function profileMl(snapshot: MlSnapshot) {
  const [train, development, held] = splitMl(snapshot);
  const numericLabels = snapshot.classes.map(Number);
  const comparableTarget = snapshot.kind === 'regression' || numericLabels.every(Number.isFinite);
  const features = snapshot.features.map((_, index) => {
    const values = train.map(row => row.x[index]);
    return { index, constant: values.every(value => value === values[0]),
      exactTargetMatch: comparableTarget && train.every(row => row.x[index] === (snapshot.kind === 'regression' ? row.y : numericLabels[row.y])) };
  });
  return { datasetVersion: snapshot.id, protocol: 'tabular-ml/v1', task: snapshot.kind, split: snapshot.split,
    trainingRows: train.length, developmentRows: development.length, heldOutRows: held.length,
    features: features.length, constants: features.filter(item => item.constant).map(item => item.index),
    exactTargetMatches: features.filter(item => item.exactTargetMatch).map(item => item.index), partitionDigest: hash([train, development, held]) };
}

function fit(name: string, rows: MlRow[], width: number): (x: number[]) => number {
  const center = mean(rows.map(row => row.y));
  if (name === 'majority') return () => Number(center >= 0.5);
  if (name === 'mean') return () => center;
  const positions = Array.from({ length: width }, (_, index) => index);
  const average = positions.map(index => mean(rows.map(row => row.x[index])));
  const scale = positions.map(index => Math.sqrt(mean(rows.map(row => (row.x[index] - average[index]) ** 2))) || 1);
  const normalize = (x: number[]) => x.map((value, index) => (value - average[index]) / scale[index]);
  const examples = rows.map(row => ({ x: normalize(row.x), y: row.y }));
  if (name === 'single-feature-threshold' || name === 'linear-centroid') {
    const groups = [0, 1].map(label => examples.filter(row => row.y === label));
    const centers = groups.map(group => positions.map(index => mean(group.map(row => row.x[index]))));
    const strongest = positions.reduce((best, index) => Math.abs(centers[1][index] - centers[0][index]) > Math.abs(centers[1][best] - centers[0][best]) ? index : best, 0);
    const selected = name === 'single-feature-threshold' ? [strongest] : positions;
    return input => {
      const x = normalize(input);
      const distances = centers.map(center => selected.reduce((sum, index) => sum + (x[index] - center[index]) ** 2, 0));
      return distances[0] === distances[1] ? Number(groups[1].length >= groups[0].length) : Number(distances[1] < distances[0]);
    };
  }
  const correlations = positions.map(index => mean(examples.map(row => row.x[index] * (row.y - center))));
  if (name === 'single-feature-linear') {
    const strongest = positions.reduce((best, index) => Math.abs(correlations[index]) > Math.abs(correlations[best]) ? index : best, 0);
    return input => center + normalize(input)[strongest] * correlations[strongest];
  }
  if (name !== 'ridge') throw new Error('Unsupported classifier or regressor');
  const matrix = positions.map(i => [...positions.map(j => mean(examples.map(row => row.x[i] * row.x[j])) + (i === j ? 0.1 : 0)), correlations[i]]);
  for (const i of positions) {
    const pivot = matrix[i][i];
    matrix[i] = matrix[i].map(value => value / pivot);
    for (const j of positions) if (j !== i) {
      const factor = matrix[j][i];
      matrix[j] = matrix[j].map((value, index) => value - factor * matrix[i][index]);
    }
  }
  return input => center + normalize(input).reduce((sum, value, index) => sum + value * matrix[index][width], 0);
}

export function runDataMl(snapshot: MlSnapshot, candidates: string[]) {
  const [train, development, held] = splitMl(snapshot);
  const classification = snapshot.kind === 'classification';
  const allowed: readonly string[] = mlCandidates[snapshot.kind];
  const baseline = allowed[0];
  if (!candidates.includes(baseline) || candidates.some(name => !allowed.includes(name))) throw new Error('An approved baseline and candidate protocol is required');
  const score = (rows: MlRow[], model: (x: number[]) => number) => classification
    ? mean([0, 1].map(label => mean(rows.filter(row => row.y === label).map(row => Number(model(row.x) === label)))))
    : mean(rows.map(row => Math.abs(model(row.x) - row.y)));
  const fits = allowed.filter(name => candidates.includes(name)).map(candidate => {
    const model = fit(candidate, train, snapshot.features.length);
    return { candidate, model, developmentScore: score(development, model) };
  });
  const winner = [...fits].sort((a, b) => (classification ? -1 : 1) * (a.developmentScore - b.developmentScore))[0];
  return { kind: 'REGISTERED_TABULAR_ML', datasetVersion: snapshot.id, protocol: 'tabular-ml/v1', selected: winner.candidate,
    metric: classification ? 'BALANCED_ACCURACY' : 'MEAN_ABSOLUTE_ERROR', baseline, cases: held.length,
    digest: hash({ dataset: snapshot.id, candidates, protocol: 'tabular-ml/v1', partitions: [train, development, held] }),
    results: fits.map(row => ({ candidate: row.candidate, developmentScore: row.developmentScore,
      heldOutScore: row.candidate === baseline || row.candidate === winner.candidate ? score(held, row.model) : null })),
  };
}
