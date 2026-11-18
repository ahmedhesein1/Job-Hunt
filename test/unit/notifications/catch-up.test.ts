import { describe, expect, it } from 'vitest';
import { limits } from '../../../config/limits';
import type { JobItem } from '../../../src/data/jobs';
import { catchUpJobs, catchUpMessages } from '../../../src/notifications/catch-up';
import { MAX_MESSAGE_CHARS } from '../../../src/notifications/formatting';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const DAY = 86_400_000;

function job(id: string, over: Partial<JobItem> = {}): JobItem {
  return {
    jobId: id.padStart(24, '0'),
    sourceId: 'company-boards',
    sourceJobId: id,
    sources: new Set(['company-boards']),
    title: `Backend Engineer ${id}`,
    company: 'Acme',
    companyKey: 'acme',
    remoteScope: 'Cairo, Egypt',
    eligibility: 'ELIGIBLE',
    eligibleRegions: ['EG'],
    skills: ['node.js'],
    applyUrl: `https://jobs.lever.co/acme/${id}`,
    sourceUrl: `https://jobs.lever.co/acme/${id}`,
    publishedAtReliable: true,
    discoveredAt: new Date(NOW - DAY).toISOString(),
    score: 80,
    confidence: 0.9,
    matchedProfiles: ['node-backend'],
    clusterId: id,
    userStatus: 'New',
    delivery: 'INSTANT',
    ...over,
  };
}

describe("a new friend's catch-up (/friends add)", () => {
  const settings = { mutedCompanies: new Set(['muted']) };

  it('recent alert-worthy jobs, best first; old, weak, low-confidence and muted ones left out', () => {
    const jobs = [
      job('a', { score: 70 }),
      job('b', { score: 95, userStatus: 'Applied' }),
      job('old', { discoveredAt: new Date(NOW - (limits.notifications.friendCatchUpDays + 1) * DAY).toISOString() }),
      job('weak', { score: limits.notifications.digestMinScore - 1 }),
      job('unsure', { confidence: limits.notifications.minConfidence - 0.1 }),
      job('m', { companyKey: 'muted' }),
      job('a', { score: 70 }), // the same job from two status queries
    ];
    expect(catchUpJobs(jobs, settings, NOW).map((j) => j.sourceJobId)).toEqual(['b', 'a']);
  });

  it('caps the list at friendCatchUpMaxJobs', () => {
    const many = Array.from({ length: 50 }, (_, i) => job(`j${i}`, { score: 60 + (i % 40) }));
    expect(catchUpJobs(many, settings, NOW)).toHaveLength(limits.notifications.friendCatchUpMaxJobs);
  });

  it('splits into Telegram-sized messages, numbering across them and never cutting a line', () => {
    const jobs = Array.from({ length: 30 }, (_, i) => job(`j${i}`, { title: `Senior Backend Engineer, Payments Platform ${'x'.repeat(80)} ${i}` }));
    const messages = catchUpMessages(jobs);
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expect(m.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(messages[0]).toContain(`(1/${messages.length})`);
    expect(messages.join('\n').match(/^\d+\. /gm)).toHaveLength(30);
    expect(messages.at(-1)).toContain('30. ');
  });
});
