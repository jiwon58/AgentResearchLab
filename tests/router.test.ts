import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MockAgentRuntime, type AgentContext } from '../packages/research/agents.ts';
import { demoObjective } from '../packages/research/benchmark.ts';
import { compilePreset } from '../packages/research/contracts.ts';
import { ResearchOrchestrator } from '../packages/research/orchestrator.ts';
import { RouterAgentRuntime, RouterClient } from '../packages/research/router.ts';
import { openStore } from '../packages/research/store.ts';
import { compareConnectedResearch } from '../packages/research/connected-benchmark.ts';

const token = 'test-router-bearer-only';
async function localRouter(handle: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const failures: unknown[] = [];
  const server = createServer(async (req, res) => {
    try { await handle(req, res); } catch (error) { failures.push(error); res.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    profile: { enabled: true, allow_remote: false, authentication: 'bearer', scheme: 'http', host: '127.0.0.1',
      port: address.port, openai_path: '/gateway/v1', anthropic_path: '/anthropic', model: 'fixture-model' },
    failures,
    async close() {
      const done = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await done;
    },
  };
}

for (const protocol of ['openai', 'anthropic'] as const) {
  test(`uses ${protocol} Router over HTTP for probe, three resident roles, policy, and validated research`, async () => {
    const requests: string[] = [];
    const mocked = new MockAgentRuntime();
    const router = await localRouter(async (req, res) => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, protocol === 'openai' ? '/gateway/v1/chat/completions' : '/anthropic/v1/messages');
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      assert.equal(req.headers['anthropic-version'], protocol === 'anthropic' ? '2023-06-01' : undefined);
      let raw = '';
      for await (const chunk of req) raw += chunk;
      assert.ok(!raw.includes(token));
      const body = JSON.parse(raw);
      assert.equal(body.model, 'fixture-model');
      assert.equal(body.stream, false);
      const user = body.messages.at(-1).content;
      const maxTokens = protocol === 'openai' ? body.max_completion_tokens : body.max_tokens;
      let answer = 'PONG';
      if (user === 'PONG') {
        assert.equal(maxTokens, 64);
      } else {
        const data = JSON.parse(user);
        assert.ok(!raw.includes('dataDigest') && !raw.includes('empiricalSupport'));
        if (data.purpose === 'BOUNDED_GENOME_SUGGESTION') {
          assert.equal(maxTokens, 128);
          assert.equal(data.traits.length, 4);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: '{"code":7}' } }] }));
          return;
        }
        assert.equal(maxTokens, 4096);
        assert.ok(data.prerequisites.RUN_EXPERIMENT.includes('DESIGN_EXPERIMENT'));
        requests.push(data.role);
        const fixture = { run: { id: data.research_id, plan: { timeoutMs: data.timeout_ms, reasoning: data.reasoning, researchType: data.researchType } }, tasks: data.tasks,
          claim: { task: { id: data.task_id, role: data.role, action: data.action } } } as AgentContext;
        const output = await mocked.think(fixture, new AbortController().signal);
        if (data.action === 'REPLAN' && data.tasks.length === 1 && Array.isArray(output.proposals) && output.proposals.length) {
          output.proposals.push({ ...output.proposals[0], proposal_id: 'bad-role', target_agent_ids: ['evolution'] });
        }
        answer = JSON.stringify(output);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(protocol === 'openai' ? { choices: [{ message: { content: answer } }] }
        : { content: [{ type: 'text', text: answer }] }));
    });
    const store = await openStore(':memory:');
    try {
      const client = new RouterClient(router.profile, protocol, token);
      assert.equal((await client.probe()).result, 'PASS');
      const runtime = new RouterAgentRuntime(client);
      const lab = new ResearchOrchestrator(store, runtime);
      const run = store.create(demoObjective, compilePreset({}, runtime.kind, runtime.bindingId));
      const view = await lab.runToCheckpoint(run.id);
      assert.deepEqual(router.failures, []);
      assert.equal(view.run.status, 'INCONCLUSIVE');
      assert.deepEqual(new Set(requests), new Set(['director', 'hypothesis', 'skeptic', 'argumentation', 'moderator']));
      assert.equal(requests.length, 15);
      assert.ok(view.proposals.some(p => p.id === 'bad-role' && p.decision === 'REJECTED'));
      assert.equal((view.progressLedger.validation as { independentReproducibility: string }).independentReproducibility, 'PASS');
      assert.ok(view.residents.every(agent => !agent.sessionBound));
      assert.ok(!JSON.stringify(view).includes(token));
      const otherRuntime = new RouterAgentRuntime(new RouterClient(router.profile, protocol, token, 'changed-model'));
      await assert.rejects(new ResearchOrchestrator(store, otherRuntime).tick(store.create(demoObjective, run.plan).id), /runtime/);
      if (protocol === 'openai') {
        const previousCalls = requests.length;
        const first = await compareConnectedResearch(runtime, { checkpoint: store });
        assert.ok(requests.length > previousCalls);
        assert.equal(first.orchestration.length, 4);
        assert.equal(first.memory.length, 4);
        assert.equal(first.agentConditions.length, 7);
        assert.equal(first.guided.code, 7);
        assert.equal(first.candidates.genome.evaluation.eligible, false);
        assert.deepEqual(router.failures, []);
        const finishedCalls = requests.length;
        const resumed = await compareConnectedResearch(runtime, { checkpoint: store });
        assert.deepEqual(resumed, first);
        assert.equal(requests.length, finishedCalls);
      }
    } finally { store.close(); await router.close(); }
  });
}

