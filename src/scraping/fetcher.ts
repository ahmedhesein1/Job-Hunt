import { limits } from '../../config/limits';
import { logger } from '../lib/logger';
import { sleep } from '../lib/time';
import type { Validators } from '../sources/contract';
import { GateClosedError, type DomainGate } from './domain-gate';
import { HttpClient, NetworkError, RequestAbortedError, ResponseTooLargeError, type HttpResponse } from './http-client';
import { UnsafeUrlError } from './redirect-guard';
import { backoffDelayMs, classifyStatus, isRetryableInRun, looksLikeChallenge, looksLikeChallengePage, type Outcome } from './retry-policy';
import { crawlDelaySeconds, isAllowed, parseRobots, type RobotsRules } from './robots-policy';

/** Thrown when a request ends in a non-success outcome after the retry policy (§5.5). */
export class SourceHttpError extends Error {
  override name = 'SourceHttpError';
  constructor(
    readonly outcome: Outcome,
    readonly url: string,
  ) {
    super(`${outcome.type} for ${new URL(url).hostname}${'status' in outcome && outcome.status ? ` (HTTP ${outcome.status})` : ''}`);
  }
}

export interface FetchRequest {
  url: string;
  allowedHosts: readonly string[];
  /** Expected media type family; anything else is checked for a challenge page. */
  expect: 'json' | 'xml' | 'html';
  validators?: Validators | undefined;
  maxBytes?: number | undefined;
  respectRobots?: boolean | undefined;
  headers?: Record<string, string> | undefined;
  /** Caller's deadline: stops the request in flight and any further attempts. */
  signal?: AbortSignal | undefined;
  /** In-run retries for transient failures (default limits.http.maxTransientRetries). */
  maxRetries?: number | undefined;
}

function throwIfCancelled(request: FetchRequest): void {
  if (request.signal?.aborted) throw new RequestAbortedError(`request to ${new URL(request.url).hostname} cancelled by caller`);
}

export type FetchOutcome<T> = { kind: 'not-modified' } | { kind: 'ok'; value: T; headers: Headers };

const ACCEPT = {
  json: 'application/json',
  xml: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8',
  html: 'text/html, application/xhtml+xml;q=0.9',
} as const;

const CONTENT_TYPE = {
  json: /json|javascript/i,
  xml: /xml|rss|atom/i,
  html: /html/i,
} as const;

/** Re-exposes an already-read body through the HttpResponse interface. */
function bufferedResponse(response: HttpResponse, body: string): HttpResponse {
  return {
    status: response.status,
    headers: response.headers,
    finalUrl: response.finalUrl,
    text: async () => body,
    chunks: async function* () {
      yield body;
    },
    discard: async () => undefined,
  };
}

const robotsCache = new Map<string, { rules: RobotsRules; expiresAt: number }>();
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Domain-gated, policy-compliant fetch. One request per host at a time, bounded
 * retries for transient failures only, and an immediate stop on 401/403/CAPTCHA.
 * `consume` runs while the host lease is held, so body streaming counts as in-flight.
 */
export class Fetcher {
  constructor(
    private readonly gate: DomainGate,
    private readonly http: HttpClient = new HttpClient(),
    private readonly sleeper: (ms: number) => Promise<void> = sleep,
    private readonly clock: () => number = Date.now,
  ) {}

  /** The per-host gate this fetcher uses (shared with the browser transport). */
  get domainGate(): DomainGate {
    return this.gate;
  }

  /** robots.txt check (cached 24 h per host); also applies the site's Crawl-delay to the gate. */
  async robotsAllow(request: Pick<FetchRequest, 'url' | 'allowedHosts'>): Promise<boolean> {
    const url = new URL(request.url);
    const cached = robotsCache.get(url.host);
    let rules = cached && cached.expiresAt > this.clock() ? cached.rules : undefined;
    if (!rules) {
      const result = await this.fetch<string>(
        { url: `${url.origin}/robots.txt`, allowedHosts: request.allowedHosts, expect: 'xml', maxBytes: 512 * 1024, respectRobots: false },
        (res) => res.text(),
        { allowAnyContentType: true, notFoundIsEmpty: true },
      );
      rules = parseRobots(result.kind === 'ok' ? result.value : '');
      robotsCache.set(url.host, { rules, expiresAt: this.clock() + ROBOTS_TTL_MS });
    }
    const delay = crawlDelaySeconds(rules, 'JobFinder/1.0');
    if (delay !== undefined) this.gate.raiseMinGap(url.hostname, delay * 1000);
    return isAllowed(rules, 'JobFinder/1.0', `${url.pathname}${url.search}`);
  }

