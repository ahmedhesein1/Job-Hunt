import { limits } from '../../config/limits';
import type { Validators } from '../sources/contract';
import { countHttp, countHttpBytes, countUsage } from '../lib/usage';
import { assertSafeUrl, dnsResolver, type Resolver } from './redirect-guard';

/**
 * §5.2 shared HTTP client for every source adapter: honest User-Agent, HTTPS GET only,
 * timeouts, per-hop redirect validation, content-type checks, response-size caps and
 * conditional request headers.
 */
export class ResponseTooLargeError extends Error {
  override name = 'ResponseTooLargeError';
}

export class NetworkError extends Error {
  override name = 'NetworkError';
}

/** The caller's signal ended the request (e.g. a cycle deadline): not a network fault. */
export class RequestAbortedError extends Error {
  override name = 'RequestAbortedError';
}

export interface GetOptions {
  allowedHosts: readonly string[];
  accept: string;
  validators?: Validators | undefined;
  maxBytes?: number | undefined;
  headers?: Record<string, string> | undefined;
  /** Caller's cancellation (e.g. a deadline); combined with the client's own timeout. */
  signal?: AbortSignal | undefined;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  finalUrl: string;
  /** Reads the body as text, enforcing the size cap. */
  text(): Promise<string>;
  /** Streams the body as decoded text chunks, enforcing the size cap. */
  chunks(): AsyncGenerator<string>;
  /** Discards the body (304s, errors) so the connection can be reused. */
  discard(): Promise<void>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  userAgent?: string;
  fetchImpl?: FetchLike;
  resolver?: Resolver;
  timeoutMs?: number;
}

export function defaultUserAgent(): string {
  // Honest, stable identification (§5.2). The contact is configured at deploy time.
  const contact = process.env.USER_AGENT_CONTACT;
  return contact ? `JobFinder/1.0 (+${contact})` : 'JobFinder/1.0 (personal job alert bot)';
}

async function* readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number, host: string, caller: AbortSignal | undefined): AsyncGenerator<string> {
  if (!body) return;
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (caller?.aborted) throw new RequestAbortedError(`response from ${host} cancelled by caller`);
        throw err;
      }
      const { done, value } = chunk;
      if (done) break;
      total += value.byteLength;
      // §9 usage: decoded bytes downloaded (inbound transfer is free; tracked for visibility).
      countHttpBytes(host, value.byteLength);
      if (total > maxBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError(`Response exceeded ${maxBytes} bytes`);
      }
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

export class HttpClient {
  private readonly userAgent: string;
  private readonly fetchImpl: FetchLike;
  private readonly resolver: Resolver;
  private readonly timeoutMs: number;

  constructor(options: HttpClientOptions = {}) {
    this.userAgent = options.userAgent ?? defaultUserAgent();
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.resolver = options.resolver ?? dnsResolver;
    this.timeoutMs = options.timeoutMs ?? limits.http.timeoutMs;
  }

  async get(url: string, options: GetOptions): Promise<HttpResponse> {
    const maxBytes = options.maxBytes ?? limits.http.maxJsonBytes;
    options.signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      accept: options.accept,
      'accept-encoding': 'gzip, deflate, br',
      ...options.headers,
    };
    // §5.3: only send validators the server actually supplied.
    if (options.validators?.etag) headers['if-none-match'] = options.validators.etag;
    if (options.validators?.lastModified) headers['if-modified-since'] = options.validators.lastModified;

    let current = url;
    for (let hop = 0; hop <= limits.http.maxRedirects; hop++) {
      await assertSafeUrl(current, options.allowedHosts, this.resolver);
      let response: Response;
      const host = new URL(current).hostname;
      countHttp(host);
      try {
        response = await this.fetchImpl(current, { method: 'GET', headers, redirect: 'manual', signal });
      } catch (err) {
        if (options.signal?.aborted) throw new RequestAbortedError(`request to ${host} cancelled by caller`);
        countUsage('httpErrors');
        const name = (err as Error).name;
        throw new NetworkError(name === 'TimeoutError' || name === 'AbortError' ? `timeout after ${this.timeoutMs} ms` : `network error: ${(err as Error).message}`);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new NetworkError(`redirect without Location from ${current}`);
        // Each hop is revalidated against the allowlist and private-IP rules.
        current = new URL(location, current).toString();
        continue;
      }
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > maxBytes) {
        await response.body?.cancel();
        throw new ResponseTooLargeError(`Content-Length ${declared} exceeds ${maxBytes}`);
      }
      const body = response.body;
      let consumed = false;
      const take = () => {
        if (consumed) throw new Error('Response body already consumed');
        consumed = true;
        return readCapped(body, maxBytes, host, options.signal);
      };
      return {
        status: response.status,
        headers: response.headers,
        finalUrl: current,
        text: async () => {
          let out = '';
          for await (const chunk of take()) out += chunk;
          return out;
        },
        chunks: take,
        discard: async () => {
          if (!consumed) {
            consumed = true;
            await body?.cancel().catch(() => undefined);
          }
        },
      };
    }
    throw new NetworkError(`too many redirects (>${limits.http.maxRedirects})`);
  }
}

/** Validators to persist after a 200 (§5.3). */
export function validatorsFrom(headers: Headers): Validators {
  return {
    etag: headers.get('etag') ?? undefined,
    lastModified: headers.get('last-modified') ?? undefined,
  };
}
