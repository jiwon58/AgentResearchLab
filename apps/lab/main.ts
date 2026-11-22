import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compilePreset, isRecord, readOnlyNative, snapshotRevisions, type NativeReview, type Preset } from '../../packages/research/contracts.ts';
import { GjcAgentRuntime, MockAgentRuntime, proposal, type AgentRuntime } from '../../packages/research/agents.ts';
import { compareResearch, demoObjective } from '../../packages/research/benchmark.ts';
import { compareConnectedResearch } from '../../packages/research/connected-benchmark.ts';
import { inspectApprovedDataset, readApprovedDataset } from '../../packages/research/artifacts.ts';
import { RouterAgentRuntime, RouterClient, RouterError } from '../../packages/research/router.ts';
import { startBenchmark, startResearch, workspaceSummary, Workspaces, WorkspaceError } from './workspaces.ts';

const command = process.argv[2] ?? 'serve';
const dbFile = process.env.LAB_DB ?? 'data/lab.sqlite';
const kernel = process.env.LAB_RUST_BIN;

function localPort() {
  const port = Number(process.env.LAB_PORT ?? 4318);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback port');
  return port;
}

function openBrowser(origin: string) {
  if (process.platform !== 'win32' || !process.env.SystemRoot) return;
  execFile(join(process.env.SystemRoot, 'explorer.exe'), [origin], { windowsHide: true }, () => undefined);
}

function configuredRouter(): RouterClient | undefined {
  const { LAB_ROUTER_PROFILE, LAB_ROUTER_PROTOCOL, LAB_ROUTER_TOKEN, LAB_ROUTER_MODEL } = process.env;
  if (!LAB_ROUTER_PROFILE) return;
  const protocol = LAB_ROUTER_PROTOCOL ?? 'openai';
  if (protocol !== 'openai' && protocol !== 'anthropic') throw new Error('Invalid Router protocol');
  const profile: unknown = JSON.parse(readFileSync(LAB_ROUTER_PROFILE, 'utf8'));
  return new RouterClient(profile, protocol, LAB_ROUTER_TOKEN, LAB_ROUTER_MODEL);
}

function compileRun(runtime: AgentRuntime, input: unknown = {}) {
  if (!isRecord(input)) throw new WorkspaceError('연구 설정 형식이 올바르지 않습니다.');
  const timeout = runtime.kind === 'router' ? process.env.LAB_ROUTER_TIMEOUT_MS : undefined;
  try {
    const plan = compilePreset({ ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }), ...input } as Partial<Preset>, runtime.kind, runtime.bindingId);
    return runtime.kind === 'gjc' && runtime.nativeReviews?.length ? snapshotRevisions(plan, { native: [...runtime.nativeReviews] }) : plan;
  } catch { throw new WorkspaceError('연구 설정이 유효한 범위를 벗어났습니다.'); }
}

function localKernelWith(feature: string, marker: string) {
  if (process.platform !== 'win32') return;
  const candidates = [kernel, ...['release', 'debug'].map(mode =>
    fileURLToPath(new URL(`../../target/${mode}/gajae-research-kernel.exe`, import.meta.url)))];
  return candidates.find(candidate => {
    if (!candidate || !isAbsolute(candidate) || !existsSync(candidate)) return false;
    const probe = spawnSync(candidate, ['v1', feature], { encoding: 'utf8', windowsHide: true, timeout: 1500, maxBuffer: 8192 });
    return probe.status === 0 && probe.stdout.trim() === marker;
  });
}

function pickFolder(binary: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(binary, ['v1', 'pick-folder'], { encoding: 'utf8', maxBuffer: 128 * 1024, timeout: 180_000 }, (error, stdout) => {
      if (error) reject(new WorkspaceError('폴더 선택기를 열지 못했습니다. 경로를 직접 입력하세요.'));
      else resolve(stdout.trim() || null);
    });
  });
}

async function body(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON body required');
  let data = '';
  for await (const chunk of req) {
    data += chunk.toString();
    if (data.length > 16_384) throw new Error('Request too large');
  }
  return JSON.parse(data) as unknown;
}

