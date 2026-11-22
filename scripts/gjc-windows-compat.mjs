import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { liveProbe, UnsupportedProbe } from './gjc-live-probe.mjs';

const sdkName = '@gajae-code/coding-agent';
const nativeName = '@gajae-code/natives';
const probeMarker = 'GAJAE_COMPAT_RESULT ';
const scriptPath = fileURLToPath(import.meta.url);

function packageDirectory(bundle, name) {
  return join(bundle, 'node_modules', name);
}

function manifest(bundle, name) {
  const data = JSON.parse(readFileSync(join(packageDirectory(bundle, name), 'package.json'), 'utf8'));
  if (data.name !== name || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(data.version)) {
    throw new Error('Invalid package manifest');
  }
  return data;
}

function fileDigest(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }

async function importPackage(bundle, name, subpath = '.') {
  const data = manifest(bundle, name);
  const entry = data.exports?.[subpath];
  const target = typeof entry === 'string' ? entry : entry?.import ?? entry?.default;
  if (!target?.startsWith('./') || target.split(/[\\/]/).includes('..')) {
    throw new Error('Missing public package export');
  }
  return import(pathToFileURL(join(packageDirectory(bundle, name), target)).href);
}

const liveStages = ['tool-free-llm', 'agent-events', 'restricted-tool', 'session-save', 'session-restore', 'multiple-sessions', 'native-subagent'];

async function probe(stage, bundle, scratch, provider = '') {
  if (!process.versions.bun) throw new Error('Bun required');
  if (stage === 'bun') return { bunVersion: process.versions.bun };
  if (stage === 'sdk-import') {
    const { createAgentSession } = await importPackage(bundle, sdkName, './sdk');
    if (typeof createAgentSession !== 'function') throw new Error('Missing createAgentSession');
    return {};
  }
  if (stage === 'native-load') {
    const { version } = manifest(bundle, nativeName);
    const native = await importPackage(bundle, nativeName);
    const sentinel = `__piNativesV${version.replaceAll('.', '_')}`;
    if (native[sentinel] === undefined) throw new Error('Missing native version sentinel');
    return { nativeVersion: version };
  }

  const { SessionManager } = await importPackage(bundle, sdkName);
  if (typeof SessionManager?.create !== 'function' || typeof SessionManager.open !== 'function') {
    throw new Error('Missing SessionManager create/open');
  }
  if (liveStages.includes(stage)) {
    const sdk = await importPackage(bundle, sdkName, './sdk');
    return liveProbe(stage, scratch, provider, sdk, SessionManager);
  }
  const sessionManager = SessionManager.create(scratch, join(scratch, 'sessions'));
  if (!sessionManager.getSessionId()) throw new Error('Missing session ID');
  if (stage === 'session-manager') return {};
  if (stage !== 'single-session') throw new Error('Unknown probe');

  const { createAgentSession } = await importPackage(bundle, sdkName, './sdk');
  const { session } = await createAgentSession({
    cwd: scratch,
    agentDir: join(scratch, 'agent'),
    sessionManager,
    systemPrompt: ['Gajae SDK offline compatibility probe.'],
    toolNames: [],
    customTools: [],
    contextFiles: [],
    skills: [],
    rules: [],
    promptTemplates: [],
    slashCommands: [],
    disableExtensionDiscovery: true,
    enableMCP: false,
    enableMcpAutoload: false,
    enableLsp: false,
    deferMemoryBackendStartup: true,
    deferOptionalModelRefresh: true,
    skipPythonPreflight: true,
  });
  try {
    if (typeof session.prompt !== 'function' || typeof session.subscribe !== 'function') {
      throw new Error('Missing session methods');
    }
  } finally {
    await session.dispose();
  }
  return {};
}

