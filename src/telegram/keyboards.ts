import type { InlineKeyboard } from './bot';

/**
 * Compact callback payloads (§9, §11): `<action>:<jobId>` or `r:<reason>:<jobId>`.
 * Job IDs are 24 hex chars, so payloads stay far below Telegram's 64-byte limit.
 */
export type CallbackAction = 'save' | 'applied' | 'interview' | 'offer' | 'not-relevant' | 'reason' | 'hide-company' | 'cancel';

export const DISMISS_REASONS = {
  sn: 'too senior',
  ws: 'wrong stack',
  ne: 'not Egypt-eligible',
  lo: 'location',
  sa: 'salary',
  du: 'duplicate',
  ot: 'other',
} as const;
export type DismissReasonCode = keyof typeof DISMISS_REASONS;

const CODES: Record<string, CallbackAction> = {
  s: 'save',
  a: 'applied',
  i: 'interview',
  o: 'offer',
  n: 'not-relevant',
  r: 'reason',
  h: 'hide-company',
  x: 'cancel',
};
const ACTION_CODE = Object.fromEntries(Object.entries(CODES).map(([k, v]) => [v, k])) as Record<CallbackAction, string>;

export interface ParsedCallback {
  action: CallbackAction;
  jobId: string;
  reason?: DismissReasonCode;
}

const JOB_ID = /^[0-9a-f]{24}$/;

export function callbackData(action: Exclude<CallbackAction, 'reason'>, jobId: string): string {
  return `${ACTION_CODE[action]}:${jobId}`;
}

export function reasonData(reason: DismissReasonCode, jobId: string): string {
  return `r:${reason}:${jobId}`;
}

/** Strict parser: anything unexpected is rejected rather than guessed. */
export function parseCallbackData(data: string | undefined): ParsedCallback | undefined {
  if (!data || Buffer.byteLength(data) > 64) return undefined;
  const parts = data.split(':');
  const action = CODES[parts[0] ?? ''];
  if (!action) return undefined;
  if (action === 'reason') {
    const [, reason, jobId] = parts;
    if (parts.length !== 3 || !reason || !(reason in DISMISS_REASONS) || !jobId || !JOB_ID.test(jobId)) return undefined;
    return { action, jobId, reason: reason as DismissReasonCode };
  }
  const jobId = parts[1];
  if (parts.length !== 2 || !jobId || !JOB_ID.test(jobId)) return undefined;
  return { action, jobId };
}

function safeUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** §11 alert keyboard. */
export function alertKeyboard(jobId: string, applyUrl: string): InlineKeyboard {
  const apply = safeUrl(applyUrl);
  return {
    inline_keyboard: [
      [
        ...(apply ? [{ text: 'Apply ↗', url: apply }] : []),
        { text: '⭐ Save', callback_data: callbackData('save', jobId) },
        { text: '✅ Applied', callback_data: callbackData('applied', jobId) },
      ],
      [
        { text: '👎 Not relevant', callback_data: callbackData('not-relevant', jobId) },
        { text: '🚫 Hide company', callback_data: callbackData('hide-company', jobId) },
      ],
    ],
  };
}

export function reasonKeyboard(jobId: string): InlineKeyboard {
  const entries = Object.entries(DISMISS_REASONS) as Array<[DismissReasonCode, string]>;
  const rows: InlineKeyboard['inline_keyboard'] = [];
  for (let i = 0; i < entries.length; i += 2) {
    rows.push(entries.slice(i, i + 2).map(([code, label]) => ({ text: label, callback_data: reasonData(code, jobId) })));
  }
  rows.push([{ text: '↩ Cancel', callback_data: callbackData('cancel', jobId) }]);
  return { inline_keyboard: rows };
}

/** Keyboard after a status change: keep Apply plus the next sensible step. */
export function statusKeyboard(jobId: string, applyUrl: string, status: string): InlineKeyboard {
  const apply = safeUrl(applyUrl);
  const row: InlineKeyboard['inline_keyboard'][number] = apply ? [{ text: 'Apply ↗', url: apply }] : [];
  if (status === 'Saved') row.push({ text: '✅ Applied', callback_data: callbackData('applied', jobId) });
  if (status === 'Applied') row.push({ text: '🗣 Interview', callback_data: callbackData('interview', jobId) });
  if (status === 'Interview') row.push({ text: '🏆 Offer', callback_data: callbackData('offer', jobId) });
  return { inline_keyboard: row.length ? [row] : [] };
}

/** One row of compact actions per listed job (/top, /saved, /applied). */
export function listKeyboard(jobs: Array<{ jobId: string; userStatus: string }>): InlineKeyboard {
  return {
    inline_keyboard: jobs.map((job, i) => {
      const n = i + 1;
      switch (job.userStatus) {
        case 'New':
          return [
            { text: `⭐ ${n}`, callback_data: callbackData('save', job.jobId) },
            { text: `✅ ${n}`, callback_data: callbackData('applied', job.jobId) },
            { text: `👎 ${n}`, callback_data: callbackData('not-relevant', job.jobId) },
          ];
        case 'Saved':
          return [{ text: `✅ Applied ${n}`, callback_data: callbackData('applied', job.jobId) }];
        case 'Applied':
          return [{ text: `🗣 Interview ${n}`, callback_data: callbackData('interview', job.jobId) }];
        case 'Interview':
          return [{ text: `🏆 Offer ${n}`, callback_data: callbackData('offer', job.jobId) }];
        default:
          return [];
      }
    }).filter((row) => row.length > 0),
  };
}
