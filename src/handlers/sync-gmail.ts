import { randomUUID } from 'node:crypto';
import { linkedinAlertSenders, sources } from '../../config/sources';
import { processJobs, windowStart } from '../core/pipeline';
import { putTextNotification } from '../data/outbox';
import { getSettings } from '../data/settings';
import { acquireLock, getSourceState, recordRun, releaseLock, saveSourceState, type RunSummary } from '../data/sources';
import { logger } from '../lib/logger';
import { getSecretFromEnv } from '../lib/secrets';
import { escapeHtml } from '../notifications/formatting';
import { applyOutcome } from '../scraping/circuit-breaker';
import type { Outcome } from '../scraping/retry-policy';
import type { ExternalJob } from '../sources/contract';
import { parseLinkedInAlert } from '../sources/email/linkedin';
import { notifyBreakerTransition } from './sync-source';
import { withUsage } from '../lib/usage';

/**
 * §12 LinkedIn job-alert ingestion through the Gmail API with OAuth read-only access
 * (scope gmail.readonly). Credentials live in SSM SecureString as JSON
 * {client_id, client_secret, refresh_token}. Processes only messages from expected
 * senders, tracks the Gmail history ID, and never logs bodies, tokens or full links.
 */
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 15_000;
const MAX_MESSAGES = 50;
const policy = sources['linkedin-email'];

class GmailError extends Error {
  override name = 'GmailError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function accessToken(): Promise<string> {
  const creds = JSON.parse(await getSecretFromEnv('GMAIL_OAUTH_PARAM')) as { client_id?: string; client_secret?: string; refresh_token?: string };
  if (!creds.client_id || !creds.client_secret || !creds.refresh_token) throw new GmailError(401, 'Gmail OAuth parameter is incomplete');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: creds.client_id, client_secret: creds.client_secret, refresh_token: creds.refresh_token, grant_type: 'refresh_token' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new GmailError(res.status, `token refresh failed (HTTP ${res.status})`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new GmailError(401, 'token refresh returned no access token');
  return body.access_token;
}

async function gmail<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${GMAIL}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new GmailError(res.status, `Gmail API HTTP ${res.status}`);
  return (await res.json()) as T;
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailPart & { headers?: Array<{ name: string; value: string }> };
}

