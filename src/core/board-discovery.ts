import { limits } from '../../config/limits';
import { addBoard } from '../data/boards';
import { logger } from '../lib/logger';
import { MINUTE_MS } from '../lib/time';
import { boardApiHost } from '../sources/ats/common';
import type { AtsPosting } from './url';

const MAX_NEW_BOARDS_PER_RUN = 10;

/**
 * §4.1 steps 4–5: newly discovered boards enter a low-frequency queue. Validation happens
 * on the first scheduled check against the provider's documented endpoint (a 404 marks
 * the board unavailable). First checks are staggered across the next hour.
 */
export async function addDiscoveredBoards(candidates: AtsPosting[], addedFrom: string, nowMs: number): Promise<number> {
  const unique = new Map<string, AtsPosting>();
  for (const c of candidates) unique.set(`${c.ats}#${c.token.toLowerCase()}`, c);
  let added = 0;
  for (const candidate of [...unique.values()].slice(0, MAX_NEW_BOARDS_PER_RUN)) {
    const ref = { ats: candidate.ats, token: candidate.token, region: candidate.region };
    const result = await addBoard({
      ref,
      hostname: boardApiHost(ref),
      addedFrom,
      priority: 'low',
      intervalMinutes: limits.boards.discoveredIntervalMinutes,
      firstCheckAtMs: nowMs + Math.floor(Math.random() * 60) * MINUTE_MS,
    });
    if (result === 'added') added += 1;
    if (result === 'cap-reached') {
      logger.info('active board cap reached; discovery paused', { cap: limits.boards.maxActiveBoards });
      break;
    }
  }
  return added;
}
