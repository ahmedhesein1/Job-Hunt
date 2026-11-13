/**
 * Live smoke test of the LinkedIn scraper from this machine: runs the first N saved
 * searches (default 3) against LinkedIn and prints each outcome and a sample of the jobs.
 * No AWS access: the domain gate is in memory and nothing is stored or sent.
 *
 *   npx esbuild scripts/linkedin-live.ts --bundle --platform=node --format=esm --packages=external --outfile=.tmp/linkedin-live.mjs
 *   node .tmp/linkedin-live.mjs 3
 */
import { linkedinSearches } from '../config/linkedin-searches';
import { DomainGate, InMemoryDomainGateStore } from '../src/scraping/domain-gate';
import { Fetcher } from '../src/scraping/fetcher';
import { linkedInWebSearchProvider } from '../src/sources/linkedin/linkedIn-adapter';
import { runSearchCycle, summarize } from '../src/sources/linkedin/orchestrator';

async function main(): Promise<void> {
  const count = Math.max(1, Math.min(linkedinSearches.length, Number(process.argv[2] ?? 3) || 3));
  const searches = linkedinSearches.slice(0, count);
  const provider = linkedInWebSearchProvider(new Fetcher(new DomainGate(new InMemoryDomainGateStore(), 'local-smoke')));

  const started = Date.now();
  const result = await runSearchCycle(searches, provider, { concurrency: 1, deadlineMs: started + 45_000, maxRetries: 2, backoffBaseMs: 1_000 });

  for (const o of result.outcomes) {
    console.log(`${o.status.padEnd(16)} ${String(o.found ?? '-').padStart(3)} jobs  ${o.ms} ms  ${o.id}${o.detail ? `  (${o.detail})` : ''}`);
  }
  console.log(`\n${JSON.stringify(summarize(result.outcomes))}  ${result.jobs.length} unique jobs, ${result.searched ?? 0} cards, ${Date.now() - started} ms\n`);
  for (const j of result.jobs.slice(0, 10)) {
    console.log(`- ${j.title} · ${j.company} · ${j.location ?? '?'} · ${j.publishedAt ?? '?'}\n  ${j.applyUrl}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
