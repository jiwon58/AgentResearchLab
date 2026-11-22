import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { liveProbe, UnsupportedProbe } from './gjc-live-probe.mjs';

const probe = fileURLToPath(new URL('./gjc-windows-compat.mjs', import.meta.url));

test('reports the missing offline runtime and exits unsuccessfully', () => {
  const result = spawnSync(process.execPath, [probe], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scope, 'OFFLINE_STARTUP_ONLY');
  assert.equal(report.stages.bun.reason, 'BUN_PATH_REQUIRED');
  assert.equal(report.stages['sdk-import'].status, 'NOT_RUN');
  assert.equal(report.stages['native-subagent'].status, 'NOT_RUN');
});

test('refuses to substitute Node for Bun and skips the dependent stages', () => {
  const root = mkdtempSync(join(tmpdir(), 'gajae-sdk-fixture-'));
  try {
    const result = spawnSync(process.execPath, [probe, '--bun', process.execPath], {
      encoding: 'utf8', env: { ...process.env, TMP: root, TEMP: root, TMPDIR: root },
    });
    assert.equal(result.status, 1);
    const { stages } = JSON.parse(result.stdout);
    assert.equal(stages.bun.status, 'FAIL');
    assert.equal(stages['native-load'].reason, 'BUN_FAILED');
    assert.equal(stages['single-session'].status, 'NOT_RUN');
    assert.deepEqual(readdirSync(root), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('approved probe contract checks events, on-disk restoration, isolation, and observed tool invocation locally', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gajae-sdk-fixture-'));
  try {
    const provider = join(root, 'provider.mjs');
    writeFileSync(provider, `export function getApprovedBinding() { return { model: {}, modelRegistry: {}, authStorage: {} }; }
      export function createApprovedProbeTool({marker,onExecution}) {
        return {tool:{name:'fixture', execute:onExecution}, instruction:'Use the tool then reply exactly '+marker+'.'};
      }`);
    const manager = { create: (_root, folder) => ({ file: join(folder, 'fixture.jsonl') }),
      open: async file => ({ file, remembered: readFileSync(file, 'utf8') }) };
    const sdk = { async createAgentSession(options) {
      let hook;
      return { session: { sessionFile: options.sessionManager.file,
        subscribe(listener) { hook = listener; return () => { hook = undefined; }; },
        async prompt(input) {
          for (const tool of options.customTools) tool.execute();
          const marker = /\bexactly ([A-Za-z0-9_]+)\./.exec(input)?.[1] ?? options.sessionManager.remembered;
          writeFileSync(options.sessionManager.file, marker);
          hook?.({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: marker } });
        },
        async dispose() {},
      } };
    } };
    assert.deepEqual(await liveProbe('agent-events', join(root, 'events'), provider, sdk, manager), { textEvents: 1 });
    assert.deepEqual(await liveProbe('session-restore', join(root, 'restore'), provider, sdk, manager), { sessionWritten: true, reopened: true });
    assert.deepEqual(await liveProbe('multiple-sessions', join(root, 'multi'), provider, sdk, manager), { sessions: 3 });
    assert.deepEqual(await liveProbe('restricted-tool', join(root, 'tool'), provider, sdk, manager), { invocationCount: 1 });
    await assert.rejects(liveProbe('native-subagent', join(root, 'native'), provider, sdk, manager), UnsupportedProbe);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
