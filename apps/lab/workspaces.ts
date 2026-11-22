import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactStore } from '../../packages/research/artifacts.ts';
import type { AgentRuntime } from '../../packages/research/agents.ts';
import { compareResearch } from '../../packages/research/benchmark.ts';
import { compareConnectedResearch } from '../../packages/research/connected-benchmark.ts';
import { hash } from '../../packages/research/contracts.ts';
import { ResearchOrchestrator } from '../../packages/research/orchestrator.ts';
import { openStore, type ResearchStore } from '../../packages/research/store.ts';

export class WorkspaceError extends Error {}

function checkPath(path: string, directory: boolean, create = false) {
  if (create) {
    try { mkdirSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const info = lstatSync(path, { throwIfNoEntry: false });
  if ((!info && directory) || (info && (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())))) {
    throw new WorkspaceError('연구 기록 경로가 폴더 구조와 일치하지 않습니다.');
  }
}

export function workspacePaths(path: unknown) {
  if (typeof path !== 'string' || !path.trim() || path.length > 2048 || !isAbsolute(path.trim())) {
    throw new WorkspaceError('기존 폴더의 절대 경로를 입력하세요.');
  }
  let root: string;
  try {
    root = realpathSync.native(path.trim());
    checkPath(root, true);
  } catch {
    throw new WorkspaceError('폴더를 열 수 없습니다. 경로와 접근 권한을 확인하세요.');
  }
  const metadata = join(root, '.gajae-lab');
  const artifacts = join(metadata, 'artifacts');
  const sessions = join(metadata, 'sessions');
  const database = join(metadata, 'lab.sqlite');
  try {
    checkPath(metadata, true, true);
    checkPath(artifacts, true, true);
    checkPath(sessions, true, true);
    for (const suffix of ['', '-wal', '-shm', '-journal']) checkPath(database + suffix, false);
  } catch {
    throw new WorkspaceError('이 폴더에 연구 기록을 열거나 만들 수 없습니다.');
  }
  return { root, metadata, artifacts, sessions, database,
    name: basename(root) || root, id: hash(root).slice(0, 32) };
}

type Paths = ReturnType<typeof workspacePaths>;
type RuntimeFactory = (store: ResearchStore, workspace?: Paths) => Promise<AgentRuntime>;
export interface Workspace {
  id: string;
  name: string;
  root: string | null;
  metadata: string | null;
  store: ResearchStore;
  runtime: AgentRuntime;
  orchestrator: ResearchOrchestrator;
  running: Map<string, Promise<unknown>>;
  runErrors: Map<string, string>;
  benchmark: Promise<unknown> | null;
  benchmarkError: string | null;
}

export class Workspaces {
  private readonly items = new Map<string, Promise<Workspace>>();
  readonly createRuntime: RuntimeFactory;
  readonly kernel?: string;

  constructor(createRuntime: RuntimeFactory, kernel?: string) { this.createRuntime = createRuntime; this.kernel = kernel; }

  connect(path: unknown) {
    const workspace = workspacePaths(path);
    return this.open(workspace.id, workspace.database, workspace);
  }

  legacy(database: string) {
    return this.open('legacy', database);
  }

  private open(id: string, database: string, paths?: Paths): Promise<Workspace> {
    const existing = this.items.get(id);
    if (existing) return existing;
    const pending = (async () => {
      const store = await openStore(database);
      try {
        const runtime = await this.createRuntime(store, paths);
        const artifactFolder = paths?.artifacts ?? (database === ':memory:' ? undefined : resolve(dirname(database), 'artifacts'));
        const orchestrator = new ResearchOrchestrator(store, runtime, this.kernel, artifactFolder ? new ArtifactStore(artifactFolder) : undefined);
        return { id, root: paths?.root ?? null, metadata: paths?.metadata ?? null, name: paths?.name ?? '기존 연구 기록', store, runtime, orchestrator,
          running: new Map<string, Promise<unknown>>(), runErrors: new Map<string, string>(), benchmark: null, benchmarkError: null };
      } catch (error) { store.close(); throw error; }
    })().catch(error => { this.items.delete(id); throw error; });
    this.items.set(id, pending);
    return pending;
  }

  get(id: string) { return this.items.get(id); }

  async close() {
    const entries = await Promise.allSettled(this.items.values());
    for (const entry of entries) {
      if (entry.status !== 'fulfilled') continue;
      const workspace = entry.value;
      await Promise.allSettled([...workspace.running.values(), ...(workspace.benchmark ? [workspace.benchmark] : [])]);
      workspace.store.close();
    }
  }
}

export function workspaceSummary(workspace: Workspace) {
  return { id: workspace.id, name: workspace.name, root: workspace.root, metadata: workspace.metadata, runtime: workspace.runtime.kind,
    benchmarkRunning: Boolean(workspace.benchmark), benchmarkError: workspace.benchmarkError };
}

export function startResearch(workspace: Workspace, id: string) {
  const run = workspace.store.run(id);
  if (run.status !== 'ACTIVE' || workspace.running.has(id)) return false;
  if (run.plan.runtime !== workspace.runtime.kind || run.plan.runtimeBinding !== workspace.runtime.bindingId) {
    throw new WorkspaceError('이 연구를 실행하려면 생성할 때 사용한 모델 연결이 필요합니다.');
  }
  workspace.runErrors.delete(id);
  const pending = workspace.orchestrator.runToCheckpoint(id).catch(() => {
    workspace.runErrors.set(id, '연구 실행을 완료하지 못했습니다. 저장된 작업 상태를 확인하세요.');
  }).finally(() => workspace.running.delete(id));
  workspace.running.set(id, pending);
  return true;
}

export function startBenchmark(workspace: Workspace, full: boolean, connected = false) {
  if (connected && workspace.runtime.kind !== 'router') throw new WorkspaceError('Router를 연결한 뒤 모델 비교 평가를 실행할 수 있습니다.');
  if (workspace.benchmark) return false;
  workspace.benchmarkError = null;
  workspace.benchmark = Promise.resolve().then(async () => {
    if (!workspace.root) {
      const result = connected ? await compareConnectedResearch(workspace.runtime, { full, checkpoint: workspace.store,
        timeoutMs: process.env.LAB_ROUTER_TIMEOUT_MS ? Number(process.env.LAB_ROUTER_TIMEOUT_MS) : undefined })
        : await compareResearch(full, undefined, workspace.store);
      workspace.store.comparison(result);
      return;
    }
    const entry = fileURLToPath(new URL('./main.ts', import.meta.url));
    const env: NodeJS.ProcessEnv = { ...process.env, LAB_WORKSPACE: workspace.root };
    if (!connected) delete env.LAB_ROUTER_TOKEN;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [entry, 'benchmark', ...(full ? ['--full'] : []), ...(connected ? ['--connected'] : [])], {
        env, windowsHide: true, stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Benchmark process failed')));
    });
  }).catch(() => {
    workspace.benchmarkError = '비교 평가를 완료하지 못했습니다. 완료된 시험은 폴더에 보관됩니다.';
  }).finally(() => { workspace.benchmark = null; });
  return true;
}
