import { describe, expect, it } from 'vitest';
import type { JobItem } from '../../../src/data/jobs';
import { escapeHtml, formatJobAlert, formatJobList } from '../../../src/notifications/formatting';
import { alertKeyboard, listKeyboard, parseCallbackData, reasonKeyboard } from '../../../src/telegram/keyboards';

const JOB_ID = 'a1b2c3d4e5f6a1b2c3d4e5f6';

function jobItem(overrides: Partial<JobItem> = {}): JobItem {
  return {
    jobId: JOB_ID,
    sourceId: 'himalayas',
    sourceJobId: 'x',
    sources: new Set(['himalayas']),
    title: 'Backend <Engineer> & "Node"',
    company: 'Acme & Co',
    companyKey: 'acme',
    remoteScope: 'Remote (EMEA)',
    eligibility: 'ELIGIBLE',
    eligibleRegions: ['EMEA'],
    skills: ['node', 'typescript', 'postgresql'],
    applyUrl: 'https://himalayas.app/companies/acme/jobs/backend?utm_source=api',
    sourceUrl: 'https://himalayas.app/companies/acme/jobs/backend',
    publishedAtReliable: true,
    discoveredAt: '2026-11-10T08:00:00.000Z',
    score: 86,
    confidence: 1,
    matchedProfiles: ['backend-node'],
    clusterId: JOB_ID,
    userStatus: 'New',
    via: 'Himalayas',
    delivery: 'INSTANT',
    salary: { min: 30000, max: 42000, currency: 'USD', period: 'year', monthlyMin: 2500, monthlyMax: 3500, usdMonthlyMin: 2500, usdMonthlyMax: 3500, origin: 'employer' },
    ...overrides,
  };
}

describe('callback data (§9, §11)', () => {
  it('every button payload fits in 64 bytes and round-trips', () => {
    const keyboards = [alertKeyboard(JOB_ID, 'https://x.example/'), reasonKeyboard(JOB_ID), listKeyboard([{ jobId: JOB_ID, userStatus: 'New' }])];
    for (const kb of keyboards) {
      for (const button of kb.inline_keyboard.flat()) {
        if (!button.callback_data) continue;
        expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
        expect(parseCallbackData(button.callback_data)?.jobId).toBe(JOB_ID);
      }
    }
  });

  it('rejects malformed or forged payloads', () => {
    for (const bad of [undefined, '', 's:', 's:xyz', `q:${JOB_ID}`, `r:zz:${JOB_ID}`, `s:${JOB_ID}:extra`, `s:${'A'.repeat(24)}`, `s:${JOB_ID}${'x'.repeat(60)}`]) {
      expect(parseCallbackData(bad)).toBeUndefined();
    }
    expect(parseCallbackData(`r:sn:${JOB_ID}`)).toEqual({ action: 'reason', jobId: JOB_ID, reason: 'sn' });
  });

  it('omits the Apply button for non-http URLs', () => {
    const kb = alertKeyboard(JOB_ID, 'javascript:alert(1)');
    expect(kb.inline_keyboard.flat().some((b) => b.url)).toBe(false);
  });
});

describe('formatting (§11)', () => {
  it('escapes every source-provided string', () => {
    expect(escapeHtml('<b>&"')).toBe('&lt;b&gt;&amp;&quot;');
    const text = formatJobAlert(jobItem(), Date.parse('2026-11-10T10:00:00Z'));
    expect(text).toContain('Backend &lt;Engineer&gt; &amp; &quot;Node&quot;');
    expect(text).toContain('Acme &amp; Co');
    expect(text).toContain('🎯 <b>');
    expect(text).toContain('first seen 2 h ago');
    expect(text).toContain('2,500–3,500 USD / month (source: employer)');
    expect(text).toContain('via <a href="https://himalayas.app/companies/acme/jobs/backend">Himalayas</a>');
  });

  it('never cuts a message inside a line (keeps HTML balanced)', () => {
    const jobs = Array.from({ length: 200 }, (_, i) => jobItem({ jobId: String(i).padStart(24, '0') }));
    const { text, included } = formatJobList('Top', jobs);
    expect(text.length).toBeLessThanOrEqual(3900 + 40);
    expect(included).toBeLessThan(200);
    expect((text.match(/<a /g) ?? []).length).toBe((text.match(/<\/a>/g) ?? []).length);
  });
});
