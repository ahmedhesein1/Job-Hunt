import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramError } from '../../../src/telegram/bot';

const m = vi.hoisted(() => ({
  getNotification: vi.fn(),
  markFailed: vi.fn(),
  markSent: vi.fn(),
  recordAttempt: vi.fn(),
  putSharedCopies: vi.fn(),
  getJob: vi.fn(),
  setJobNotified: vi.fn(),
  getSettings: vi.fn(),
  reserveSendSlot: vi.fn(),
  deferSendSlot: vi.fn(),
  recordSuccessfulSend: vi.fn(),
  sendMessage: vi.fn(),
  delayMessage: vi.fn(),
}));

vi.mock('../../../src/data/outbox', () => ({ getNotification: m.getNotification, markFailed: m.markFailed, markSent: m.markSent, recordAttempt: m.recordAttempt, putSharedCopies: m.putSharedCopies }));
vi.mock('../../../src/data/jobs', () => ({ getJob: m.getJob, setJobNotified: m.setJobNotified }));
vi.mock('../../../src/data/settings', () => ({ getSettings: m.getSettings }));
vi.mock('../../../src/data/telegram-updates', () => ({ reserveSendSlot: m.reserveSendSlot, deferSendSlot: m.deferSendSlot, recordSuccessfulSend: m.recordSuccessfulSend }));
vi.mock('../../../src/notifications/queue', () => ({ delayMessage: m.delayMessage }));
vi.mock('../../../src/lib/secrets', () => ({ telegramChatId: () => '123456789' }));
vi.mock('../../../src/telegram/bot', async (orig) => ({ ...(await orig<typeof import('../../../src/telegram/bot')>()), sendMessage: m.sendMessage }));

const { deliverNotification } = await import('../../../src/notifications/sender');

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = 1_800_000_000_000;

