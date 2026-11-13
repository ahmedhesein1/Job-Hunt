import { limits } from '../../config/limits';
import { sleep } from '../lib/time';
import { applyOutcome, initialBreaker, type BreakerState, type BreakerTransition } from './circuit-breaker';
import { isHostLevel, type Outcome } from './retry-policy';

/**
 * §5.4 domain-level request gate. One in-flight request per hostname, a minimum gap
 * between requests, and a host-level breaker. Persisted with conditional writes so two
 * Lambda invocations can never pass the same host's limit at once.
 */
export interface GateRecord {
  hostname: string;
  nextAllowedAt: number;
  leaseUntil?: number | undefined;
  leaseOwner?: string | undefined;
  breaker: BreakerState;
}

export type AcquireResult = { ok: true; record: GateRecord } | { ok: false; record: GateRecord | undefined };

export interface DomainGateStore {
  tryAcquire(hostname: string, owner: string, nowMs: number, leaseMs: number): Promise<AcquireResult>;
  release(hostname: string, owner: string, update: { nextAllowedAt: number; breaker: BreakerState }): Promise<void>;
  get(hostname: string): Promise<GateRecord | undefined>;
}

export class GateClosedError extends Error {
  override name = 'GateClosedError';
  constructor(
    readonly hostname: string,
    readonly reason: 'leased' | 'spacing' | 'cooldown' | 'paused',
    readonly retryAt: number | undefined,
  ) {
    super(`Domain gate for ${hostname} is closed (${reason})`);
  }
}

export interface DomainGateOptions {
  minGapMs?: (hostname: string) => number;
  clock?: () => number;
  sleeper?: (ms: number) => Promise<void>;
}

export class DomainGate {
  private readonly minGap: (hostname: string) => number;
  private readonly now: () => number;
  private readonly sleeper: (ms: number) => Promise<void>;
  readonly transitions: Array<{ hostname: string } & BreakerTransition> = [];

  constructor(
    private readonly store: DomainGateStore,
    readonly owner: string,
    options: DomainGateOptions = {},
  ) {
    this.minGap = options.minGapMs ?? ((hostname) => limits.domainGate.hostMinGapMs[hostname] ?? limits.domainGate.defaultMinGapMs);
    this.now = options.clock ?? Date.now;
    this.sleeper = options.sleeper ?? sleep;
  }

  private readonly gapOverrides = new Map<string, number>();

  minGapFor(hostname: string): number {
    return Math.max(this.minGap(hostname), this.gapOverrides.get(hostname) ?? 0);
  }

  /** Honour a site's robots.txt Crawl-delay; never lowers our own minimum gap. */
  raiseMinGap(hostname: string, ms: number): void {
    if (ms > this.minGapFor(hostname)) this.gapOverrides.set(hostname, ms);
  }

  private closedReason(record: GateRecord | undefined, nowMs: number): GateClosedError {
    const host = record?.hostname ?? 'unknown';
    if (!record) return new GateClosedError(host, 'leased', undefined);
    const b = record.breaker;
    if (b.status === 'MANUAL_REVIEW') return new GateClosedError(host, 'paused', undefined);
    if (b.cooldownUntil !== undefined && b.cooldownUntil > nowMs) return new GateClosedError(host, 'cooldown', b.cooldownUntil);
    if (record.leaseUntil !== undefined && record.leaseUntil > nowMs && record.leaseOwner !== this.owner) {
      return new GateClosedError(host, 'leased', record.leaseUntil);
    }
    return new GateClosedError(host, 'spacing', record.nextAllowedAt);
  }

  /**
   * Acquire the host slot. Waits briefly only for our own host spacing (≤ a few
   * seconds); any longer wait defers the work instead of sleeping in Lambda (§5.4).
   */
  async acquire(hostname: string): Promise<GateRecord> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const nowMs = this.now();
      const result = await this.store.tryAcquire(hostname, this.owner, nowMs, limits.domainGate.leaseMs);
      if (result.ok) return result.record;
      const closed = this.closedReason(result.record ? { ...result.record, hostname } : undefined, nowMs);
      const wait = closed.retryAt !== undefined ? closed.retryAt - nowMs : Number.POSITIVE_INFINITY;
      if (closed.reason !== 'spacing' || wait > limits.domainGate.maxInlineWaitMs) throw closed;
      await this.sleeper(Math.max(0, wait) + 25);
    }
    throw new GateClosedError(hostname, 'spacing', undefined);
  }

  /** Release the slot and apply host-level outcomes to the breaker. */
  async release(record: GateRecord, outcome: Outcome | undefined): Promise<BreakerTransition | undefined> {
    const nowMs = this.now();
    let breaker = record.breaker;
    let transition: BreakerTransition | undefined;
    if (outcome && isHostLevel(outcome)) {
      const applied = applyOutcome(breaker, outcome, nowMs);
      breaker = applied.state;
      transition = applied.transition;
    }
    await this.store.release(record.hostname, this.owner, { nextAllowedAt: nowMs + this.minGapFor(record.hostname), breaker });
    if (transition) this.transitions.push({ hostname: record.hostname, ...transition });
    return transition;
  }
}

/** In-memory store with the same semantics as the DynamoDB store (tests, local runs). */
export class InMemoryDomainGateStore implements DomainGateStore {
  readonly records = new Map<string, GateRecord>();

  async tryAcquire(hostname: string, owner: string, nowMs: number, leaseMs: number): Promise<AcquireResult> {
    const existing = this.records.get(hostname);
    const record: GateRecord = existing ?? { hostname, nextAllowedAt: 0, breaker: initialBreaker() };
    const b = record.breaker;
    const free =
      (record.leaseUntil === undefined || record.leaseUntil < nowMs) &&
      record.nextAllowedAt <= nowMs &&
      (b.cooldownUntil === undefined || b.cooldownUntil <= nowMs) &&
      b.status !== 'MANUAL_REVIEW';
    if (!free) return { ok: false, record: structuredClone(record) };
    const updated = { ...record, leaseOwner: owner, leaseUntil: nowMs + leaseMs };
    this.records.set(hostname, updated);
    return { ok: true, record: structuredClone(updated) };
  }

  async release(hostname: string, owner: string, update: { nextAllowedAt: number; breaker: BreakerState }): Promise<void> {
    const record = this.records.get(hostname);
    if (!record || record.leaseOwner !== owner) return;
    this.records.set(hostname, { hostname, nextAllowedAt: update.nextAllowedAt, breaker: update.breaker });
  }

  async get(hostname: string): Promise<GateRecord | undefined> {
    const r = this.records.get(hostname);
    return r ? structuredClone(r) : undefined;
  }
}
