import { describe, expect, it, vi } from 'vitest';
import { applyOutcome, initialBreaker, isBlocked } from '../../../src/scraping/circuit-breaker';
import { DomainGate, GateClosedError, InMemoryDomainGateStore } from '../../../src/scraping/domain-gate';
import { Fetcher, SourceHttpError } from '../../../src/scraping/fetcher';
import { HttpClient, NetworkError, ResponseTooLargeError, type FetchLike } from '../../../src/scraping/http-client';
import { assertSafeUrl, isPrivateAddress, UnsafeUrlError } from '../../../src/scraping/redirect-guard';
import { backoffDelayMs, parseRetryAfter } from '../../../src/scraping/retry-policy';
import { isAllowed, parseRobots } from '../../../src/scraping/robots-policy';

const publicResolver = async () => ['93.184.216.34'];
const HOSTS = ['api.example.com', 'cdn.example.com'];

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...init.headers }, ...init });
}

function client(fetchImpl: FetchLike, timeoutMs = 18_000) {
  return new HttpClient({ fetchImpl, resolver: publicResolver, userAgent: 'JobFinder/1.0 (test)', timeoutMs });
}

describe('HttpClient (§5.2–5.3)', () => {
  it('sends honest UA and stored validators only', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonResponse({}));
    await client(fetchImpl).get('https://api.example.com/x', { allowedHosts: HOSTS, accept: 'application/json', validators: { etag: 'W/"1"', lastModified: undefined } });
    const headers = fetchImpl.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['user-agent']).toBe('JobFinder/1.0 (test)');
    expect(headers['if-none-match']).toBe('W/"1"');
    expect(headers['if-modified-since']).toBeUndefined();
  });

  it('validates every redirect hop against the allowlist', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) =>
      url.includes('api.example.com')
        ? new Response(null, { status: 302, headers: { location: 'https://evil.example.net/steal' } })
        : jsonResponse({}),
    );
    await expect(client(fetchImpl).get('https://api.example.com/x', { allowedHosts: HOSTS, accept: '*/*' })).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows allowed redirects', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url) =>
      url.includes('api.example.com') ? new Response(null, { status: 301, headers: { location: 'https://cdn.example.com/x' } }) : jsonResponse({ ok: 1 }),
    );
    const res = await client(fetchImpl).get('https://api.example.com/x', { allowedHosts: HOSTS, accept: '*/*' });
    expect(res.finalUrl).toBe('https://cdn.example.com/x');
    expect(JSON.parse(await res.text())).toEqual({ ok: 1 });
  });

  it('enforces the response-size cap while streaming', async () => {
    const big = 'x'.repeat(2048);
    const res = await client(async () => new Response(big, { status: 200, headers: { 'content-type': 'application/json' } })).get('https://api.example.com/x', {
      allowedHosts: HOSTS,
      accept: '*/*',
      maxBytes: 1024,
    });
    await expect(res.text()).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('times out with AbortSignal.timeout', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))));
    await expect(client(hang, 20).get('https://api.example.com/x', { allowedHosts: HOSTS, accept: '*/*' })).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('SSRF guard (§13)', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00:ec2::254', 'fe80::1', '::ffff:10.0.0.1'])(
    'rejects private address %s',
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );

  it('accepts public addresses', () => expect(isPrivateAddress('93.184.216.34')).toBe(false));

  it('rejects http, IP literals, unknown hosts and private DNS answers', async () => {
    await expect(assertSafeUrl('http://api.example.com/', HOSTS, publicResolver)).rejects.toThrow(/HTTPS/);
    await expect(assertSafeUrl('https://169.254.169.254/latest', HOSTS, publicResolver)).rejects.toThrow(/IP-literal/);
    await expect(assertSafeUrl('https://other.example.com/', HOSTS, publicResolver)).rejects.toThrow(/allowlist/);
    await expect(assertSafeUrl('https://api.example.com/', HOSTS, async () => ['10.0.0.5'])).rejects.toThrow(/private/);
  });
});

