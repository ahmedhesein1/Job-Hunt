/**
 * Live smoke test of the LinkedIn scraper from this machine: runs the first N saved
 * searches (default 3) against LinkedIn, fetches job pages for up to
 * `detailFetchesPerCycle` of the jobs found, and prints each outcome and a sample of the
 * jobs with what the pipeline makes of them. No AWS access: the domain gate and the seen
 * store are in memory and nothing is stored or sent (every job counts as new).
 *
 *   npx esbuild scripts/linkedin-live.ts --bundle --platform=node --format=esm --packages=external --outfile=.tmp/linkedin-live.mjs
 *   node .tmp/linkedin-live.mjs 3
 */
import { linkedinSearches } from '../config/linkedin-searches';
import { limits } from '../config/limits';
import { profiles } from '../config/profiles';
import { normalizeJob } from '../src/core/normalize';
import { evaluateAll } from '../src/core/scoring';
import { DomainGate, InMemoryDomainGateStore } from '../src/scraping/domain-gate';
import { Fetcher } from '../src/scraping/fetcher';
import { enrichWithJobDetails, linkedInWebSearchProvider } from '../src/sources/linkedin/linkedIn-adapter';
import { runSearchCycle, summarize } from '../src/sources/linkedin/orchestrator';

async function main(): Promise<void> {
  const count = Math.max(1, Math.min(linkedinSearches.length, Number(process.argv[2] ?? 3) || 3));
  const searches = linkedinSearches.slice(0, count);
  const fetcher = new Fetcher(new DomainGate(new InMemoryDomainGateStore(), 'local-smoke'));
  // An empty seen store: every job is new, so pagination reads up to the page cap.
  const known = new Set<string>();
  const provider = linkedInWebSearchProvider(fetcher, {
    seen: { unseen: async (urls) => urls.filter((u) => !known.has(u)), markSeen: async (urls) => urls.forEach((u) => known.add(u)) },
  });

  const started = Date.now();
  const result = await runSearchCycle(searches, provider, {
    concurrency: 1,
    deadlineMs: started + limits.linkedinSearch.deadlineMs,
    maxRetries: limits.linkedinSearch.maxRetries,
    backoffBaseMs: limits.linkedinSearch.backoffBaseMs,
  });
  for (const o of result.outcomes) {
    console.log(`${o.status.padEnd(16)} ${String(o.found ?? '-').padStart(3)} jobs  ${o.ms} ms  ${o.id}${o.detail ? `  (${o.detail})` : ''}`);
  }
  console.log(`\n${JSON.stringify(summarize(result.outcomes))}  ${result.jobs.length} unique jobs, ${result.searched ?? 0} cards, ${result.malformed ?? 0} unreadable, ${Date.now() - started} ms`);

  const enriched = await enrichWithJobDetails(fetcher, result.jobs, AbortSignal.timeout(limits.linkedinSearch.detailDeadlineMs - limits.linkedinSearch.deadlineMs));
  console.log(`descriptions: ${enriched.fetched} fetched, ${enriched.failed} failed${enriched.stoppedBy ? `, stopped: ${enriched.stoppedBy}` : ''}\n`);
  const primary = profiles[0]!;
  for (const j of enriched.jobs.filter((x) => x.description).concat(enriched.jobs.filter((x) => !x.description)).slice(0, 12)) {
    const n = normalizeJob(j, primary, Date.now());
    const e = evaluateAll(n, profiles, { mutedCompanies: new Set<string>() });
    const verdict = e.decision === 'REJECT' ? `REJECT (${e.reasons.join('; ')})` : `MATCH ${e.score}/${e.confidence}`;
    console.log(`- ${j.title} · ${j.company} · ${j.location ?? '?'}\n  ${n.hasDescription ? `description, skills: ${n.skills.join(', ') || 'none'}` : 'card only'} → ${verdict}\n  ${j.applyUrl}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
