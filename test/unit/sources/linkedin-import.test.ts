import { describe, expect, it, vi } from 'vitest';
import { sources } from '../../../config/sources';
import { processJobs } from '../../../src/core/pipeline';
import type { JobItem } from '../../../src/data/jobs';
import { defaultSettings } from '../../../src/data/settings';
import { toSourceState } from '../../../src/data/sources';
import { formatJobAlert } from '../../../src/notifications/formatting';
import { cardToExternalJob, importLinkedInSnapshot, type ImportDeps } from '../../../src/sources/linkedin/snapshot-import';
import { downloadFile, setTelegramFetch, TelegramError } from '../../../src/telegram/bot';
import { documentProblem, formatSnapshotReply, handleSnapshotDocument, linkedinSearchesReply } from '../../../src/telegram/linkedin';
import { linkedinSearches } from '../../../config/linkedin-searches';
import { FakeStore } from '../../helpers/fake-store';
import { fixtureText } from '../../helpers/fixtures';

vi.mock('../../../src/lib/secrets', async (orig) => ({
  ...(await orig<typeof import('../../../src/lib/secrets')>()),
  telegramBotToken: async () => 'SECRET-BOT-TOKEN',
}));

// 12:00 Cairo on a weekday: outside quiet hours.
const CAPTURED = Date.parse('2026-11-11T10:00:00Z');
const NOW = CAPTURED + 60_000;

function deps(store: FakeStore) {
  const saveSourceState = vi.fn(async () => undefined);
  const recordRun = vi.fn(async () => undefined);
  const d: ImportDeps = {
    processJobs: (jobs, ctx) => processJobs(jobs, ctx, store),
    getSettings: async () => defaultSettings(),
    getSourceState: async (id) => toSourceState(id, undefined),
    saveSourceState,
    recordRun,
  };
  return { d, saveSourceState, recordRun };
}

async function importFixture(name: string, store = new FakeStore()) {
  const { d, saveSourceState, recordRun } = deps(store);
  const result = await importLinkedInSnapshot(fixtureText(name), CAPTURED, NOW, d);
  return { result, store, saveSourceState, recordRun };
}

describe('LinkedIn snapshot import → relevance → dedupe → notifications', () => {
  it('scores every card with an explanation and alerts only relevant, fresh jobs', async () => {
    const { result, store } = await importFixture('linkedin-search-logged-out.html');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const byTitle = Object.fromEntries(result.outcomes.map((o) => [o.title, o]));

    expect(byTitle['Backend Engineer (Node.js)']).toMatchObject({ result: 'stored', delivery: 'INSTANT', score: 100, confidence: 0.5 });
    expect(byTitle['Backend Engineer (Node.js)']?.explanation).toBe('title 30/30 · skills ? · location 20/20 · experience ?');
    expect(byTitle['مطور باك اند Node.js']).toMatchObject({ result: 'stored', delivery: 'INSTANT' });
    expect(byTitle['Frontend Developer (React)']).toMatchObject({ result: 'rejected', explanation: 'title excludes: frontend; title not backend/node' });
    // Relevant but a week old: stored for /top, not alerted (72 h freshness rule).
    expect(byTitle['Senior Backend Engineer']).toMatchObject({ result: 'stored', delivery: 'NONE' });

    expect(result.stats).toMatchObject({ found: 4, stored: 3, alerts: 2, rejected: 1, malformed: 2 });
    // Notification pipeline: exactly one outbox item per instant alert.
    expect(store.outbox.size).toBe(2);
  });

  it('never re-alerts a job from a second upload of the same or an overlapping page', async () => {
    const store = new FakeStore();
    await importFixture('linkedin-search-logged-out.html', store);
    const again = await importFixture('linkedin-search-logged-out.html', store);
    expect(again.result.status === 'ok' && again.result.stats).toMatchObject({ stored: 0, alerts: 0, duplicates: 3 });
    expect(store.outbox.size).toBe(2);
  });

  it('treats a job already known from LinkedIn alert emails as a duplicate (same canonical URL)', async () => {
    const store = new FakeStore();
    const fromEmail = { ...cardToExternalJob({ jobId: '4012345678', url: 'https://www.linkedin.com/jobs/view/4012345678/', title: 'Backend Engineer (Node.js)', company: 'Acme', location: 'Cairo, Egypt', postedAtPrecise: false }), sourceId: 'linkedin-email' as const };
    await processJobs([fromEmail], { policy: sources['linkedin-email'], settings: defaultSettings(), bootstrapped: true, sinceMs: 0, nowMs: NOW }, store);
    const { result } = await importFixture('linkedin-search-logged-out.html', store);
    expect(result.status === 'ok' && result.outcomes.find((o) => o.sourceJobId === '4012345678')).toMatchObject({ result: 'duplicate' });
  });

  it('falls back to company + title + location when IDs differ (reposted job)', async () => {
    const store = new FakeStore();
    await importFixture('linkedin-search-logged-out.html', store);
    const reposted = fixtureText('linkedin-search-logged-out.html').replaceAll('4012345678', '4019999999');
    const { d } = deps(store);
    const result = await importLinkedInSnapshot(reposted, CAPTURED, NOW, d);
    expect(result.status === 'ok' && result.outcomes.find((o) => o.sourceJobId === '4019999999')).toMatchObject({ result: 'duplicate' });
  });

  it('records a sign-in wall as a failed run and imports nothing', async () => {
    const store = new FakeStore();
    const { d, saveSourceState, recordRun } = deps(store);
    const process = vi.spyOn(d, 'processJobs');
    const result = await importLinkedInSnapshot(fixtureText('linkedin-authwall.html'), CAPTURED, NOW, d);
    expect(result).toEqual({ status: 'blocked', reason: 'sign-in page' });
    expect(process).not.toHaveBeenCalled();
    expect(saveSourceState).toHaveBeenCalledWith('linkedin-snapshot', expect.objectContaining({ success: false, run: expect.objectContaining({ status: 'FAILED', detail: 'blocked: sign-in page' }) }), expect.any(Number));
    expect(recordRun).toHaveBeenCalledOnce();
  });

  it('records a successful run with layout and counts', async () => {
    const { saveSourceState } = await importFixture('linkedin-search-signed-in.html');
    expect(saveSourceState).toHaveBeenCalledWith(
      'linkedin-snapshot',
      expect.objectContaining({ success: true, run: expect.objectContaining({ status: 'SUCCESS', detail: 'signed-in layout, 2 card(s), 1 unrendered' }) }),
      expect.any(Number),
    );
  });
});