function send(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function serve(workspaces: Workspaces, open = false) {
  const port = localPort();
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  if (open) {
    try {
      const response = await fetch(`${origin}/api/workspaces`, { signal: AbortSignal.timeout(750), redirect: 'error' });
      const payload: unknown = response.ok ? await response.json() : undefined;
      if (isRecord(payload) && typeof payload.picker === 'boolean' && Object.hasOwn(payload, 'initial')) {
        openBrowser(origin);
        return;
      }
    } catch { /* the loopback service has not been started */ }
  }
  const initial = process.env.LAB_WORKSPACE ? await workspaces.connect(process.env.LAB_WORKSPACE)
    : process.env.LAB_DB ? await workspaces.legacy(dbFile) : undefined;
  let pickerOpen = false;
  const picker = localKernelWith('folder-picker-available', 'windows-folder-picker/v1');
  const assets = new Map([
    ['/', ['text/html', 'index.html']], ['/dashboard.js', ['text/javascript', 'dashboard.js']], ['/dashboard.css', ['text/css', 'dashboard.css']],
  ].map(([route, [mime, file]]) => [route, { mime, bytes: readFileSync(new URL(`./web/${file}`, import.meta.url)) }]));
  const server = createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin)
      || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, { error: 'Local dashboard only' });
    const url = new URL(req.url ?? '/', origin);
    let path = url.pathname;
    const asset = assets.get(path);
    try {
      if (req.method === 'GET' && asset) {
        res.writeHead(200, { 'content-type': `${asset.mime}; charset=utf-8` });
        return res.end(asset.bytes);
      }
      if (path === '/api/workspaces' && req.method === 'GET') return send(res, 200, { initial: initial ? workspaceSummary(initial) : null, picker: Boolean(picker) });
      if (path === '/api/workspaces/connect' && req.method === 'POST') {
        const input = await body(req);
        return send(res, 200, workspaceSummary(await workspaces.connect(isRecord(input) ? input.path : undefined)));
      }
      if (path === '/api/workspaces/pick' && req.method === 'POST') {
        await body(req);
        if (!picker) throw new WorkspaceError('폴더 선택기를 사용할 수 없습니다. 경로를 직접 입력하세요.');
        if (pickerOpen) return send(res, 409, { error: '이미 열려 있는 폴더 선택 창을 확인하세요.' });
        pickerOpen = true;
        try {
          const directory = await pickFolder(picker);
          return send(res, 200, { workspace: directory ? workspaceSummary(await workspaces.connect(directory)) : null });
        } finally { pickerOpen = false; }
      }
      const scope = /^\/api\/workspaces\/(legacy|[a-f0-9]{32})(\/.*)?$/.exec(path);
      if (scope) path = `/api${scope[2] ?? ''}`;
      if (!scope && !/^\/api\/(research(?:\/|$)|comparisons$)/.test(path)) return send(res, 404, { error: '요청한 화면이 없습니다.' });
      const workspace = scope ? await workspaces.get(scope[1]) : await workspaces.legacy(dbFile);
      if (!workspace) return send(res, 404, { error: '작업 폴더를 다시 연결하세요.' });
      const { store, runtime, orchestrator } = workspace;
      if (req.method === 'GET' && path === '/api/research') {
        return send(res, 200, { runtime: runtime.kind, defaults: compileRun(runtime), runs: store.list(), datasets: store.datasets(), workspace: workspaceSummary(workspace) });
      }
      if (req.method === 'GET' && path === '/api/comparisons') {
        if (!scope) return send(res, 200, store.comparisons());
        const id = url.searchParams.get('id');
        if (id !== null && !/^[a-f0-9-]{36}$/.test(id)) return send(res, 400, { error: '잘못된 평가 ID입니다.' });
        const results = store.comparisons(1, id ?? undefined);
        if (id && !results.length) return send(res, 404, { error: '이 작업 폴더에서 평가를 찾을 수 없습니다.' });
        return send(res, 200, { results, history: store.comparisonHistory(), workspace: workspaceSummary(workspace),
          revisions: runtime.bindingId ? store.revisionStatus(runtime.bindingId) : null });
      }
      if (req.method === 'POST' && path === '/api/comparisons' && scope) {
        const input = await body(req);
        return send(res, 202, { started: startBenchmark(workspace, isRecord(input) && input.full === true, isRecord(input) && input.connected === true) });
      }
      if (req.method === 'POST' && path === '/api/revisions' && scope) {
        const input = await body(req);
        if (runtime.kind !== 'router' || !runtime.bindingId || !isRecord(input) || (input.kind !== 'policy' && input.kind !== 'genome') || typeof input.id !== 'string') {
          throw new WorkspaceError('연결된 모델과 평가 또는 적용 버전이 필요합니다.');
        }
        try {
          if (input.action === 'activate') return send(res, 200, store.activateRevision(input.kind, runtime.bindingId, input.id));
          if (input.action === 'rollback') return send(res, 200, { revision: store.rollbackRevision(input.kind, runtime.bindingId, input.id) });
        } catch { throw new WorkspaceError('동일한 모델과 기준 버전의 독립 평가에서 회귀 없는 개선이 확인되어야 합니다.'); }
        throw new WorkspaceError('지원되지 않는 버전 작업입니다.');
      }
      if (req.method === 'POST' && path === '/api/research') {
        const input = await body(req);
        if (!isRecord(input) || typeof input.objective !== 'string') return send(res, 400, { error: 'An objective is required' });
        const settings = input.settings ?? {};
        if (!isRecord(settings) || Object.keys(settings).some(key => !['researchType', 'strategy', 'seed', 'timeoutMs', 'maxTasks', 'maxParallel', 'retries', 'memory', 'evolution'].includes(key))) {
          throw new WorkspaceError('지원되는 연구 설정만 입력하세요.');
        }
        const plan = store.withOperationalRevisions(store.withApprovedDataset(compileRun(runtime, settings), input.dataset));
        const run = store.create(input.objective, plan);
        return send(res, 201, run);
      }
      const match = /^\/api\/research\/([a-f0-9-]{36})(?:\/(run|pause|resume|cancel-task|review-proposal|native-review|branch))?$/.exec(path);
      if (match) {
        const [, project, action] = match;
        if (req.method === 'GET' && !action) return send(res, 200, { ...orchestrator.view(project),
          execution: { running: workspace.running.has(project), error: workspace.runErrors.get(project) ?? null } });
        if (req.method === 'POST' && action) {
          const input = await body(req);
          const run = store.run(project);
          if (action === 'branch') {
            if (!isRecord(input) || input.objective !== undefined && typeof input.objective !== 'string') throw new WorkspaceError('분기 연구의 목적이 올바르지 않습니다.');
            return send(res, 201, store.branchResearch(project, input.objective));
          }
          if (action === 'pause') return send(res, 200, { changed: orchestrator.pause(project) });
          if (action === 'resume') return send(res, 200, { changed: orchestrator.resume(project) });
          if (action === 'cancel-task') {
            if (!isRecord(input) || typeof input.task !== 'string') return send(res, 400, { error: 'Task ID is required' });
            return send(res, 200, { changed: orchestrator.cancelTask(project, input.task) });
          }
          if (action === 'review-proposal') {
            if (!isRecord(input) || typeof input.proposal !== 'string' || typeof input.approve !== 'boolean') {
              return send(res, 400, { error: 'Proposal ID and decision are required' });
            }
            return send(res, 200, store.reviewProposal(project, input.proposal, input.approve));
          }
          if (action === 'native-review') {
            const name = isRecord(input) ? input.name as NativeReview : undefined;
            if (!name || !readOnlyNative.includes(name) || !run.plan.native?.includes(name)) throw new WorkspaceError('이 연구에서 활성화된 읽기 전용 Native 리뷰가 아닙니다.');
            const suggested = { ...proposal(run, 'DELEGATE_NATIVE_REVIEW', 'director', [], `-${name}`), native_review: name };
            return send(res, 202, store.submit(project, 'director', suggested));
          }
          return scope ? send(res, 202, { started: startResearch(workspace, project) })
            : send(res, 200, await orchestrator.runToCheckpoint(project));
        }
      }
      send(res, 404, { error: 'Route unavailable' });
    } catch (error) {
      send(res, 400, { error: error instanceof WorkspaceError ? error.message : '요청을 처리하지 못했습니다. 연구 상태와 설정을 확인하세요.' });
    }
  });
  server.requestTimeout = 30_000;
  server.on('close', () => { void workspaces.close(); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      console.log(`Gajae Research Lab listening on ${origin}`);
      if (open) openBrowser(origin);
      resolve();
    });
  }).catch(async error => { await workspaces.close(); throw error; });
}

