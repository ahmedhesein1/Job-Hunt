import { linkedinSearches } from '../config/linkedin-searches';
import { runSearchCycle, summarize } from '../src/sources/linkedin/orchestrator';
import { autoRetrievalProvider } from '../src/sources/linkedin/provider';
import { formatJobAlert } from '../src/notifications/formatting';
import { normalizeJob } from '../src/core/normalize';
import { evaluateAll } from '../src/core/scoring';
import { profiles } from '../config/profiles';
import { buildJobItem, type JobItem } from '../src/data/jobs';

async function main() {
  console.log('================================================================');
  console.log('DEMONSTRATING REAL AUTOMATIC JOB RETRIEVAL & 39-SEARCH EXECUTION');
  console.log('================================================================\n');

  const nowMs = Date.now();
  const sinceMs = nowMs - 24 * 60 * 60 * 1000;

  console.log(`[Step 1] Initializing Automatic Job Retrieval Provider...`);
  // Use real HTTP fetch for RemoteOK, Himalayas, and curated employer ATS boards
  const provider = autoRetrievalProvider(
    { sinceMs, nowMs },
    {
      nowMs: () => nowMs,
      timeoutMs: 15_000,
      includeRemoteOk: true,
      includeHimalayas: true,
      includeAtsBoards: true,
      includeWuzzuf: false, // Keep fast for CLI run (ATS + Remote APIs)
    },
  );

  console.log(`[Step 2] Triggering Automatic External Job Retrieval & Search Evaluation...`);
  const t0 = Date.now();
  const result = await runSearchCycle(linkedinSearches, provider, {
    concurrency: 8,
    deadlineMs: nowMs + 45_000,
    maxRetries: 1,
    backoffBaseMs: 100,
    now: () => Date.now(),
  });
  const durationMs = Date.now() - t0;

  console.log(`\n================================================================`);
  console.log(`RETRIEVAL & EVALUATION COMPLETED IN ${durationMs} ms`);
  console.log(`================================================================`);

  const retrieval = result.retrieval;
  if (retrieval) {
    console.log(`\n[External Sources Retrieval Summary]`);
    console.log(`Total real external jobs retrieved: ${retrieval.totalRetrieved}`);
    console.log(`Sources queried (${Object.keys(retrieval.sources).length}):`);
    for (const [name, summary] of Object.entries(retrieval.sources)) {
      console.log(`  - ${name.padEnd(25)}: ${String(summary.retrieved).padStart(4)} jobs | status: ${summary.status} (${summary.durationMs}ms)${summary.error ? ` [${summary.error}]` : ''}`);
    }
  }

  const counts = summarize(result.outcomes);
  console.log(`\n[39 Saved Searches Evaluation Summary]`);
  console.log(`Status breakdown:`, counts);

  console.log(`\nSearches with matches:`);
  let matchCount = 0;
  for (const outcome of result.outcomes) {
    if (outcome.status === 'SUCCESS' && (outcome.found ?? 0) > 0) {
      matchCount++;
      const search = linkedinSearches.find((s) => s.id === outcome.id);
      console.log(`  ✅ [${outcome.id}] "${search?.label}": ${outcome.found} matching jobs (${outcome.ms}ms)`);
    }
  }
  if (matchCount === 0) {
    console.log(`  (No searches matched within current strict backend filter criteria)`);
  }

  console.log(`\n[Deduplication & Qualifying Matching Jobs]`);
  console.log(`Total unique matching jobs across all 39 searches: ${result.jobs.length}`);
  console.log(`Duplicate matches deduplicated across searches: ${result.duplicates}`);

  if (result.jobs.length > 0) {
    console.log(`\nSample of Discovered Jobs matching saved searches:`);
    const primaryProfile = profiles[0]!;

    for (let i = 0; i < Math.min(result.jobs.length, 5); i++) {
      const job = result.jobs[i]!;
      const normalized = normalizeJob(job, primaryProfile, nowMs);
      const evalResult = evaluateAll(normalized, profiles, { mutedCompanies: new Set() });
      const jobItem = buildJobItem(normalized, evalResult, 'INSTANT', normalized.jobId, nowMs) as unknown as JobItem;

      console.log(`\n--- Match #${i + 1} ---`);
      console.log(`Title: ${job.title}`);
      console.log(`Company: ${job.company}`);
      console.log(`Location: ${job.location}`);
      console.log(`Original URL: ${job.sourceUrl}`);
      console.log(`Matched Searches: ${job.matchedSearches?.join(', ')}`);
      console.log(`Score: ${evalResult.score}% (Decision: ${evalResult.decision})`);

      console.log(`\n[Generated Telegram Notification Payload]:\n${formatJobAlert(jobItem, nowMs)}\n`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error during execution:', err);
  process.exit(1);
});