describe('retry policy (§5.5)', () => {
  it('parses Retry-After seconds and HTTP dates', () => {
    const now = Date.parse('2026-11-10T10:00:00Z');
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('Tue, 10 Nov 2026 10:05:00 GMT', now)).toBe(300_000);
    expect(parseRetryAfter('garbage', now)).toBeUndefined();
  });

  it('backs off ~1 s, 2 s, 4 s with jitter and a strict cap', () => {
    expect(backoffDelayMs(0, 0, () => 0)).toBe(1000);
    expect(backoffDelayMs(1, 0, () => 0)).toBe(2000);
    expect(backoffDelayMs(2, 0, () => 1)).toBe(8000);
    expect(backoffDelayMs(10, 0, () => 1)).toBe(8000);
    expect(backoffDelayMs(0, 1500, () => 0)).toBe(1500);
  });
});

describe('circuit breaker (§5.6)', () => {
  const now = 1_000_000;
  it('honours Retry-After on 429 and alerts once after repeated rate limits', () => {
    let s = initialBreaker();
    const r1 = applyOutcome(s, { type: 'RATE_LIMITED', retryAfterMs: 60_000 }, now, () => 0);
    expect(r1.state.cooldownUntil).toBe(now + 60_000);
    expect(r1.transition).toBeUndefined();
    s = r1.state;
    s = applyOutcome(s, { type: 'RATE_LIMITED', retryAfterMs: undefined }, now, () => 0).state;
    const r3 = applyOutcome(s, { type: 'RATE_LIMITED', retryAfterMs: undefined }, now, () => 0);
    expect(r3.transition?.message).toMatch(/slowed ×2/);
    expect(r3.state.intervalMultiplier).toBe(2);
  });

  it('opens after three transient failures and escalates the pause', () => {
    let s = initialBreaker();
    for (let i = 0; i < 2; i++) s = applyOutcome(s, { type: 'TRANSIENT', status: 502, detail: 'HTTP 502' }, now, () => 0).state;
    const opened = applyOutcome(s, { type: 'TRANSIENT', status: 502, detail: 'HTTP 502' }, now, () => 0);
    expect(opened.state.status).toBe('OPEN');
    expect(opened.state.cooldownUntil).toBe(now + 3_600_000);
    expect(isBlocked(opened.state, now + 1000)).toBe(true);
    let s2 = opened.state;
    for (let i = 0; i < 3; i++) s2 = applyOutcome(s2, { type: 'TRANSIENT', detail: 'timeout' }, now, () => 0).state;
    expect(s2.cooldownUntil).toBe(now + 7_200_000);
  });

  it('pauses immediately on 403/CAPTCHA and success never clears manual review', () => {
    const paused = applyOutcome(initialBreaker(), { type: 'FORBIDDEN', status: 403 }, now);
    expect(paused.state.status).toBe('MANUAL_REVIEW');
    expect(paused.transition).toBeDefined();
    const after = applyOutcome(paused.state, { type: 'OK' }, now);
    expect(after.state.status).toBe('MANUAL_REVIEW');
    expect(applyOutcome(paused.state, { type: 'CHALLENGE', detail: 'captcha' }, now).transition).toBeUndefined();
  });
});

describe('robots.txt (§5.1)', () => {
  const rules = parseRobots(['User-agent: *', 'Disallow: /*?q=', 'Disallow: /iframe/', 'Allow: /iframe/public', '', 'User-agent: BadBot', 'Disallow: /'].join('\n'));
  it('applies longest-match rules for the * group', () => {
    expect(isAllowed(rules, 'JobFinder/1.0', '/feeds/all-jobs.xml')).toBe(true);
    expect(isAllowed(rules, 'JobFinder/1.0', '/search?q=node')).toBe(false);
    expect(isAllowed(rules, 'JobFinder/1.0', '/iframe/x')).toBe(false);
    expect(isAllowed(rules, 'JobFinder/1.0', '/iframe/public')).toBe(true);
    expect(isAllowed(rules, 'BadBot/2.0', '/feeds')).toBe(false);
  });
});

