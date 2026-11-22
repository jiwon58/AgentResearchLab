import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { workspacePaths } from '../apps/lab/workspaces.ts';

const entry = fileURLToPath(new URL('../apps/lab/main.ts', import.meta.url));

async function startServer() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const origin = `http://127.0.0.1:${address.port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LAB_')));
  const child = spawn(process.execPath, [entry, 'serve'], { env: { ...env, LAB_PORT: String(address.port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stderr.on('data', chunk => { logs += chunk.toString(); });
  const closed = once(child, 'close');
  try {
    const timeout = AbortSignal.timeout(7000);
    for await (const chunk of child.stdout.iterator({ destroyOnReturn: false })) {
      if (chunk.toString().includes(origin)) break;
      timeout.throwIfAborted();
    }
    assert.equal(child.exitCode, null, logs);
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(origin + path, { ...(body === undefined ? {} : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }), signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: await response.json() };
    };
    return { request, close: async () => { child.kill(); await closed; } };
  } catch (error) {
    child.kill();
    await closed;
    throw error;
  }
}

async function until<T>(read: () => Promise<T>, ready: (data: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  do {
    const data = await read();
    if (ready(data)) return data;
    await delay(40);
  } while (Date.now() < deadline);
  throw new Error('Workspace did not finish within the test deadline');
}

test('scopes research, artifacts, evolution, and stored settings to a portable working folder', { timeout: 25_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gajae-workspaces-'));
  const folderA = join(directory, 'Sensor Lab A');
  const folderB = join(directory, '공정 연구 B');
  const moved = join(directory, 'Sensor Lab Renamed');
  mkdirSync(folderA);
  mkdirSync(folderB);
  let host: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    host = await startServer();
    const request = host.request;
    assert.equal((await request('/api/workspaces')).body.initial, null);
    assert.equal((await request('/api/workspaces/connect', { path: 'relative-folder' })).status, 400);
    const A = (await request('/api/workspaces/connect', { path: folderA })).body;
    const B = (await request('/api/workspaces/connect', { path: folderB })).body;
    assert.notEqual(A.id, B.id);
    const inA = `/api/workspaces/${A.id}`;
    const inB = `/api/workspaces/${B.id}`;
    assert.equal((await request(`${inA}/research`, { objective: 'Invalid task setting', settings: { cwd: folderB } })).status, 400);
    const created = await request(`${inA}/research`, { objective: 'Check temperature and defect rates', settings: { seed: 42, maxParallel: 2, memory: 'private' } });
    assert.equal(created.status, 201);
    assert.equal(created.body.plan.maxParallel, 2);
    assert.equal(created.body.plan.memory, 'private');
    const id = created.body.id;
    assert.equal((await request(`${inA}/research/${id}/run`, {})).status, 202);
    assert.equal((await request(`${inB}/research/${id}`)).status, 400);
    assert.deepEqual((await request(`${inB}/research`)).body.runs, []);
    const cleaned = await until(() => request(`${inA}/research/${id}`), result => result.body.run?.status === 'INCONCLUSIVE');
    const filename = cleaned.body.progressLedger.experiment.artifact.sha256 + '.json';
    assert.ok(existsSync(join(folderA, '.gajae-lab', 'artifacts', filename)));
    assert.ok(!existsSync(join(folderB, '.gajae-lab', 'artifacts', filename)));
    assert.equal((await request(`${inA}/comparisons`, { full: false })).status, 202);
    const compared = await until(() => request(`${inA}/comparisons`), result => result.body.results?.length > 0 && !result.body.workspace.benchmarkRunning);
    assert.equal(compared.body.results[0].payload.evolution.conditions.length, 7);
    assert.deepEqual((await request(`${inB}/comparisons`)).body.results, []);
    const comparisonId = compared.body.results[0].id;
    assert.equal((await request(`${inA}/comparisons?id=${comparisonId}`)).body.results[0].id, comparisonId);
    assert.equal((await request(`${inB}/comparisons?id=${comparisonId}`)).status, 404);
    await host.close();
    host = undefined;

    renameSync(folderA, moved);
    host = await startServer();
    const restored = (await host.request('/api/workspaces/connect', { path: moved })).body;
    assert.notEqual(restored.id, A.id);
    const after = await host.request(`/api/workspaces/${restored.id}/research/${id}`);
    assert.equal(after.body.run.status, 'INCONCLUSIVE');
    assert.deepEqual(after.body.researchLedger.argumentGraph, cleaned.body.researchLedger.argumentGraph);
    assert.equal(after.body.run.plan.memory, 'private');
    assert.equal(after.body.progressLedger.experiment.artifact.sha256 + '.json', filename);
    assert.ok(existsSync(join(moved, '.gajae-lab', 'artifacts', filename)));
    assert.equal((await host.request(`/api/workspaces/${restored.id}/comparisons`)).body.results.length, 1);
  } finally {
    await host?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('refuses a redirected record directory under a working folder', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gajae-redirected-folder-'));
  try {
    const folder = join(directory, 'workspace');
    const unrelated = join(directory, 'unrelated');
    mkdirSync(folder);
    mkdirSync(unrelated);
    symlinkSync(unrelated, join(folder, '.gajae-lab'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => workspacePaths(folder), /연구 기록/);
    assert.ok(!existsSync(join(unrelated, 'lab.sqlite')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