describe('LinkedIn in Telegram', () => {
  it('/linkedin lists every saved search as a browser link, newest group first', () => {
    const reply = linkedinSearchesReply();
    const buttons = reply.markup?.inline_keyboard.flat() ?? [];
    expect(buttons.length).toBe(linkedinSearches.length);
    for (const b of buttons) expect(b.url).toMatch(/^https:\/\/www\.linkedin\.com\/jobs\/search\?keywords=/);
    expect(buttons[0]?.text.startsWith('⚡')).toBe(true);
    expect(reply.text).toContain('.html');
  });

  it('/linkedin <group> filters, and unknown groups get usage help', () => {
    const egypt = linkedinSearchesReply('Egypt').markup?.inline_keyboard.flat() ?? [];
    expect(egypt.length).toBe(linkedinSearches.filter((s) => s.group === 'egypt').length);
    for (const b of egypt) expect(new URL(b.url!).searchParams.get('geoId')).toBe('106155005');
    const unknown = linkedinSearchesReply('mars');
    expect(unknown.markup).toBeUndefined();
    expect(unknown.text).toContain('/linkedin remote');
  });

  it('accepts only .html documents within the size cap', () => {
    expect(documentProblem({ file_id: 'f', file_name: 'search.html', file_size: 900_000 })).toBeUndefined();
    expect(documentProblem({ file_id: 'f', file_name: 'page.htm' })).toBeUndefined();
    expect(documentProblem({ file_id: 'f', file_name: 'blob', mime_type: 'text/html' })).toBeUndefined();
    expect(documentProblem({ file_id: 'f', file_name: 'cv.pdf', mime_type: 'application/pdf' })).toMatch(/Only saved LinkedIn/);
    expect(documentProblem({ file_id: 'f', file_name: 'big.html', file_size: 50 * 1024 * 1024 })).toMatch(/larger than/);
  });

  it('replies with each match, its score, delivery and reason (HTML-escaped)', async () => {
    const { result } = await importFixture('linkedin-search-logged-out.html');
    const text = formatSnapshotReply(result);
    expect(text).toContain('📥 <b>LinkedIn page</b>: 4 job card(s), logged-out layout');
    expect(text).toContain('🔔 2 alert(s)');
    expect(text).toContain('<b>Backend Engineer (Node.js)</b> — Acme · 100% (alert)');
    expect(text).toContain('Smith &amp; Sons');
    expect(text).toContain('stored: posted too long ago to alert');
    expect(text).toContain('Frontend Developer (React) — Pixel Studio: <i>title excludes: frontend; title not backend/node</i>');
  });

  it('tells the owner about unrendered cards and blocked pages', async () => {
    expect(formatSnapshotReply((await importFixture('linkedin-search-signed-in.html')).result)).toContain('1 card(s) had not loaded');
    expect(formatSnapshotReply({ status: 'blocked', reason: 'sign-in page' })).toContain('Nothing was imported');
  });

  it('handles an uploaded document end to end', async () => {
    const store = new FakeStore();
    const { d } = deps(store);
    const reply = await handleSnapshotDocument({ file_id: 'abc', file_name: 'search.html' }, CAPTURED, NOW, {
      downloadFile: async () => new TextEncoder().encode(fixtureText('linkedin-search-logged-out.html')),
      importLinkedInSnapshot: (html, captured, now) => importLinkedInSnapshot(html, captured, now, d),
    });
    expect(reply).toContain('🔔 2 alert(s)');
    expect(store.outbox.size).toBe(2);
  });

  it('turns download failures into a reply instead of an error', async () => {
    const fail = (code: number) => ({
      downloadFile: async () => {
        throw new TelegramError(code, 'x', undefined);
      },
      importLinkedInSnapshot: vi.fn(),
    });
    expect(await handleSnapshotDocument({ file_id: 'a', file_name: 'a.html' }, CAPTURED, NOW, fail(413))).toMatch(/larger than/);
    expect(await handleSnapshotDocument({ file_id: 'a', file_name: 'a.html' }, CAPTURED, NOW, fail(0))).toMatch(/Could not download/);
  });
});

