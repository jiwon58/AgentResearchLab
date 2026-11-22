import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { hypothesisTraits, reasoningPrompt, type AgentContext, type AgentRuntime } from './agents.ts';
import { hash, isRecord } from './contracts.ts';

export type RouterProtocol = 'openai' | 'anthropic';
type Failure = 'ROUTER_AUTH' | 'ROUTER_REDIRECT' | 'ROUTER_HTTP' | 'ROUTER_RATE_LIMIT' | 'ROUTER_UNREACHABLE'
  | 'ROUTER_RESPONSE_TOO_LARGE' | 'ROUTER_INVALID_RESPONSE' | 'ROUTER_INVALID_OUTPUT' | 'ROUTER_TIMEOUT' | 'ROUTER_ABORTED';

export class RouterError extends Error {
  readonly code: Failure;
  constructor(code: Failure) { super(code); this.code = code; }
}

const maxReplyBytes = 512 * 1024;
const maxOutputBytes = 32 * 1024;
const httpAgent = new HttpAgent({ keepAlive: true });
const httpsAgent = new HttpsAgent({ keepAlive: true });

function getText(body: unknown, protocol: RouterProtocol): string {
  if (!isRecord(body)) throw new RouterError('ROUTER_INVALID_RESPONSE');
  if (protocol === 'openai') {
    const first = Array.isArray(body.choices) ? body.choices[0] : undefined;
    if (isRecord(first) && isRecord(first.message) && typeof first.message.content === 'string') return first.message.content;
  } else if (Array.isArray(body.content)) {
    return body.content.filter(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text).join('');
  }
  throw new RouterError('ROUTER_INVALID_RESPONSE');
}

export class RouterClient {
  readonly bindingId: string;
  readonly protocol: RouterProtocol;
  #endpoint: URL;
  #model: string;
  #credential: string;

  constructor(profile: unknown, protocol: RouterProtocol, token?: string, modelOverride?: string) {
    if (!isRecord(profile) || profile.enabled !== true || (profile.scheme !== 'http' && profile.scheme !== 'https')
      || typeof profile.host !== 'string' || !/^[\da-z.:[\]-]+$/i.test(profile.host)
      || typeof profile.port !== 'number' || !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535
      || (profile.authentication !== 'none' && profile.authentication !== 'bearer')
      || (protocol !== 'openai' && protocol !== 'anthropic')) throw new Error('Invalid or disabled Router profile');
    const host = profile.host.replace(/^\[|\]$/g, '');
    const authority = isIP(host) === 6 ? `[${host}]` : host;
    const url = new URL(`${profile.scheme}://${authority}:${profile.port}/`);
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname) && isIP(url.hostname) === 4;
    if (!loopback && profile.allow_remote !== true) throw new Error('The Router profile does not allow non-loopback access');
    const path = protocol === 'openai' ? profile.openai_path : profile.anthropic_path;
    if (typeof path !== 'string' || !/^(?:\/[a-z0-9._~/-]*)?$/i.test(path) || path.startsWith('//')
      || path.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid or disabled Router protocol path');
    const prefix = path.replace(/\/+$/, '');
    url.pathname = protocol === 'openai' ? `${prefix}/chat/completions`
      : `${prefix}${prefix.endsWith('/v1') ? '' : '/v1'}/messages`;
    const model = modelOverride ?? profile.model;
    if (typeof model !== 'string' || !/^[!-~]{1,200}$/.test(model)) throw new Error('A valid Router model is required');
    if (profile.authentication === 'bearer' && (!token || !/^[!-~]{1,4096}$/.test(token))) {
      throw new Error('LAB_ROUTER_TOKEN is required for bearer authentication');
    }
    this.protocol = protocol;
    this.#endpoint = url;
    this.#model = model;
    this.#credential = profile.authentication === 'bearer' ? token! : '';
    this.bindingId = hash({ protocol, endpoint: url.href, model, authentication: profile.authentication });
  }

