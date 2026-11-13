import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimUpdate: vi.fn(),
  reserveSendSlot: vi.fn(),
  sendMessage: vi.fn(),
  answerCallback: vi.fn(),
  editReplyMarkup: vi.fn(),
  handleCommand: vi.fn(),
  handleCallback: vi.fn(),
  handleSnapshotDocument: vi.fn(),
}));

vi.mock('../../../src/lib/secrets', () => ({
  getSecretFromEnv: vi.fn(async () => 'correct-secret'),
  telegramChatId: () => '123456789',
}));
vi.mock('../../../src/data/telegram-updates', () => ({ claimUpdate: mocks.claimUpdate, reserveSendSlot: mocks.reserveSendSlot }));
vi.mock('../../../src/telegram/bot', async (orig) => ({
  ...(await orig<typeof import('../../../src/telegram/bot')>()),
  sendMessage: mocks.sendMessage,
  answerCallback: mocks.answerCallback,
  editReplyMarkup: mocks.editReplyMarkup,
}));
vi.mock('../../../src/telegram/commands', () => ({ handleCommand: mocks.handleCommand, handleCallback: mocks.handleCallback }));
vi.mock('../../../src/telegram/linkedin', () => ({ handleSnapshotDocument: mocks.handleSnapshotDocument }));

const { handler } = await import('../../../src/handlers/telegram-webhook');

function event(body: unknown, secret = 'correct-secret', method = 'POST'): LambdaFunctionURLEvent {
  return {
    headers: { 'x-telegram-bot-api-secret-token': secret },
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { method } },
  } as unknown as LambdaFunctionURLEvent;
}

const privateMessage = (text: string, chatId = 123456789, updateId = 1) => ({
  update_id: updateId,
  message: { message_id: 10, text, chat: { id: chatId, type: 'private' }, from: { id: chatId } },
});

describe('telegram webhook (§11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimUpdate.mockResolvedValue(true);
    mocks.reserveSendSlot.mockResolvedValue({ ok: true });
    mocks.handleCommand.mockResolvedValue({ text: 'reply' });
  });

  it('rejects an invalid secret header', async () => {
    const res = await handler(event(privateMessage('/status'), 'wrong'));
    expect(res.statusCode).toBe(401);
    expect(mocks.handleCommand).not.toHaveBeenCalled();
  });

  it('rejects non-POST requests', async () => {
    expect((await handler(event({}, 'correct-secret', 'GET'))).statusCode).toBe(405);
  });

  it('ignores other chats without revealing anything', async () => {
    const res = await handler(event(privateMessage('/top', 999)));
    expect(res).toEqual({ statusCode: 200, body: '' });
    expect(mocks.claimUpdate).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it('ignores group chats even with the right id', async () => {
    await handler(event({ update_id: 3, message: { message_id: 1, text: '/top', chat: { id: 123456789, type: 'group' }, from: { id: 123456789 } } }));
    expect(mocks.handleCommand).not.toHaveBeenCalled();
  });

  it('routes an uploaded document to the LinkedIn snapshot importer and replies', async () => {
    mocks.handleSnapshotDocument.mockResolvedValue('📥 imported');
    const doc = { file_id: 'abc', file_name: 'search.html', mime_type: 'text/html', file_size: 1000 };
    await handler(event({ update_id: 9, message: { message_id: 11, date: 1_700_000_000, document: doc, chat: { id: 123456789, type: 'private' }, from: { id: 123456789 } } }));
    expect(mocks.handleSnapshotDocument).toHaveBeenCalledWith(doc, 1_700_000_000_000, expect.any(Number));
    expect(mocks.sendMessage).toHaveBeenCalledWith('123456789', '📥 imported', undefined);
    expect(mocks.handleCommand).not.toHaveBeenCalled();
  });

  it('ignores documents from other chats', async () => {
    await handler(event({ update_id: 10, message: { message_id: 1, document: { file_id: 'x' }, chat: { id: 999, type: 'private' }, from: { id: 999 } } }));
    expect(mocks.handleSnapshotDocument).not.toHaveBeenCalled();
  });

  it('handles a duplicate update id once', async () => {
    mocks.claimUpdate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await handler(event(privateMessage('/status')));
    await handler(event(privateMessage('/status')));
    expect(mocks.handleCommand).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('claims the update before side effects', async () => {
    await handler(event(privateMessage('/pause')));
    expect(mocks.claimUpdate.mock.invocationCallOrder[0]).toBeLessThan(mocks.handleCommand.mock.invocationCallOrder[0]!);
  });

  it('routes valid callbacks and edits the keyboard', async () => {
    mocks.handleCallback.mockResolvedValue({ toast: 'Saved', markup: { inline_keyboard: [] } });
    await handler(
      event({
        update_id: 7,
        callback_query: { id: 'cb1', data: 's:a1b2c3d4e5f6a1b2c3d4e5f6', from: { id: 123456789 }, message: { message_id: 55, chat: { id: 123456789, type: 'private' } } },
      }),
    );
    expect(mocks.handleCallback).toHaveBeenCalledWith({ action: 'save', jobId: 'a1b2c3d4e5f6a1b2c3d4e5f6' });
    expect(mocks.answerCallback).toHaveBeenCalledWith('cb1', 'Saved');
    expect(mocks.editReplyMarkup).toHaveBeenCalledWith('123456789', 55, { inline_keyboard: [] });
  });

  it('rejects forged callback data', async () => {
    await handler(
      event({ update_id: 8, callback_query: { id: 'cb2', data: 's:../../etc', from: { id: 123456789 }, message: { message_id: 1, chat: { id: 123456789, type: 'private' } } } }),
    );
    expect(mocks.handleCallback).not.toHaveBeenCalled();
    expect(mocks.answerCallback).toHaveBeenCalledWith('cb2', 'Unsupported action');
  });

  it('reserves the shared send slot before replying', async () => {
    mocks.reserveSendSlot.mockResolvedValueOnce({ ok: false, waitMs: 5 }).mockResolvedValueOnce({ ok: true });
    await handler(event(privateMessage('/help')));
    expect(mocks.reserveSendSlot).toHaveBeenCalledTimes(2);
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
  });
});