describe('Telegram file download', () => {
  function telegramFetch(fileSize: number | undefined, body: Uint8Array) {
    const calls: string[] = [];
    setTelegramFetch(async (url) => {
      calls.push(url);
      if (url.endsWith('/getFile')) return new Response(JSON.stringify({ ok: true, result: { file_path: 'documents/file_1.html', file_size: fileSize } }));
      return new Response(body);
    });
    return calls;
  }

  it('downloads the file from Telegram only', async () => {
    const calls = telegramFetch(5, new TextEncoder().encode('<html>'));
    const bytes = await downloadFile('abc', 1024);
    expect(new TextDecoder().decode(bytes)).toBe('<html>');
    expect(calls.every((u) => u.startsWith('https://api.telegram.org/'))).toBe(true);
  });

  it('enforces the size cap on the declared and streamed size without leaking the token', async () => {
    telegramFetch(10_000, new Uint8Array(10));
    await expect(downloadFile('abc', 1024)).rejects.toMatchObject({ errorCode: 413 });
    telegramFetch(undefined, new Uint8Array(4096));
    const err = (await downloadFile('abc', 1024).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.message).not.toContain('SECRET-BOT-TOKEN');
  });
});

describe('alert format for LinkedIn jobs', () => {
  it('shows title, company, location, posting age, score and the original URL', () => {
    const job = {
      jobId: 'j1',
      sourceId: 'linkedin-snapshot',
      title: 'Backend Engineer (Node.js)',
      company: 'Acme',
      remoteScope: 'Cairo, Egypt',
      skills: [],
      score: 100,
      confidence: 0.5,
      publishedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
      publishedAtReliable: true,
      discoveredAt: new Date(NOW - 60_000).toISOString(),
      applyUrl: 'https://www.linkedin.com/jobs/view/4012345678/',
      sourceUrl: 'https://www.linkedin.com/jobs/view/4012345678/',
      via: 'LinkedIn (saved page)',
    } as unknown as JobItem;
    const text = formatJobAlert(job, NOW);
    expect(text).toContain('<b>Backend Engineer (Node.js)</b> — 100%');
    expect(text).toContain('🏢 Acme · 🌍 Cairo, Egypt · 🕒 posted 3 h ago · first seen 1 min ago');
    expect(text).toContain('<a href="https://www.linkedin.com/jobs/view/4012345678/">LinkedIn (saved page)</a>');
    expect(formatJobAlert({ ...job, publishedAtReliable: false }, NOW)).toContain('posted ~3 h ago');
  });
});