  async complete(system: string, user: string, maxTokens: number, signal: AbortSignal) {
    const transportError = () => new RouterError(signal.aborted
      ? signal.reason?.name === 'TimeoutError' ? 'ROUTER_TIMEOUT' : 'ROUTER_ABORTED' : 'ROUTER_UNREACHABLE');
    if (signal.aborted) throw transportError();
    const anthropic = this.protocol === 'anthropic';
    const payload = JSON.stringify({ model: this.#model, stream: false,
      ...(anthropic ? { system, max_tokens: maxTokens } : { max_completion_tokens: maxTokens }),
      messages: [...(anthropic ? [] : [{ role: 'system', content: system }]), { role: 'user', content: user }],
    });
    if (Buffer.byteLength(payload) > 256 * 1024) throw new RouterError('ROUTER_INVALID_OUTPUT');
    const headers = {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), accept: 'application/json',
      ...(this.#credential ? { authorization: `Bearer ${this.#credential}` } : {}),
      ...(anthropic ? { 'anthropic-version': '2023-06-01' } : {}),
    };
    const secure = this.#endpoint.protocol === 'https:';
    const request = secure ? httpsRequest : httpRequest;
    const body = await new Promise<unknown>((resolve, reject) => {
      const req = request(this.#endpoint, { headers, signal, method: 'POST', agent: secure ? httpsAgent : httpAgent }, res => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.destroy();
          reject(new RouterError(status === 401 || status === 403 ? 'ROUTER_AUTH' : status === 429 ? 'ROUTER_RATE_LIMIT'
            : status >= 300 && status < 400 ? 'ROUTER_REDIRECT' : 'ROUTER_HTTP'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxReplyBytes) {
            reject(new RouterError('ROUTER_RESPONSE_TOO_LARGE'));
            res.destroy();
          } else chunks.push(chunk);
        });
        res.on('error', () => reject(transportError()));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new RouterError('ROUTER_INVALID_RESPONSE')); }
        });
      });
      req.on('error', () => reject(transportError()));
      req.end(payload);
    });
    if (signal.aborted) throw transportError();
    const text = getText(body, this.protocol).trim();
    if (!text || Buffer.byteLength(text) > maxOutputBytes || (this.#credential && text.includes(this.#credential))) {
      throw new RouterError('ROUTER_INVALID_OUTPUT');
    }
    return text;
  }

  async probe(signal = AbortSignal.timeout(20_000)) {
    const text = await this.complete('Reply with exactly PONG.', 'PONG', 64, signal);
    if (!/^pong[.!]?$/i.test(text)) throw new RouterError('ROUTER_INVALID_OUTPUT');
    return { runtime: 'router', protocol: this.protocol, bindingId: this.bindingId, result: 'PASS' };
  }
}

export class RouterAgentRuntime implements AgentRuntime {
  readonly kind = 'router';
  readonly bindingId: string;
  #client: RouterClient;

  constructor(client: RouterClient) {
    this.#client = client;
    this.bindingId = client.bindingId;
  }

  async think(context: AgentContext, signal: AbortSignal) {
    const prompt = reasoningPrompt(context);
    const text = await this.#client.complete(prompt.system.join('\n'), JSON.stringify(prompt.user), 4096, signal);
    try {
      const output: unknown = JSON.parse(text);
      if (!isRecord(output)) throw new Error('Expected JSON object');
      return output;
    } catch {
      throw new RouterError('ROUTER_INVALID_OUTPUT');
    }
  }

  async proposeGenome(development: readonly { code: number; quality: number; validated: boolean }[], signal: AbortSignal) {
    const text = await this.#client.complete('Propose a combination of allowed hypothesis traits for a development-only benchmark. Return JSON {"code":integer}.',
      JSON.stringify({ purpose: 'BOUNDED_GENOME_SUGGESTION', development, traits: hypothesisTraits, encoding: 'Enable traits by four-bit mask from 0 to 15.' }), 128, signal);
    try {
      const object: unknown = JSON.parse(text);
      if (!isRecord(object) || Object.keys(object).length !== 1 || typeof object.code !== 'number' || !Number.isInteger(object.code) || object.code < 0 || object.code > 15) {
        throw new Error('Invalid trait mask');
      }
      return object.code;
    } catch { throw new RouterError('ROUTER_INVALID_OUTPUT'); }
  }
}