describe('Telegram sender (§10.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.getNotification.mockResolvedValue({ notificationId: ID, kind: 'TEXT', status: 'QUEUED', text: 'hello', createdAt: '' });
    m.reserveSendSlot.mockResolvedValue({ ok: true });
    m.sendMessage.mockResolvedValue(42);
    m.getSettings.mockResolvedValue({ mutedCompanies: new Set(), shareChatIds: new Set() });
    m.putSharedCopies.mockResolvedValue(0);
  });

  it('sends and marks SENT with the Telegram message id', async () => {
    const out = await deliverNotification(ID, 'rh', () => NOW);
    expect(out.kind).toBe('done');
    expect(m.markSent).toHaveBeenCalledWith(ID, 42, NOW);
    expect(m.recordSuccessfulSend).toHaveBeenCalled();
  });

  it('acknowledges duplicates after SENT without sending (must-pass 9)', async () => {
    m.getNotification.mockResolvedValue({ notificationId: ID, kind: 'TEXT', status: 'SENT' });
    expect((await deliverNotification(ID, 'rh', () => NOW)).kind).toBe('done');
    expect(m.sendMessage).not.toHaveBeenCalled();
  });

  it('defers via SQS visibility when the 1.1 s slot is busy (must-pass 10)', async () => {
    m.reserveSendSlot.mockResolvedValue({ ok: false, waitMs: 700 });
    const out = await deliverNotification(ID, 'rh', () => NOW);
    expect(out).toMatchObject({ kind: 'retry', delayMs: 700 });
    expect(m.delayMessage).toHaveBeenCalledWith('rh', 700);
    expect(m.sendMessage).not.toHaveBeenCalled();
  });

  it('honours Telegram retry_after on 429 (must-pass 11)', async () => {
    m.sendMessage.mockRejectedValue(new TelegramError(429, 'Too Many Requests', 17));
    const out = await deliverNotification(ID, 'rh', () => NOW);
    expect(out).toMatchObject({ kind: 'retry', delayMs: 17_000 });
    expect(m.deferSendSlot).toHaveBeenCalledWith('123456789', NOW + 17_000);
    expect(m.delayMessage).toHaveBeenCalledWith('rh', 17_000);
    expect(m.markFailed).not.toHaveBeenCalled();
  });

  it.each([400, 403])('marks permanent Telegram %s errors FAILED without retrying (must-pass 12)', async (code) => {
    m.sendMessage.mockRejectedValue(new TelegramError(code, 'Forbidden: bot was blocked by the user', undefined));
    const out = await deliverNotification(ID, 'rh', () => NOW);
    expect(out.kind).toBe('done');
    expect(m.markFailed).toHaveBeenCalledWith(ID, expect.stringContaining(String(code)));
  });

  it('retries temporary failures through SQS', async () => {
    m.sendMessage.mockRejectedValue(new TelegramError(502, 'Bad Gateway', undefined));
    expect((await deliverNotification(ID, 'rh', () => NOW)).kind).toBe('retry');
    expect(m.recordAttempt).toHaveBeenCalled();
  });

  it('skips job alerts for muted companies or jobs already acted on', async () => {
    m.getNotification.mockResolvedValue({ notificationId: ID, kind: 'JOB', status: 'QUEUED', jobId: 'j1' });
    m.getJob.mockResolvedValue({ jobId: 'j1', companyKey: 'acme', userStatus: 'New' });
    m.getSettings.mockResolvedValue({ mutedCompanies: new Set(['acme']) });
    await deliverNotification(ID, 'rh', () => NOW);
    expect(m.sendMessage).not.toHaveBeenCalled();
    expect(m.markFailed).toHaveBeenCalledWith(ID, 'skipped: company muted');
  });

  describe('friends (/friends)', () => {
    const job = { jobId: 'j1', companyKey: 'acme', userStatus: 'New', title: 'Backend Engineer', company: 'Acme', applyUrl: 'https://jobs.lever.co/acme/1', score: 90, discoveredAt: '', skills: [], remoteScope: 'Cairo, Egypt' };
    const keyboardOf = () => m.sendMessage.mock.calls[0]![2] as { inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>> };

    it("copies the owner's job alert for each friend before sending it, never to the owner again", async () => {
      const alert = { notificationId: ID, kind: 'JOB', status: 'QUEUED', jobId: 'j1', shareable: true };
      m.getNotification.mockResolvedValue(alert);
      m.getJob.mockResolvedValue(job);
      m.getSettings.mockResolvedValue({ mutedCompanies: new Set(), shareChatIds: new Set(['555', '123456789']) });
      await deliverNotification(ID, 'rh', () => NOW);
      expect(m.putSharedCopies).toHaveBeenCalledWith(alert, ['555'], NOW);
      expect(m.putSharedCopies.mock.invocationCallOrder[0]!).toBeLessThan(m.sendMessage.mock.invocationCallOrder[0]!);
      expect(m.sendMessage).toHaveBeenCalledWith('123456789', expect.any(String), expect.anything());
      expect(keyboardOf().inline_keyboard.flat().some((b) => b.callback_data)).toBe(true);
    });

    it('retries without sending when the copies cannot be stored', async () => {
      m.getNotification.mockResolvedValue({ notificationId: ID, kind: 'TEXT', status: 'QUEUED', text: 'digest', shareable: true });
      m.getSettings.mockResolvedValue({ mutedCompanies: new Set(), shareChatIds: new Set(['555']) });
      m.putSharedCopies.mockRejectedValue(new Error('throttled'));
      await expect(deliverNotification(ID, 'rh', () => NOW)).rejects.toThrow('throttled');
      expect(m.sendMessage).not.toHaveBeenCalled();
    });

    it('does not share system messages', async () => {
      m.getSettings.mockResolvedValue({ mutedCompanies: new Set(), shareChatIds: new Set(['555']) });
      await deliverNotification(ID, 'rh', () => NOW);
      expect(m.putSharedCopies).not.toHaveBeenCalled();
    });

    it("sends a friend's copy to the friend with an Apply link only, whatever the owner did with the job", async () => {
      m.getNotification.mockResolvedValue({ notificationId: ID, kind: 'JOB', status: 'QUEUED', jobId: 'j1', recipientChatId: '555', sharedFrom: 'b'.repeat(24) });
      m.getJob.mockResolvedValue({ ...job, userStatus: 'Applied' });
      const out = await deliverNotification(ID, 'rh', () => NOW);
      expect(out.kind).toBe('done');
      expect(m.sendMessage).toHaveBeenCalledWith('555', expect.any(String), expect.anything());
      expect(keyboardOf()).toEqual({ inline_keyboard: [[{ text: 'Apply ↗', url: 'https://jobs.lever.co/acme/1' }]] });
      expect(m.reserveSendSlot).toHaveBeenCalledWith('555', NOW);
      expect(m.setJobNotified).not.toHaveBeenCalled();
      expect(m.putSharedCopies).not.toHaveBeenCalled();
    });
  });
});
