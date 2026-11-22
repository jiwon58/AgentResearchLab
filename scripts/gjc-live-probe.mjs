import { mkdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export class UnsupportedProbe extends Error {}

export async function liveProbe(stage, scratch, providerPath, sdk, SessionManager) {
  if (!isAbsolute(providerPath)) throw new Error('An approved provider module is required');
  const provider = await import(pathToFileURL(providerPath).href);
  const binding = await provider.getApprovedBinding();
  if (!binding?.model || !binding?.modelRegistry || !binding?.authStorage) throw new Error('Incomplete approved provider binding');
  const { model, modelRegistry, authStorage } = binding;
  async function session(directory, manager, tools = []) {
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(directory, 'sessions'), { recursive: true });
    return (await sdk.createAgentSession({
      model, modelRegistry, authStorage, cwd: directory, agentDir: join(directory, 'agent'),
      sessionManager: manager ?? SessionManager.create(directory, join(directory, 'sessions')),
      systemPrompt: ['This is a Windows SDK compatibility probe. Follow only the requested diagnostic.'],
      toolNames: [], customTools: tools, contextFiles: [], skills: [], rules: [], promptTemplates: [], slashCommands: [],
      disableExtensionDiscovery: true, enableMCP: false, enableMcpAutoload: false, enableLsp: false,
      skipPythonPreflight: true, deferMemoryBackendStartup: true, deferOptionalModelRefresh: true, deferModelProfileActivation: true,
    })).session;
  }
  async function prompt(handle, input, expected) {
    let reply = '';
    let failed = false;
    let events = 0;
    const unsubscribe = handle.subscribe(event => {
      if (event.type === 'agent_failed') failed = true;
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        events++;
        if (reply.length <= 8192) reply += event.assistantMessageEvent.delta ?? '';
      }
    });
    try { await handle.prompt(input, { expandPromptTemplates: false }); }
    finally { unsubscribe(); }
    if (failed || reply.trim() !== expected) throw new Error('The diagnostic did not return the expected result');
    return events;
  }
  async function use(directory, fn, manager, tools) {
    const handle = await session(directory, manager, tools);
    try { return await fn(handle); } finally { await handle.dispose(); }
  }
  function savedFile(handle, directory) {
    const file = handle.sessionFile;
    if (typeof file !== 'string' || !isAbsolute(file)) throw new Error('No persistent session was written');
    const path = relative(join(directory, 'sessions'), file);
    if (!path || isAbsolute(path) || path.startsWith('..') || !statSync(file).isFile()) throw new Error('Invalid session storage reference');
    return file;
  }

  if (stage === 'multiple-sessions') {
    await Promise.all(['ALPHA', 'BRAVO', 'CHARLIE'].map(marker => use(join(scratch, marker), async handle => {
      await prompt(handle, `Reply exactly ${marker}.`, marker);
      savedFile(handle, join(scratch, marker));
    })));
    return { sessions: 3 };
  }
  if (stage === 'restricted-tool' || stage === 'native-subagent') {
    // Public SDK tool definitions for the installed release are provided by the approved environment.
    // Require a measured invocation and a unique marker rather than trusting a provider pass/fail flag.
    const factory = stage === 'restricted-tool' ? provider.createApprovedProbeTool : provider.createApprovedNativeProbe;
    if (typeof factory !== 'function') throw new UnsupportedProbe('APPROVED_TOOL_ADAPTER_REQUIRED');
    const marker = `LAB_${randomUUID().replaceAll('-', '')}`;
    let calls = 0;
    const result = await factory({ marker, onExecution: () => { calls++; } });
    if (!result?.tool || typeof result.instruction !== 'string' || result.instruction.length > 1500
      || (stage === 'native-subagent' && result.inProcessOnly !== true)) throw new Error('Invalid diagnostic tool binding');
    await use(scratch, handle => prompt(handle, result.instruction, marker), undefined, [result.tool]);
    if (calls !== 1) throw new Error('Expected exactly one observed diagnostic invocation');
    return { invocationCount: calls };
  }
  if (stage === 'session-save' || stage === 'session-restore') {
    const marker = `LAB_${randomUUID().replaceAll('-', '')}`;
    const file = await use(scratch, async handle => {
      await prompt(handle, `Remember this marker for the next turn. Reply exactly ${marker}.`, marker);
      return savedFile(handle, scratch);
    });
    if (stage === 'session-restore') {
      const manager = await SessionManager.open(file);
      await use(scratch, handle => prompt(handle, 'Reply with exactly the marker from the previous turn.', marker), manager);
    }
    return { sessionWritten: true, reopened: stage === 'session-restore' };
  }
  if (stage !== 'tool-free-llm' && stage !== 'agent-events') throw new Error('Unknown live diagnostic stage');
  const events = await use(scratch, handle => prompt(handle, 'Reply exactly PONG.', 'PONG'));
  return stage === 'agent-events' ? { textEvents: events } : { responded: true };
}