async function main() {
  if (command === 'router-probe') {
    const router = configuredRouter();
    if (!router) throw new Error('LAB_ROUTER_PROFILE is required');
    console.log(JSON.stringify(await router.probe(), null, 2));
    return;
  }
  if (command === 'inspect-data') {
    if (!process.env.LAB_APPROVED_DATA_FILE) throw new Error('LAB_APPROVED_DATA_FILE is required');
    console.log(JSON.stringify(inspectApprovedDataset(process.env.LAB_APPROVED_DATA_FILE), null, 2));
    return;
  }
  const connected = command === 'benchmark' && process.argv.includes('--connected');
  const router = command === 'benchmark' && !connected ? undefined : configuredRouter();
  const logic = kernel ?? (command !== 'benchmark' ? localKernelWith('logic-engine-available', 'scientific-logic/v1') : undefined);
  const workspaces = new Workspaces(async (store, workspace) => {
    if (command === 'benchmark') {
      if (connected && !router) throw new WorkspaceError('연결 평가에는 LAB_ROUTER_PROFILE 설정이 필요합니다.');
      return router ? new RouterAgentRuntime(router) : new MockAgentRuntime();
    }
    if (!process.env.LAB_GJC_BUNDLE && !process.env.LAB_APPROVED_PROVIDER) return router ? new RouterAgentRuntime(router) : new MockAgentRuntime();
    if (router) throw new Error('Configure one agent runtime per host');
    const { LAB_GJC_BUNDLE, LAB_APPROVED_PROVIDER, LAB_GJC_SESSION_ROOT } = process.env;
    const sessions = workspace?.sessions ?? LAB_GJC_SESSION_ROOT;
    if (!LAB_GJC_BUNDLE || !LAB_APPROVED_PROVIDER || !sessions) throw new Error('Incomplete GJC host settings');
    if (!Object.hasOwn(process.versions, 'bun')) throw new Error('GJC host requires Bun');
    const provider = await import(pathToFileURL(resolve(LAB_APPROVED_PROVIDER)).href);
    return GjcAgentRuntime.fromApprovedBundle(store, LAB_GJC_BUNDLE, sessions, await provider.getApprovedBinding(), workspace?.root);
  }, logic);
  if (command === 'serve' || command === 'open') return await serve(workspaces, command === 'open');
  const { store, orchestrator, runtime } = process.env.LAB_WORKSPACE ? await workspaces.connect(process.env.LAB_WORKSPACE) : await workspaces.legacy(dbFile);
  try {
    if (command === 'import-data') {
      if (!process.env.LAB_APPROVED_DATA_FILE) throw new Error('LAB_APPROVED_DATA_FILE is required');
      const { records, version } = readApprovedDataset(process.env.LAB_APPROVED_DATA_FILE);
      console.log(JSON.stringify(store.registerDataset(records, version), null, 2));
      return;
    }
    if (command === 'benchmark') {
      const full = process.argv.includes('--full');
      const report = connected ? await compareConnectedResearch(runtime, { full, checkpoint: store, kernel,
        timeoutMs: process.env.LAB_ROUTER_TIMEOUT_MS ? Number(process.env.LAB_ROUTER_TIMEOUT_MS) : undefined }) : await compareResearch(full, kernel, store);
      const comparisonId = store.comparison(report);
      console.log(JSON.stringify({ comparisonId, ...report }, null, 2));
      return;
    }
    if (command === 'demo') {
      const run = store.create(demoObjective, store.withOperationalRevisions(store.withApprovedDataset(compileRun(runtime), process.env.LAB_DATASET_ID)));
      const result = await orchestrator.runToCheckpoint(run.id);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    throw new Error('Use open, serve, demo, benchmark, inspect-data, import-data or router-probe');
  } finally { await workspaces.close(); }
}

main().catch((error: unknown) => {
  console.error(error instanceof RouterError ? error.code : 'Research Lab could not complete the command. Check the local configuration and database.');
  process.exitCode = 1;
});