function runProcess(executable, args, cwd, timeout, expectsProbe, allowedEnv = []) {
  const inherited = ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SystemDrive', 'LANG'];
  const env = Object.fromEntries([...inherited, ...allowedEnv].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, {
    HOME: cwd, USERPROFILE: cwd, APPDATA: cwd, LOCALAPPDATA: cwd,
    TEMP: cwd, TMP: cwd, XDG_CONFIG_HOME: cwd, XDG_DATA_HOME: cwd, XDG_CACHE_HOME: cwd,
    BUN_INSTALL_CACHE_DIR: join(cwd, 'bun-cache'),
  });
  if (process.env.SystemRoot) env.PATH = join(process.env.SystemRoot, 'System32');
  const child = spawnSync(executable, args, {
    cwd, env, timeout, killSignal: 'SIGKILL', windowsHide: true, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024,
  });
  const exit = { exitCode: child.status, signal: child.signal };
  if (child.error) return { status: 'FAIL', reason: child.error.code, ...exit };
  if ((child.status >>> 0) === 0xc00000fd || /stack overflow/i.test(child.stderr ?? '')) {
    return { status: 'FAIL', reason: 'STACK_OVERFLOW', ...exit };
  }
  if (child.status !== 0) return { status: 'FAIL', reason: 'PROCESS_EXIT', ...exit };
  if (!expectsProbe) {
    const version = /^(?:gjc(?:\/|\s+(?:version\s+)?))?(v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/i
      .exec(child.stdout.trim())?.[1];
    return version ? { status: 'PASS', version, ...exit } : { status: 'FAIL', reason: 'MISSING_VERSION', ...exit };
  }
  const receipt = child.stdout.split(/\r?\n/).find(line => line.startsWith(probeMarker));
  if (!receipt) return { status: 'FAIL', reason: 'MISSING_PROBE_RECEIPT', ...exit };
  return { ...JSON.parse(receipt.slice(probeMarker.length)), ...exit };
}

function main() {
  const { values } = parseArgs({ options: {
    bun: { type: 'string' }, bundle: { type: 'string' }, 'legacy-version-probe': { type: 'string' },
    'provider-module': { type: 'string' }, 'env-name': { type: 'string', multiple: true },
  } });
  const provider = values['provider-module'];
  const allowedEnv = values['env-name'] ?? [];
  if (provider && (!isAbsolute(provider) || !existsSync(provider))) throw new Error('--provider-module must name an approved absolute path');
  if (allowedEnv.some(name => !/^(LAB_|GJC_)[A-Z0-9_]{1,128}$/.test(name))) throw new Error('Probe environment names must use LAB_ or GJC_');
  const bun = values.bun;
  if (bun && (!isAbsolute(bun) || /^gjc(?:\.exe)?$/i.test(basename(bun)))) {
    throw new Error('--bun requires an absolute path to a Bun executable');
  }
  const legacy = values['legacy-version-probe'];
  if (legacy && (!isAbsolute(legacy) || !existsSync(legacy))) throw new Error('Legacy binary path must be absolute and exist');
  const scratchRoot = realpathSync(tmpdir());
  const scratch = mkdtempSync(join(scratchRoot, 'gajae-sdk-compat-'));
  try {
    runDiagnostic({ bun, legacy, provider, allowedEnv, bundle: values.bundle && resolve(values.bundle) }, scratch);
  } finally {
    const target = realpathSync(scratch);
    if (dirname(target) !== scratchRoot || !basename(target).startsWith('gajae-sdk-compat-')) {
      throw new Error('Probe temporary directory changed during execution');
    }
    rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  }
}

function runDiagnostic({ bun, legacy, provider, allowedEnv, bundle }, scratch) {
  const stages = {};
  const report = { scope: provider ? 'APPROVED_PROVIDER_INTEGRATION' : 'OFFLINE_STARTUP_ONLY', platform: process.platform, arch: process.arch, stages };
  let matchedBundle = false;
  if (bundle) {
    try {
      const sdk = manifest(bundle, sdkName);
      const native = manifest(bundle, nativeName);
      const platformNative = manifest(bundle, `${nativeName}-win32-x64`);
      report.packages = { sdk: sdk.version, native: native.version, windowsNative: platformNative.version };
      report.manifests = Object.fromEntries([sdkName, nativeName, `${nativeName}-win32-x64`]
        .map(name => [name, fileDigest(join(packageDirectory(bundle, name), 'package.json'))]));
      const lock = ['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml'].find(filename => existsSync(join(bundle, filename)));
      if (lock) report.lockfile = { name: lock, sha256: fileDigest(join(bundle, lock)) };
      matchedBundle = process.platform === 'win32' && process.arch === 'x64'
        && sdk.dependencies?.[nativeName] === native.version && native.version === platformNative.version;
    } catch {
      report.bundleIssue = 'PACKAGE_MANIFEST_UNAVAILABLE';
    }
  }

  for (const stage of ['bun', 'sdk-import', 'native-load', 'session-manager', 'single-session']) {
    let reason;
    if (!bun) reason = 'BUN_PATH_REQUIRED';
    else if (stage !== 'bun' && stages.bun.status !== 'PASS') reason = 'BUN_FAILED';
    else if (stage !== 'bun' && !matchedBundle) reason = 'MATCHING_OFFLINE_WINDOWS_BUNDLE_REQUIRED';
    else if (['session-manager', 'single-session'].includes(stage)
      && (stages['sdk-import'].status !== 'PASS' || stages['native-load'].status !== 'PASS'
        || stages['session-manager']?.status === 'FAIL')) reason = 'PREREQUISITE_FAILED';
    if (reason) {
      stages[stage] = { status: 'NOT_RUN', reason };
      continue;
    }
    const directory = join(scratch, stage);
    mkdirSync(directory);
    const args = ['run', '--no-install', '--no-env-file', scriptPath, '--probe', stage, bundle ?? '', directory];
    stages[stage] = runProcess(bun, args, directory, 45_000, true);
  }

  const startupPassed = Object.values(stages).every(stage => stage.status === 'PASS');
  for (const stage of liveStages) {
    if (!provider || !startupPassed) {
      stages[stage] = { status: 'NOT_RUN', reason: !provider ? 'LIVE_INTEGRATION_REQUIRED' : 'PREREQUISITE_FAILED' };
      continue;
    }
    const directory = join(scratch, stage);
    mkdirSync(directory);
    stages[stage] = runProcess(bun, ['run', '--no-install', '--no-env-file', scriptPath, '--probe', stage, bundle, directory, provider],
      directory, 120_000, true, allowedEnv);
  }

  if (legacy) {
    const directory = join(scratch, 'legacy-version');
    mkdirSync(directory);
    report.legacyVersionProbe = {
      sha256: fileDigest(legacy),
      ...runProcess(legacy, ['--version'], directory, 10_000, false),
    };
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = startupPassed && (!provider || liveStages.every(stage => stages[stage].status === 'PASS')) ? 0 : 1;
}

if (process.argv[2] === '--probe') {
  try {
    const details = await probe(...process.argv.slice(3));
    console.log(probeMarker + JSON.stringify({ status: 'PASS', ...details }));
  } catch (error) {
    if (error instanceof UnsupportedProbe) {
      console.log(probeMarker + JSON.stringify({ status: 'NOT_RUN', reason: error.message }));
    } else {
      const reason = /stack overflow|maximum call stack size exceeded/i.test(String(error?.message))
        ? 'STACK_OVERFLOW' : 'PROBE_ERROR';
      console.log(probeMarker + JSON.stringify({ status: 'FAIL', reason }));
    }
  }
} else {
  main();
}
