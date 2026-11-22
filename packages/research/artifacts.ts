import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isRecord } from './contracts.ts';

const digest = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');

export class ArtifactStore {
  readonly directory: string;
  constructor(directory: string) {
    if (!isAbsolute(directory)) throw new Error('Artifact root must be absolute');
    this.directory = directory;
  }

  put(payload: unknown) {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    if (bytes.length > 256_000) throw new Error('Artifact exceeds the size limit');
    const sha256 = digest(bytes);
    const destination = join(this.directory, `${sha256}.json`);
    mkdirSync(this.directory, { recursive: true });
    const staged = join(this.directory, `${randomUUID()}.tmp`);
    const fd = openSync(staged, 'wx', 0o600);
    try {
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(staged, destination);
    } catch (error) {
      try { unlinkSync(staged); } catch { /* the staged file may already have been committed */ }
      throw error;
    }
    return { sha256, bytes: bytes.length, mediaType: 'application/json' };
  }

  read(sha256: string): unknown {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid artifact digest');
    const bytes = readFileSync(join(this.directory, `${sha256}.json`));
    if (digest(bytes) !== sha256) throw new Error('Artifact integrity failure');
    return JSON.parse(bytes.toString('utf8'));
  }
}

export function readApprovedFile(file: string) {
  if (!isAbsolute(file)) throw new Error('The approved data file must be an absolute path');
  const fd = openSync(file, 'r');
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > 1_000_000) throw new Error('Invalid approved data file');
    const singleReadLimit = Buffer.alloc(1_000_001);
    let total = 0;
    while (total < singleReadLimit.length) {
      const count = readSync(fd, singleReadLimit, total, singleReadLimit.length - total, null);
      if (!count) break;
      total += count;
    }
    if (total >= singleReadLimit.length) throw new Error('Approved data file is too large');
    return singleReadLimit.subarray(0, total);
  } finally { closeSync(fd); }
}

export function readApprovedDataset(file: string) {
  const bytes = readApprovedFile(file);
  const data: unknown = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(data) || !data.length || !data.every(isRecord)) throw new Error('Expected an array of records');
  return { records: data, version: digest(bytes) };
}

export function inspectApprovedDataset(file: string) {
  const { records, version } = readApprovedDataset(file);
  return { source: 'OPERATOR_APPROVED_JSON', version, access: 'READ_ONLY', rows: records.length,
    columns: Object.keys(records[0]).sort().slice(0, 64) };
}