describe('Fetcher + domain gate (§5.4–5.5)', () => {
  function setup(fetchImpl: FetchLike, clock = { t: 1_000_000 }) {
    const store = new InMemoryDomainGateStore();
    const sleeps: number[] = [];
    const sleeper = async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    };
    const gate = new DomainGate(store, 'run-1', { clock: () => clock.t, sleeper, minGapMs: () => 1500 });
    const fetcher = new Fetcher(gate, client(fetchImpl), sleeper, () => clock.t);
    return { store, sleeps, fetcher, clock };
  }
  const req = { url: 'https://api.example.com/jobs', allowedHosts: HOSTS, expect: 'json' as const };

  it('treats 304 as success without reading a body', async () => {
    const { fetcher } = setup(async () => new Response(null, { status: 304 }));
    const consume = vi.fn();
    expect(await fetcher.fetch(req, consume)).toEqual({ kind: 'not-modified' });
    expect(consume).not.toHaveBeenCalled();
  });

  it('honours Retry-After on 429 with no tight retry loop, then the gate stays closed', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response('', { status: 429, headers: { 'retry-after': '600' } }));
    const { fetcher, store, clock } = setup(fetchImpl);
    await expect(fetcher.fetch(req, async () => 1)).rejects.toBeInstanceOf(SourceHttpError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const gate = await store.get('api.example.com');
    expect(gate!.breaker.cooldownUntil).toBeGreaterThanOrEqual(clock.t + 600_000);
    await expect(fetcher.fetch(req, async () => 1)).rejects.toBeInstanceOf(GateClosedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('pauses the host on 403 and never retries or rotates anything', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain' } }));
    const { fetcher, store } = setup(fetchImpl);
    const err = await fetcher.fetch(req, async () => 1).catch((e: unknown) => e);
    expect((err as SourceHttpError).outcome.type).toBe('FORBIDDEN');
    expect((await store.get('api.example.com'))!.breaker.status).toBe('MANUAL_REVIEW');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const headers = fetchImpl.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['user-agent']).toBe('JobFinder/1.0 (test)');
  });

  it('detects a CAPTCHA page served instead of JSON', async () => {
    const { fetcher } = setup(async () => new Response('<html><title>Just a moment...</title>captcha</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const err = (await fetcher.fetch(req, async () => 1).catch((e: unknown) => e)) as SourceHttpError;
    expect(err.outcome.type).toBe('CHALLENGE');
  });

  it('rejects an unexpected content type', async () => {
    const { fetcher } = setup(async () => new Response('plain', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const err = (await fetcher.fetch(req, async () => 1).catch((e: unknown) => e)) as SourceHttpError;
    expect(err.outcome.type).toBe('BAD_CONTENT');
  });

  it('retries 5xx up to 3 times with backoff, then fails', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response('', { status: 503 }));
    const { fetcher, sleeps } = setup(fetchImpl);
    const err = (await fetcher.fetch(req, async () => 1).catch((e: unknown) => e)) as SourceHttpError;
    expect(err.outcome.type).toBe('TRANSIENT');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleeps.filter((s) => s >= 1000).length).toBeGreaterThanOrEqual(3);
  });

  it('never lets two runs hold the same host at once (rate gate)', async () => {
    const store = new InMemoryDomainGateStore();
    const t = 5_000_000;
    const a = await store.tryAcquire('api.example.com', 'run-a', t, 60_000);
    const b = await store.tryAcquire('api.example.com', 'run-b', t + 10, 60_000);
    expect(b.ok).toBe(false);
    if (!a.ok) throw new Error('first acquire should succeed');
    const gateA = new DomainGate(store, 'run-a', { clock: () => t + 20, minGapMs: () => 1500 });
    await gateA.release(a.record, { type: 'OK' });
    // Released, but the host spacing still applies.
    expect((await store.tryAcquire('api.example.com', 'run-b', t + 30, 60_000)).ok).toBe(false);
    expect((await store.tryAcquire('api.example.com', 'run-b', t + 20 + 1500, 60_000)).ok).toBe(true);
  });

  it('spaces sequential requests to the same host by the minimum gap', async () => {
    const { fetcher, sleeps } = setup(async () => jsonResponse({ ok: 1 }));
    await fetcher.fetch(req, async (r) => r.text());
    await fetcher.fetch(req, async (r) => r.text());
    expect(sleeps.some((s) => s >= 1500)).toBe(true);
  });
});