test('rejects unapproved destinations, redirects and invalid bodies without exposing credentials', async () => {
  let hits = 0;
  const router = await localRouter((_req, res) => {
    hits++;
    if (hits === 1) res.writeHead(307, { Location: '/must-not-follow' }).end();
    else if (hits === 2) res.writeHead(401).end(token);
    else if (hits === 3) res.writeHead(429).end(token);
    else if (hits === 4) res.writeHead(200).end('{wrong');
    else if (hits === 5) res.writeHead(200).end(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(530_000) } }] }));
    else if (hits === 6) res.writeHead(200).end(JSON.stringify({ choices: [{ message: { content: token } }] }));
  });
  try {
    assert.throws(() => new RouterClient({ ...router.profile, host: 'example.invalid' }, 'openai', token), /non-loopback/);
    assert.throws(() => new RouterClient({ ...router.profile, openai_path: '//elsewhere/v1' }, 'openai', token));
    assert.throws(() => new RouterClient(router.profile, 'openai'));
    const client = new RouterClient(router.profile, 'openai', token);
    for (const code of ['ROUTER_REDIRECT', 'ROUTER_AUTH', 'ROUTER_RATE_LIMIT', 'ROUTER_INVALID_RESPONSE', 'ROUTER_RESPONSE_TOO_LARGE', 'ROUTER_INVALID_OUTPUT']) {
      await assert.rejects(client.probe(), { message: code });
    }
    assert.equal(hits, 6);
    await assert.rejects(client.probe(AbortSignal.timeout(40)), { message: 'ROUTER_TIMEOUT' });
    assert.deepEqual(router.failures, []);
  } finally { await router.close(); }
});

test('CLI probes a Router profile without sending a credential in anonymous mode', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gajae-router-profile-'));
  const router = await localRouter(async (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.url, '/gateway/v1/chat/completions');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'PONG' } }] }));
  });
  try {
    const profile = join(directory, 'router.json');
    writeFileSync(profile, JSON.stringify({ ...router.profile, authentication: 'none' }));
    const entry = fileURLToPath(new URL('../apps/lab/main.ts', import.meta.url));
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [entry, 'router-probe'], {
      env: { ...process.env, LAB_ROUTER_PROFILE: profile, LAB_ROUTER_PROTOCOL: 'openai', LAB_ROUTER_TOKEN: token }, timeout: 10_000,
    });
    assert.equal(JSON.parse(stdout).result, 'PASS');
    assert.ok(!stdout.includes(token) && !stderr.includes(token));
    assert.deepEqual(router.failures, []);
  } finally { await router.close(); rmSync(directory, { recursive: true, force: true }); }
});