function findHtml(part: GmailPart | undefined): string | undefined {
  if (!part) return undefined;
  if (part.mimeType === 'text/html' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
  for (const child of part.parts ?? []) {
    const html = findHtml(child);
    if (html) return html;
  }
  return undefined;
}

function senderAddress(message: GmailMessage): string | undefined {
  const from = message.payload?.headers?.find((h) => h.name.toLowerCase() === 'from')?.value ?? '';
  return /<([^>]+)>/.exec(from)?.[1]?.toLowerCase() ?? from.trim().toLowerCase();
}

const SENDER_QUERY = `from:(${linkedinAlertSenders.join(' OR ')})`;

async function newMessageIds(token: string, historyId: string | undefined): Promise<{ ids: string[]; historyId: string }> {
  if (historyId) {
    try {
      const ids = new Set<string>();
      let pageToken: string | undefined;
      let latest = historyId;
      do {
        const params = new URLSearchParams({ startHistoryId: historyId, historyTypes: 'messageAdded', maxResults: '100' });
        if (pageToken) params.set('pageToken', pageToken);
        const page = await gmail<{ history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>; historyId?: string; nextPageToken?: string }>(token, `/history?${params}`);
        for (const h of page.history ?? []) for (const m of h.messagesAdded ?? []) ids.add(m.message.id);
        latest = page.historyId ?? latest;
        pageToken = page.nextPageToken;
      } while (pageToken && ids.size < MAX_MESSAGES);
      return { ids: [...ids].slice(0, MAX_MESSAGES), historyId: latest };
    } catch (err) {
      // 404: the stored history ID is too old; fall back to a bounded recent search.
      if (!(err instanceof GmailError && err.status === 404)) throw err;
    }
  }
  const profile = await gmail<{ historyId: string }>(token, '/profile');
  const list = await gmail<{ messages?: Array<{ id: string }> }>(token, `/messages?${new URLSearchParams({ q: `${SENDER_QUERY} newer_than:7d`, maxResults: String(MAX_MESSAGES) })}`);
  return { ids: (list.messages ?? []).map((m) => m.id), historyId: profile.historyId };
}

async function handle(): Promise<RunSummary | undefined> {
  if (!policy.enabled) return undefined;
  const runId = randomUUID();
  const startedAt = Date.now();
  if (!(await acquireLock('source:linkedin-email', runId, startedAt))) return undefined;
  let run: RunSummary | undefined;
  try {
    const state = await getSourceState(policy.id);
    const bootstrapped = Boolean(state.bootstrappedAt);
    try {
      const token = await accessToken();
      const { ids, historyId } = await newMessageIds(token, state.cursor.historyId ? String(state.cursor.historyId) : undefined);
      const jobs: ExternalJob[] = [];
      let malformed = 0;
      for (const id of ids) {
        const message = await gmail<GmailMessage>(token, `/messages/${encodeURIComponent(id)}?format=full`);
        const sender = senderAddress(message);
        if (!sender || !linkedinAlertSenders.includes(sender)) continue;
        const html = findHtml(message.payload);
        if (!html) {
          malformed += 1;
          continue;
        }
        const receivedAt = new Date(Number(message.internalDate ?? startedAt)).toISOString();
        const parsed = parseLinkedInAlert(html, receivedAt);
        jobs.push(...parsed.jobs);
        malformed += parsed.malformed;
      }
      const settings = await getSettings();
      const sinceMs = windowStart(bootstrapped, state.watermark, startedAt);
      const stats = await processJobs(jobs, { policy, settings, bootstrapped, sinceMs, nowMs: startedAt });
      stats.malformed += malformed;
      const applied = applyOutcome(state.breaker, { type: 'OK' }, Date.now());
      run = { runId, startedAt: new Date(startedAt).toISOString(), status: 'SUCCESS', found: stats.found, kept: stats.kept, alerts: stats.alerts, digest: stats.digest, duplicates: stats.duplicates, malformed: stats.malformed, durationMs: Date.now() - startedAt };
      await saveSourceState(
        policy.id,
        {
          breaker: applied.state,
          success: true,
          changed: ids.length > 0,
          watermark: startedAt,
          bootstrappedAt: bootstrapped ? undefined : new Date(startedAt).toISOString(),
          cursor: { historyId },
          matched: ids.length > 0 ? stats.kept : undefined,
          run,
        },
        Date.now(),
      );
      if (!bootstrapped) {
        await putTextNotification(`bootstrap:${policy.id}`, `🔌 <b>${escapeHtml(policy.name)}</b> connected: ${stats.stored} matching job(s) from recent alert emails stored. Use /top.`, Date.now());
      }
      return run;
    } catch (err) {
      const status = err instanceof GmailError ? err.status : 0;
      const outcome: Outcome =
        status === 401 || status === 403 ? { type: 'AUTH', status }
        : status === 429 ? { type: 'RATE_LIMITED', retryAfterMs: undefined }
        : { type: 'TRANSIENT', status: status || undefined, detail: (err as Error).message };
      const applied = applyOutcome(state.breaker, outcome, Date.now());
      run = { runId, startedAt: new Date(startedAt).toISOString(), status: 'FAILED', found: 0, kept: 0, alerts: 0, digest: 0, duplicates: 0, malformed: 0, durationMs: Date.now() - startedAt, detail: outcome.type };
      await saveSourceState(policy.id, { breaker: applied.state, success: false, changed: false, run }, Date.now());
      if (applied.transition) await notifyBreakerTransition(policy.name, applied.transition, Date.now());
      logger.warn('gmail sync failed', { outcome: outcome.type, status });
      return run;
    }
  } finally {
    if (run) await recordRun(policy.id, run, Date.now()).catch(() => undefined);
    await releaseLock('source:linkedin-email', runId);
  }
}

/** §9: usage counters (HTTP, Telegram) are flushed once per invocation. */
export const handler = withUsage(handle);