  async fetch<T>(
    request: FetchRequest,
    consume: (response: HttpResponse) => Promise<T>,
    internal: { allowAnyContentType?: boolean; notFoundIsEmpty?: boolean } = {},
  ): Promise<FetchOutcome<T>> {
    if (request.respectRobots && !(await this.robotsAllow(request))) {
      throw new SourceHttpError({ type: 'FORBIDDEN', status: 0 }, request.url);
    }
    const hostname = new URL(request.url).hostname;
    const maxRetries = request.maxRetries ?? limits.http.maxTransientRetries;
    let lastOutcome: Outcome | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await this.sleeper(backoffDelayMs(attempt - 1, this.gate.minGapFor(hostname)));
      throwIfCancelled(request);
      let lease;
      try {
        lease = await this.gate.acquire(hostname);
      } catch (err) {
        // A retry blocked by the host breaker (opened by our own failures) ends the run
        // with the real failure, so the source breaker records it.
        if (attempt > 0 && err instanceof GateClosedError && lastOutcome) break;
        throw err;
      }
      let outcome: Outcome | undefined;
      try {
        const response = await this.http.get(request.url, {
          allowedHosts: request.allowedHosts,
          accept: ACCEPT[request.expect],
          validators: request.validators,
          maxBytes: request.maxBytes,
          headers: request.headers,
          signal: request.signal,
        });
        outcome = classifyStatus(response.status, response.headers, this.clock());

        if (outcome.type === 'NOT_FOUND' && internal.notFoundIsEmpty) {
          await response.discard();
          await this.gate.release(lease, { type: 'OK' });
          return { kind: 'ok', value: '' as T, headers: response.headers };
        }
        if (outcome.type === 'NOT_MODIFIED') {
          await response.discard();
          await this.gate.release(lease, outcome);
          return { kind: 'not-modified' };
        }
        if (outcome.type === 'OK') {
          const contentType = response.headers.get('content-type') ?? '';
          if (!internal.allowAnyContentType && !CONTENT_TYPE[request.expect].test(contentType)) {
            // An HTML page where an API/feed was expected is usually a block or login wall.
            const sample = (await response.text().catch(() => '')).slice(0, 4096);
            const challenge = looksLikeChallenge(response.headers, sample);
            outcome = challenge ? { type: 'CHALLENGE', detail: challenge } : { type: 'BAD_CONTENT', detail: `content-type ${contentType || 'missing'}` };
          } else if (request.expect === 'html') {
            // A CAPTCHA or login page is also text/html: inspect the page before accepting it.
            const html = await response.text();
            const challenge = looksLikeChallengePage(response.headers, html);
            if (challenge) outcome = { type: 'CHALLENGE', detail: challenge };
            else {
              const value = await consume(bufferedResponse(response, html));
              await this.gate.release(lease, outcome);
              return { kind: 'ok', value, headers: response.headers };
            }
          } else {
            const value = await consume(response);
            await this.gate.release(lease, outcome);
            return { kind: 'ok', value, headers: response.headers };
          }
        } else {
          if (outcome.type === 'FORBIDDEN') {
            const sample = (await response.text().catch(() => '')).slice(0, 4096);
            const challenge = looksLikeChallenge(response.headers, sample);
            if (challenge) outcome = { type: 'CHALLENGE', detail: challenge };
          } else {
            await response.discard();
          }
        }
      } catch (err) {
        if (err instanceof NetworkError) outcome = { type: 'TRANSIENT', detail: err.message };
        else if (err instanceof ResponseTooLargeError) outcome = { type: 'BAD_CONTENT', detail: err.message };
        else {
          // Programming errors, unsafe URLs, parse failures: release without touching the breaker.
          await this.gate.release(lease, undefined);
          if (err instanceof UnsafeUrlError) logger.warn('blocked unsafe URL', { host: hostname, reason: err.message });
          throw err;
        }
      }

      // §5.5: retry transient failures first; only the final outcome of the request is
      // recorded on the host breaker ("then record failure and let the breaker decide").
      const willRetry = isRetryableInRun(outcome) && attempt < maxRetries;
      await this.gate.release(lease, willRetry ? undefined : outcome);
      lastOutcome = outcome;
      if (!willRetry) break;
      logger.info('transient failure, will retry', { host: hostname, attempt, outcome: outcome.type });
    }
    throw new SourceHttpError(lastOutcome as Outcome, request.url);
  }
}
