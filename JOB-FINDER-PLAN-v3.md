# Job Finder — Telegram Bot on AWS Serverless

**Version:** 3.0 — replaces v2  
**Date:** 2026-11-10  
**Purpose:** Implementation plan for a coding AI / developer  
**Interface:** One private Telegram bot chat  
**Hosting:** AWS Lambda + managed AWS services  
**Primary goal:** Find new backend Node.js / TypeScript jobs that are realistically open to someone working from Egypt, then notify quickly without unnecessary scraping traffic.  
**Cost goal:** Stay within applicable AWS free usage quotas as much as possible. A guaranteed $0 bill cannot be promised for every AWS account or deployment.

---

## 0. Decisions at a glance

1. Keep **Lambda, DynamoDB, EventBridge Scheduler, SSM Parameter Store, SAM, and GitHub Actions with OIDC**.
2. Keep the application in **plain TypeScript modules**, not NestJS. This is a small event-driven personal tool; NestJS, RDS, Redis, and a permanently running server add cost and operational work without solving a current problem.
3. Use **official/public APIs, RSS feeds, and subscribed job-alert emails first**. Use HTML scraping only for a source that permits it and has no suitable public interface. **Exception: LinkedIn search results are scraped** (owner decision, 2026-11-13); see the LinkedIn row in §4.
4. Implement anti-blocking as **polite, policy-compliant crawling**: source-specific intervals, per-host concurrency, conditional requests, caching, honest identification, backoff, and circuit breakers.
5. Do **not** rotate proxies, spoof browser fingerprints, solve CAPTCHAs, bypass login walls, or keep retrying a 403. If a source refuses access, pause it and use an official API/feed/email alternative.
6. Split **job discovery frequency** from **Telegram delivery frequency**. Several Telegram notifications per minute are feasible; checking every website every few seconds is unnecessary and often counterproductive.
7. Replace direct `DynamoDB Streams -> Telegram` delivery with **DynamoDB outbox -> Streams dispatcher -> SQS FIFO -> single-concurrency Telegram sender**. This serializes messages, isolates retries, and keeps the stream consumer from being responsible for Telegram rate limits.
8. Use a **five-minute company-board dispatcher** that checks a bounded batch of due companies. Store a separate `nextCheckAt` for each board. Start with a one-hour cadence per company; only shorten selected boards to 30 minutes after confirming source rules and stable responses.
9. Use a deterministic matching engine in TypeScript. Do not call a paid LLM for every job in v1.
10. Treat the AWS Free Tier as quotas, not as a promise that the whole system can never create a bill. Add billing alerts and fixed resource limits before deploying.

## 1. What we're building

A private Telegram bot that:

- collects new jobs from permitted public APIs, RSS feeds, ATS job-board endpoints, and subscribed alert emails;
- filters for backend Node.js / TypeScript roles that can realistically be taken from Egypt;
- scores matches against a version-controlled profile;
- sends high-quality matches as Telegram messages and lower-quality matches in a digest;
- stores job status: `New -> Saved -> Applied -> Interview -> Offer`, with `Dismissed` as a separate terminal/user state;
- lets the user inspect status, search stored jobs, mute companies, and report missed jobs.

**Not in v1:** a mobile app, web dashboard, multi-user support, auto-apply, CV generation, paid proxy service, paid scraping API, paid LLM, OpenSearch, RDS, Redis, or a public REST API.

## 2. The crucial distinction: discovery speed vs notification speed

These are two different controls:

- **Discovery speed:** how often a source is checked and how fresh its upstream data is.
- **Notification speed:** how quickly an already-discovered job is sent to Telegram.

A private Telegram chat should not receive more than about **one message per second**. A practical queue can deliver several messages per minute, and can drain a burst of several matching jobs without sending them all at once. Telegram does not require a paid broadcast feature for one private chat at this rate.

Polling a source every few seconds does not make its own data update more quickly. For example, the Himalayas API says its API data refreshes every 24 hours; more frequent polling does not make the API fresher. Jobicy's public API guidance says not to start new automated sync passes more frequently than once per hour.

**Product expectation:** the bot can notify within seconds after *it discovers* a job. It cannot promise to discover a job seconds after the employer publishes it. Discovery latency is bounded by each source's publication/cache delay and configured polling interval.

## 3. Architecture

```text
                         EventBridge Scheduler
                  source schedules + 5-minute board tick
                                  |
          +-----------------------+-------------------------+
          |                       |                         |
          v                       v                         v
    source-sync Lambda     company-board Lambda       maintenance Lambda
    RSS / public APIs      due ATS boards in batches   health / digest / backup
          |                       |                         |
          +-----------+-----------+                         |
                      v                                     |
             Source adapters + HTTP policy                  |
        robots/terms checks, domain gate, cache, backoff     |
                      |                                     |
                      v                                     |
         normalize -> eligibility -> score -> dedupe        |
                      |                                     |
                      v                                     |
         DynamoDB transaction: Job + Dedupe + Outbox         |
                      |                                     |
              DynamoDB Streams (INSERT)                      |
                      v                                     |
          notification-dispatcher Lambda                     |
                      |                                     |
                      v                                     |
                 SQS FIFO queue                              |
                      |                                     |
                      v                                     |
      notification-sender Lambda (concurrency = 1)           |
          one Telegram send at a time                        |
                      |                                     |
                      v                                     |
                 Telegram bot <------------------------------+
                      ^
                      |
         Lambda Function URL webhook
         secret header + private chat ID
```

### AWS components

| Need | Service | Design |
|---|---|---|
| Compute | AWS Lambda, Node.js 24, arm64 | Small TypeScript handlers bundled with esbuild |
| Database | DynamoDB, provisioned mode | One table, two GSIs, TTL |
| Scheduling | EventBridge Scheduler | Source-specific schedules; `Africa/Cairo` for human-facing schedules |
| Notification queue | SQS FIFO | Preserves per-chat order; one message group for the private chat |
| Stream/outbox trigger | DynamoDB Streams -> Lambda | Dispatch only newly inserted notification outbox records |
| Webhook | Lambda Function URL | No API Gateway required; validate Telegram secret header and chat ID |
| Secrets | SSM Parameter Store Standard SecureString | No Secrets Manager in v1; use AWS-managed KMS key |
| Failure handling | SQS DLQ + stream on-failure destination | Inspect/replay failed notification work deliberately |
| Monitoring | CloudWatch metrics/logs/alarms | Short log retention; alarm on stale sync, paused source, DLQ depth |
| Critical fallback | SNS email | Only for critical system failures; Telegram may be unavailable when the bot is down |
| Deployment | AWS SAM + GitHub Actions OIDC | No long-lived AWS access key in GitHub |
| Tests | Vitest + DynamoDB Local | Fixtures for source responses; no live network in unit tests |

**Do not create a VPC or NAT Gateway.** The functions need outbound HTTPS access to public APIs. A NAT Gateway would add cost and is unnecessary for this design.

## 4. Sources and initial polling policy

Source cadence is a **starting configuration**, not a claim that every source has approved or guaranteed this exact frequency. Confirm the current API terms and response behavior before enabling each source.

| Source | Access method | Initial cadence | Policy / implementation notes | Phase |
|---|---|---:|---|---:|
| Company career pages (Greenhouse, Lever, Ashby) | Public ATS posting APIs | 60 min per company by default; selected watchlist boards may move to 30 min after validation | One request per company per interval; per-host gate; only published jobs; do not crawl arbitrary career-site pages | 1–2 |
| Wuzzuf | Candidate public RSS feed only if live verification and applicable terms allow it | Start at 4 h, then adjust to observed feed cache/size | The v2 plan's `all-jobs.xml`, 15 MB size, and four-hour cache claims must be verified during setup. Do not treat them as guaranteed facts. If AWS returns 403 or the feed is not permitted, disable it; do not use proxies to evade the block. | 1, conditional |
| Himalayas | Public JSON Search/Browse API | Once per day | Its documentation says data refreshes every 24 hours. A free API key raises rate limits, but higher limits do not make the dataset fresher. Use country/remote filters and follow pagination only when required. | 1 |
| Jobicy | Public JSON API: `GET https://jobicy.com/api/jobs` | Once per hour at most frequent | Current API guidance says not to start new automated sync passes more frequently than hourly. Preserve original Jobicy URL and attribution. Follow cursor pagination sequentially. | 2 |
| Remote OK | Public JSON or RSS feed | Every 2 h initially | Public feeds are documented. Credit Remote OK and link each original listing. No need to scrape its HTML pages. | 2 |
| LinkedIn search | Scraping the logged-out results endpoint (`jobs-guest/jobs/api/seeMoreJobPostings/search`) for each saved search | Every 3 min (one cycle over the 37 saved searches, rotated; on-site/hybrid only in Egypt, remote elsewhere) | Primary LinkedIn source. One request to linkedin.com at a time through the domain gate; a 429/999, sign-in wall or security check stops the cycle and the host breaker cools down. | 3 |
| LinkedIn alerts | User-created job-alert emails | Check the mailbox every 10 min | Prefer Gmail API OAuth read-only access over storing an IMAP app password. The alert email delivery frequency is controlled by LinkedIn, not by this polling interval. | 3 |
| Hacker News “Who is hiring?” | Official Algolia HN API | Hourly during the first 72 h of the monthly thread; then daily | Parse the current monthly thread; respect API terms and avoid repeated full scans when no new comments exist. | 3 |
| We Work Remotely | Published RSS feed | Later; start at 2–4 h after terms review | Store only permitted fields and link to the original listing. | Later |
| Remotive | Public API | Later, only after checking current API usage rules | Do not hardcode the v2 plan's “four calls/day” claim without rechecking current source documentation. | Later |

### 4.1 Company-board discovery

The company list may grow from apply URLs discovered in job listings, but **never follow arbitrary URLs and scrape whatever they contain**.

1. Parse the apply URL without requesting it.
2. Match only known ATS host patterns (Greenhouse, Lever, Ashby, and later approved providers).
3. Extract the public board token/slug.
4. Validate the token using that ATS provider's documented public posting endpoint.
5. Store a `CompanyBoard` record with the provider, hostname, board token, source job, `nextCheckAt`, and status.
6. Fetch only the provider's published job-postings endpoint.
7. Reject private/internal endpoints and unknown hosts.

Newly discovered companies enter a low-frequency queue. Do not immediately give every discovered company a 30-minute schedule. Prefer active/high-priority companies first; age out boards that repeatedly return no useful listings.

### 4.2 Company-board dispatcher

Run one dispatcher Lambda every five minutes. It queries a due-board index and processes at most 10–20 board records per invocation. Each board has its own cadence and next-check timestamp.

- Default per-company interval: 60 minutes.
- High-priority interval: 30 minutes only after source-policy review and stable responses.
- At most one in-flight request per hostname.
- Bounded work per invocation; update `nextCheckAt` only after the outcome is recorded.
- If the due backlog is larger than one batch, the next five-minute tick continues it. Cap v1 at roughly 150 active boards; 20 boards per five-minute tick provides about 240 board checks/hour, leaving scheduling headroom. If the active-board cap is raised, revisit batch throughput and concurrency first.
- Do not create thousands of independent EventBridge schedules for individual employers.

This lets the system monitor many employers without a permanently running worker or one Lambda invocation per company on every scheduler tick.

## 5. Compliant anti-blocking and source resilience

The objective is to **avoid unnecessary traffic and respond correctly to access controls**, not defeat anti-bot systems.

### 5.1 Before a source is enabled

- Prefer a documented API or RSS feed over scraping HTML.
- Read the provider's API terms, usage policy, and published request limits.
- For actual page crawling, inspect `robots.txt` and follow applicable disallow rules. `robots.txt` is not a substitute for the site's terms or explicit API rules.
- Record the source's allowed method, minimum interval, attribution requirement, fields permitted for storage, and canonical job URL.
- Store this policy in source configuration so it can be reviewed later.

### 5.2 HTTP client behavior

Create one shared `HttpClient` used by all non-browser source adapters.

- Identify the application honestly with a stable user agent, for example `JobFinder/1.0 (+mailto:contact@example.com)`. Do not impersonate Chrome or another browser.
- Use HTTPS and GET for public read-only feeds/APIs.
- Set a 15–20 second timeout with `AbortSignal.timeout()`.
- Validate the response status and content type before parsing.
- Set a reasonable response-size cap; stream large XML feeds instead of loading an unbounded body into memory.
- Reuse connections where practical; request compression when the server supports it.
- Revalidate every redirect. Permit only known expected hosts; reject redirects to localhost, private IP ranges, link-local addresses, or cloud metadata endpoints.
- Never fetch arbitrary URLs supplied by a job description or Telegram command. Only known provider host patterns are eligible.

### 5.3 Conditional requests and cache

Persist cache validators per source or board:

- If the server supplies `ETag`, send `If-None-Match` on the next request.
- If the server supplies `Last-Modified`, send `If-Modified-Since`.
- Treat `304 Not Modified` as success with no body parsing and no job writes.
- Respect `Cache-Control` where applicable.
- Do not invent validators when the server did not supply them.
- Keep a last-successful response timestamp and last-change timestamp separately. A successful unchanged response is not a failed source.

### 5.4 Rate limiting and concurrency

Implement a **domain-level request gate**, not just a source-level delay.

Persist one `DOMAIN#<hostname>` gate record with:

- `nextAllowedAt` (host-level spacing);
- `cooldownUntil`;
- `leaseUntil` / lease owner;
- `consecutive429`, `consecutive5xx`, and `consecutiveNetworkFailures`;
- `pausedReason` and `pausedAt`.

The gate must be claimed with a DynamoDB conditional update so two Lambda invocations cannot simultaneously pass the same host's limit. Start with one in-flight request per hostname and a separately configured, conservative host-level minimum gap (for example 1–2 seconds as an internal starting setting, not a claimed provider limit). Keep the per-company board interval separate: 60 minutes for one company does **not** mean only one Greenhouse/Lever/Ashby company can be checked per hour across the entire ATS host. Always use a stricter published provider limit when one exists.

Do not sleep inside a Lambda for minutes just to wait for a source's next allowed time. If the gate is closed, skip/defer the work and let its next scheduled run or a bounded queue handle it.

Use staggered schedule offsets or EventBridge flexible windows to avoid every source waking at the same second. Jitter retries, not the upstream source identity.

### 5.5 Retry policy by response

| Result | Behavior |
|---|---|
| `200` | Parse, normalize, record success, update validators and watermark |
| `304` | Record a successful unchanged check; do not parse or write jobs |
| `301/302/307/308` | Follow only after validating the redirect host against the source allowlist |
| `400` | Treat as a request/configuration bug; do not repeat blindly |
| `401` | Pause the source and report an authentication/configuration issue |
| `403` | Stop automatic attempts and mark `MANUAL_REVIEW`; do not rotate IPs or change fingerprints to get around it |
| `404` | Mark the board/feed unavailable; retire a company board only after a defined validation window |
| `429` | Parse `Retry-After` (seconds or HTTP date); defer until that time plus small jitter. If absent, use conservative exponential cooldown. Never retry in a tight loop. |
| `5xx` / network timeout | Retry idempotent GET up to 3 times with exponential backoff and full jitter; then record failure and let the breaker decide |
| CAPTCHA / login wall / explicit anti-bot challenge | Stop automation and pause for manual review; use an authorized email/API/feed alternative |

Example transient backoff: approximately 1 s, 2 s, 4 s plus random jitter, with a strict upper bound. `Retry-After` takes precedence over this fallback.

### 5.6 Circuit breaker

Use error-specific breaker behavior rather than treating every failure equally:

- Repeated `429`: extend the cooldown using `Retry-After`; after repeated rate limits, reduce polling frequency and alert once.
- Three consecutive `5xx` or network failures: pause for one hour; increase the pause on repeated episodes, up to 24 hours.
- `401`, `403`, CAPTCHA, or explicit prohibition: pause immediately and require manual review.
- Successful check: reset transient failure counters, but do not automatically clear a manual-review pause.
- Send one Telegram warning when the breaker changes state, not on every failed run.

**Explicitly out of scope:** rotating residential/datacenter/mobile proxies to evade a ban, fake browser headers, stealth plugins, browser fingerprint spoofing, CAPTCHA solving, account rotation, and bypassing login/paywalls. These create account, legal, and reliability risks and are not required for this project.

### 5.7 Playwright policy

Do not add Playwright to the first release. Most selected sources expose JSON, RSS, or email. Browser automation adds large bundles, cold-start work, memory usage, and another detection surface. Add it only for a specific source that permits automated access, truly requires JavaScript rendering, and has no documented feed/API alternative. It must use the same domain gate and stop-on-block rules.

## 6. Matching rules

### 6.1 Profile in code

`config/profiles.ts` is version-controlled and type-checked.

```typescript
export const profiles: SearchProfile[] = [
  {
    id: 'backend-node',
    titleInclude: [
      'backend', 'back-end', 'node', 'nodejs', 'node.js', 'nestjs',
      'api engineer', 'server-side',
    ],
    titleExclude: [
      'frontend', 'front-end', 'ios', 'android', 'flutter',
      'react native', 'qa', 'sales', 'data scientist',
    ],
    mustHaveSkills: ['node'],
    niceSkills: [
      'typescript', 'nestjs', 'postgresql', 'redis', 'docker',
      'aws', 'kafka', 'grpc',
    ],
    seniority: { accept: ['junior', 'mid'], maxYears: 4 },
    locations: {
      countries: ['EG'],
      remoteRegions: ['WORLDWIDE', 'EMEA', 'AFRICA', 'MENA'],
      minTzOverlapHours: 4,
    },
    minSalaryUsdMonth: undefined,
  },
];

export const cvSkills = [
  'node', 'typescript', 'nestjs', 'postgresql', 'redis', 'docker', 'grpc',
];
```

Treat this as an initial profile; make it editable through configuration later, not through a new settings UI in v1.

### 6.2 Hard filters

Reject a job only when evidence is clear:

- Title matches `titleExclude` or does not match `titleInclude`.
- Clearly senior role: `senior`, `sr.`, `lead`, `staff`, `principal`, `head`, or `architect`; do not automatically reject the word `manager` if it is a technical individual-contributor title without checking context.
- Description requires more experience than the configured maximum.
- Egypt is explicitly excluded (for example “US only” or “must be based in the EU”).
- Employer is muted.

Do **not** reject a job just because location, salary, or years of experience are missing. Mark those fields `UNKNOWN` and lower confidence.

### 6.3 Scoring

| Dimension | Weight |
|---|---:|
| Title relevance | 30 |
| Skills | 30 |
| Egypt / remote eligibility | 20 |
| Experience fit | 20 |

```text
score = earned points / points possible among KNOWN dimensions * 100
confidence = known dimension weight / total weight
alert only if score >= 60 and confidence >= 0.5
```

Unknown fields neither reward nor punish the score; they lower confidence.

Additional rules:

- Skill aliases: `node` matches `node`, `nodejs`, `node.js`; `postgresql` matches `postgres`, `postgresql`, `psql`; `typescript` matches `ts`, `typescript` where context is unambiguous.
- Whole-word matching: `Java` must not match `JavaScript`; `Go` must not match `Google`.
- Include Arabic backend-title aliases for Wuzzuf results, such as `مطور باك اند` and `مبرمج`.
- Keep the original salary and currency. Normalize annual/monthly amounts. Convert to USD only when a cached, dated exchange rate is available; never silently guess an exchange rate.

## 7. Data model: one DynamoDB table

Table: `jobfinder`, partition key `PK`, sort key `SK`. Use two GSIs. Enable TTL on `ttl` (Unix epoch seconds). TTL deletion is asynchronous; application logic must not depend on immediate deletion.

| Item | PK | SK | Main fields |
|---|---|---|---|
| Job | `JOB#<jobId>` | `META` | title, company, location, remoteScope, eligibleRegions, skills, seniority, minYears, salary, applyUrl, sourceUrl, publishedAt, discoveredAt, score, confidence, matchedProfiles, clusterId, userStatus, summary |
| Job event | `JOB#<jobId>` | `EVENT#<time>#<eventId>` | type, reason, createdAt |
| Dedupe | `DEDUP#URL#<hash>` or `DEDUP#FP#<hash>` | `META` | clusterId, firstJobId; TTL 60 days |
| Notification outbox | `NOTIF#<notificationId>` | `META` | status, jobId/clusterId, score, createdAt, queuedAt, sentAt, Telegram messageId, attempts, failureReason |
| Source state | `SOURCE#<sourceId>` | `STATE` | watermark, etag, lastModified, bootstrappedAt, lastSuccessAt, lastChangeAt, consecutiveFailures, pausedUntil, state |
| Source run | `SOURCE#<sourceId>` | `RUN#<time>#<runId>` | found, kept, alerts, unchanged, errors, status, durationMs; TTL 30 days |
| Domain gate | `DOMAIN#<hostname>` | `GATE` | nextAllowedAt, cooldownUntil, leaseUntil, failure counters, breaker state |
| Company board | `BOARD#<ats>#<token>` | `META` | ats, hostname, token, company, nextCheckAt, intervalMinutes, etag, lastModified, enabled, priority, addedFrom |
| Company | `COMPANY#<key>` | `META` | name, muted, appliedAt |
| Settings | `SETTINGS` | `GLOBAL` | paused, instantSentToday, day, quietHours, maxInstantAlertsPerDay |
| Lock | `LOCK#<sourceId>` | `META` | expiresAt |
| Telegram rate state | `TELEGRAM#<chatId>` | `RATE` | nextAllowedAt, lastSuccessfulTelegramSendAt, lease/lock fields if needed |
| Telegram update | `UPDATE#<update_id>` | `META` | processedAt; TTL 2 days |

### 7.1 Indexes

- **GSI1:** `GSI1PK = STATUS#<userStatus>`, `GSI1SK = <discoveredAt>#<jobId>`. Used by `/top`, `/saved`, `/applied`, and bounded recent search.
- **GSI2:** sparse queue index. `GSI2PK = DIGEST` for digest items, or `GSI2PK = OUTBOX#PENDING` for notification outbox reconciliation. `GSI2SK` stores an order key (score/time for digest, created time for pending outbox). Remove the relevant index attributes as soon as an item leaves that queue.

GSI reads are eventually consistent. Perform final state transitions against the base item with conditional writes.

### 7.2 Search limitation

DynamoDB is not a full-text search engine. Do not claim arbitrary substring/fuzzy search is supported natively. In v1, `/search` must query a bounded date window across known status partitions and filter the returned recent records in TypeScript. Put a strict result/page cap on this operation. If the dataset becomes too large, either simplify `/search` or revisit a dedicated search service; do not add a paid search cluster pre-emptively.

### 7.3 Capacity and cost controls

Use DynamoDB **provisioned capacity**, not on-demand, for this predictable personal workload. Start conservatively, for example:

- table: 5 RCU / 5 WCU;
- GSI1: 5 RCU / 5 WCU;
- GSI2: 5 RCU / 5 WCU;
- total configured: 15 RCU / 15 WCU, leaving room under the documented 25 RCU / 25 WCU Always Free provisioned-capacity allowance.

Disable auto scaling. Throttling is preferable to silently increasing provisioned capacity and creating a bill. Use bounded retries with jitter for DynamoDB throttles and monitor consumed capacity. Adjust only after measuring.

Keep GSI projections small. Avoid table scans in normal handlers. Query by partition key and paginate. TTL targets: jobs/dedupe 60 days, notifications 30 days, source runs 30 days, Telegram update idempotency records 2 days. Keep saved/applied/interview/offer jobs beyond the normal job TTL.

## 8. Source sync pipeline

One source sync handler can accept `{ sourceId }`; the company-board worker accepts a bounded batch of due board records.

For each source run:

1. Acquire the source/board lease using a conditional DynamoDB write. If another run holds a valid lease, exit without fetching.
2. Load source state. If manually paused or `cooldownUntil > now`, exit and record a deferred run.
3. Acquire the domain-level request gate. If no slot is available, defer/skip without making the request.
4. Build an HTTP request with a descriptive User-Agent and stored conditional headers.
5. Fetch with timeout, redirect validation, and response-size limits.
6. Handle HTTP status according to §5.5. A 304 is a successful unchanged check.
7. Parse the feed/API response using a source-specific adapter. Do not let one malformed item abort the whole feed; record the malformed item and continue within a bounded error threshold.
8. Process only the source's supported time window and the watermark overlap (for example, reprocess the last 48 hours to catch late edits/reordering).
9. Normalize each item into `ExternalJob`.
10. Apply hard filters, score, and confidence.
11. Generate canonical apply URL and a fingerprint.
12. Resolve duplicate keys. If a duplicate is found, update the existing job's `alsoOn` metadata/source list only when appropriate; do not create a second alert.
13. For a new job that qualifies, transact the Job + dedupe keys + Notification outbox item in one DynamoDB transaction. The transaction is conditional so replaying the same source page cannot create duplicate jobs/outbox items.
14. Save new validators, watermark, last successful check, and sync-run metrics. Reset transient failure counters.
15. Always release/expire the lease safely, including on error.

### First run / bootstrap

The first run of a source must not flood Telegram with historical jobs. Store up to the configured backfill window (initially 7 days), mark the source bootstrapped, and send one connection summary with the number of matching jobs. Only jobs first discovered after bootstrap can create instant notifications.

## 9. Deduplication

A job is a likely duplicate if either key matches:

1. **Canonical apply URL:** lowercase host; strip known tracking parameters (`utm_*`, `ref`, `refId`, `trackingId`); remove fragment; normalize known LinkedIn job links to a stable job ID. If the apply URL points to a known ATS posting, prefer that canonical ATS URL.
2. **Fingerprint:** normalized company + normalized title + location/remote scope. Remove legal company suffixes and superficial punctuation/seniority tokens only where safe.

A fingerprint is a heuristic, not proof. Do not automatically merge two jobs from the same company with similar titles if location, team, requisition ID, or posting dates materially differ. Store `duplicateConfidence` or require a second matching signal for uncertain matches.

Use a sufficiently long SHA-256-derived identifier (at least 24 hex characters for internal IDs). Telegram callback payloads must remain within Telegram's 64-byte callback-data limit; use a compact stable ID there.

## 10. Notification delivery

### 10.1 Outbox and SQS FIFO flow

1. The source transaction inserts a notification item with `status = PENDING` and GSI2 attributes for `OUTBOX#PENDING`.
2. DynamoDB Streams invokes `notification-dispatcher` on INSERT records only. Filter the event mapping to notification outbox items.
3. `notification-dispatcher` sends an SQS FIFO message containing only the `notificationId` and required routing metadata. Set `MessageGroupId` to the private chat ID and `MessageDeduplicationId` to the notification ID.
4. The dispatcher conditionally changes the outbox status from `PENDING` to `QUEUED`. If SQS accepted the message but this status update failed, the sender must still accept a `PENDING` item. Duplicate dispatches are safe; the sender must always verify/claim the base item status before sending.
5. `notification-sender` consumes one FIFO message at a time. Configure batch size 1, reserved concurrency 1, a single message group for the private chat, and SQS partial batch responses (`ReportBatchItemFailures`). Read the outbox item first; if it is already `SENT` or `FAILED`, acknowledge the duplicate SQS message without sending.
6. Before sending, atomically reserve a send slot in the `TELEGRAM#<chatId>` rate-state item: require `nextAllowedAt <= now`, then set `nextAllowedAt = now + 1,100 ms`. If the slot is not ready, use SQS `ChangeMessageVisibility` and return the item as failed so Lambda retries after the remaining delay. This avoids paying for a Lambda sleep and remains safe across separate execution environments. The single-concurrency sender is the serialization guard; do not rely on in-memory state.
7. Send the Telegram message. On success, conditionally update `PENDING/QUEUED -> SENT`, persist Telegram's `message_id` and `sentAt`, and update `lastSuccessfulTelegramSendAt`. If the process crashes after the Telegram send but before this update, a duplicate is possible; retain the at-least-once guarantee described below.
8. On temporary errors, leave the item retryable and let SQS visibility timeout / redrive handle it. On `429`, set `nextAllowedAt` to at least `now + retry_after`, change the SQS message visibility to that delay, and return the item as failed; do not busy-loop.
9. On permanent Telegram errors (`400` invalid message, `403` bot blocked, etc.), mark the item `FAILED`, store the reason, and do not retry forever.
10. After the configured receive count (for example 5), SQS moves the message to a DLQ and the health check reports it.

### 10.2 Recovering pending outbox records

DynamoDB Streams retain records for a limited time, and a failed stream consumer must not be the only way to recover notifications. Add an outbox reconciler every five minutes:

- query the `OUTBOX#PENDING` GSI2 partition for old pending records;
- enqueue them idempotently to SQS FIFO;
- conditionally mark them queued;
- cap the number inspected per run.

Configure the stream event source with bounded retry attempts and an on-failure destination. The SQS FIFO queue has its own DLQ. Configure SQS event-source partial batch responses (`ReportBatchItemFailures`) and alert when either failure queue is non-empty.

### 10.3 Delivery guarantees

Delivery is **at least once**, not exactly once. If Lambda sends a Telegram message successfully and crashes before recording `SENT`, a retry may send one duplicate. Telegram `sendMessage` does not provide an application idempotency key that can remove this failure window. Keep the duplicate risk explicit.

### 10.4 Notification policy

| Rule | Default |
|---|---|
| Instant | Score >= 80, confidence >= 0.5, not muted, not in quiet hours |
| Digest | Score 60–79, quiet-hour holds, or instant cap overflow |
| Quiet hours | 00:00–08:00 Africa/Cairo |
| Instant daily cap | 30 by default; configurable. Excess goes to digest, not dropped. |
| Stale listings | Do not instant-alert jobs first discovered more than 72 hours after publication unless the source's `publishedAt` is unreliable; show them in `/top` instead. |
| First source run | Store matches and send one connection summary; no alert flood |
| Delivery rate | At least 1.1 seconds between messages to the private chat |

The previous 15/day cap was conservative. Raise the default to 30/day so a useful burst is not suppressed, but keep a configurable cap to prevent a broken source from flooding the chat.

### 10.5 Digest

Send at 09:00 and 18:00 Cairo time. Read GSI2 `DIGEST`, order best score first, and send up to 20 jobs in compact Telegram messages. Mark each job sent and remove its digest-index attributes. Digest messages must also respect Telegram rate limits.

## 11. Telegram bot

### Alert format

```text
🎯 Backend Engineer — 86%
🏢 Acme · 🌍 Remote (EMEA) · 🕒 first seen 2 h ago
🧩 Node.js · TypeScript · PostgreSQL
💰 2,500–3,500 USD / month (source: employer)
📍 via Himalayas

[ Apply ↗ ] [ ⭐ Save ] [ ✅ Applied ]
[ 👎 Not relevant ] [ 🚫 Hide company ]
```

- Escape HTML in every source-provided string before formatting.
- Link to the original job posting; preserve the source's attribution rules.
- `Not relevant` asks for a reason: too senior, wrong stack, not Egypt-eligible, location, salary, duplicate, or other.
- Buttons use compact IDs and validate that the target job exists and belongs to this bot's dataset.

### Commands

| Command | Behavior |
|---|---|
| `/start` | Verify private chat and show welcome message |
| `/top` | Top 10 active jobs not yet acted on |
| `/saved`, `/applied` | User's corresponding jobs |
| `/search <words>` | Bounded recent search as described in §7.2 |
| `/status` | Source last run, last success, jobs found, stale/paused/error state, queue depth |
| `/pause`, `/resume` | Pause/resume instant notifications; continue collecting jobs for digest |
| `/mute <company>` | Mute a company |
| `/missed <url>` | Validate a URL against supported domains; record a missed-job report or add a supported public board |
| `/digest` | Send the current digest now |
| `/help` | Show commands |

The bot serves **only the configured private chat ID**. Ignore all other chat IDs without revealing whether the bot has data.

### Webhook security

- Use a Lambda Function URL and Telegram's `secret_token` webhook header.
- Compare the secret header safely; reject invalid requests.
- Validate the expected chat ID before handling a command or callback.
- Store each Telegram `update_id` with a conditional put before applying side effects. If already present, return HTTP 200 and do nothing.
- Return quickly; do not make source HTTP requests inside the webhook handler.
- Set webhook allowed updates to only the update types the bot uses.

## 12. Gmail / LinkedIn alert emails

- Use a dedicated mailbox for job alerts.
- Prefer the Gmail API with OAuth read-only access; keep refresh credentials in SSM SecureString.
- Check every 10 minutes, store the last processed Gmail message/history ID, and process only messages from expected senders.
- Parse from saved examples of the user's own alert emails; one parser per sender.
- Do not log email bodies, access tokens, or full links containing private tracking parameters.
- Normalize LinkedIn job links to the public job ID URL when that ID is present.
- Hand parsed jobs through the same normalize/filter/score/dedupe/outbox pipeline, with description-based skill matching marked `UNKNOWN` where no description is present.

## 13. Monitoring, reliability, and security

| Risk | Protection |
|---|---|
| Duplicate source run | Conditional source lock and conditional writes |
| Same job from multiple sources | Canonical URL + cautious fingerprint matching |
| Job saved without notification | Job, dedupe, and outbox item in one DynamoDB transaction |
| Stream event not dispatched | Stream retry/on-failure destination + five-minute pending-outbox reconciler |
| Parallel Telegram sends | SQS FIFO, one message group, sender reserved concurrency 1 |
| Telegram rate limit | 1.1-second gap; honor `retry_after`; retry through SQS |
| Website rate limit | Per-domain gate, source-specific cadence, conditional GET, 429 cooldown |
| Website blocks access | Pause on 403/CAPTCHA; manual review; no evasion |
| Source returns stale/empty data | Track last change separately from last successful check; health thresholds based on source behavior |
| Repeated transient failures | Exponential backoff and circuit breaker |
| Handler keeps failing | SQS DLQ / stream on-failure destination; alarm on non-empty queue |
| Lambda overlaps | Conditional locks; reserved concurrency on Telegram sender |
| Telegram webhook forged | Secret token header + chat ID + update idempotency |
| Arbitrary URL / SSRF | Host allowlist, HTTPS, redirect validation, reject private/metadata IP ranges |
| Leaked secrets | SSM SecureString, least-privilege IAM, no secrets in logs or git |
| Cost surprise | Billing alerts, fixed DynamoDB capacity, no NAT/VPC, short log retention, no auto scaling |

### Health checks

Daily health report should alert on:

- a source paused or manually blocked;
- a source stale beyond its expected schedule;
- two consecutive successful checks with zero matches when that source historically produces jobs (warning, not automatic proof of failure);
- a stream/SQS DLQ containing records;
- outbox pending count or oldest-pending age exceeding the threshold;
- Telegram sender failing or repeatedly receiving 429;
- AWS Lambda errors/throttles or DynamoDB throttling.

Weekly report: jobs found by source, eligible matches, alerts sent, saved/applied/interview/offer counts, dismiss reasons, most common matching skills, source freshness, and duplicate suppression counts.

Weekly backup: export only the user's own records/settings/history to gzipped JSON, then send it as a Telegram document. Do not add S3 backup storage in v1 unless the backup exceeds Telegram's file limit or a second copy is explicitly required.

## 14. AWS Free Tier and budget reality

AWS Free Tier rules differ by account age and selected account plan. For new accounts created from July 15, 2025 onward, AWS offers a Free account plan that ends after six months or when credits are exhausted; that plan then closes the account unless upgraded. A Paid account plan remains open, but usage above free quotas/credits can be billed. Existing accounts created before that date follow legacy rules. Check the actual account plan and billing console before deploying.

Current published free usage limits relevant to this plan include:

| Service | Published free usage to design around | Notes |
|---|---|---|
| Lambda | 1M requests + 400,000 GB-seconds per month | Keep functions short and memory modest; estimate actual usage from CloudWatch |
| DynamoDB | 25 provisioned RCU + 25 WCU + 25 GB storage; 2.5M stream read requests | Use provisioned mode and one Region; table and GSIs consume capacity |
| EventBridge Scheduler | 14M invocations per month | More than enough for these source schedules |
| SQS | 1M requests per month | Count send/receive/delete operations; batch where useful, but preserve one-at-a-time Telegram delivery |
| SNS | 1M API requests and 1,000 email notifications per month | Use only for critical email alarms |
| CloudWatch | Free usage quotas include log ingestion and standard alarms | Keep logs small, set 7–14 day retention, avoid unnecessary custom metrics |
| SSM Parameter Store Standard | Standard parameters are free | Avoid Secrets Manager in v1 |
| S3 | Do not assume permanently free | SAM deployment artifacts may use S3; keep the bucket tiny and clean old artifacts |

### Cost-control requirements

- Use one AWS Region only. Do not deploy a second region for the same table/stream.
- Before creating resources, enable AWS Billing alerts and create monthly AWS Budgets alerts at low thresholds (for example $1 and $5).
- Understand that a budget alert is not a hard spending cap and billing data can be delayed. A Paid plan can still incur charges.
- Set DynamoDB provisioned capacity manually and disable auto scaling.
- Set Lambda reserved concurrency only where useful (notably the Telegram sender); keep timeouts and memory realistic.
- Keep CloudWatch logs at 7–14 days. Never log full job descriptions or secrets by default.
- Do not use NAT Gateway, RDS, ElastiCache/Redis, paid proxies, Firecrawl, Bedrock, paid LLM APIs, or paid monitoring in v1.
- Keep the SAM artifact bucket small; expire old deployment artifacts with a lifecycle policy. Budget for a tiny possible S3 charge rather than promising exactly $0.
- Do not use customer-managed KMS keys unless a demonstrated need justifies the extra cost; use the AWS-managed SSM key.

**Account recommendation:** if this bot must keep running beyond six months, use a persistent Paid account plan with budgets and hard resource limits, after understanding that usage above free limits is billable. If absolute no-charge operation is more important than persistence, the new-account Free plan avoids charges during its limited period but is not a permanent hosting solution. Do not choose the account plan blindly.

## 15. Project structure

```text
job-finder/
├── template.yaml
├── samconfig.toml
├── package.json
├── tsconfig.json
├── config/
│   ├── profiles.ts
│   ├── sources.ts
│   └── limits.ts
├── src/
│   ├── handlers/
│   │   ├── sync-source.ts
│   │   ├── sync-company-boards.ts
│   │   ├── dispatch-notification.ts
│   │   ├── send-notification.ts
│   │   ├── reconcile-outbox.ts
│   │   ├── sync-gmail.ts
│   │   ├── digest.ts
│   │   ├── telegram-webhook.ts
│   │   └── maintenance.ts
│   ├── sources/
│   │   ├── contract.ts
│   │   ├── wuzzuf-rss.ts
│   │   ├── himalayas.ts
│   │   ├── jobicy.ts
│   │   ├── remoteok.ts
│   │   ├── hn.ts
│   │   ├── ats/
│   │   │   ├── greenhouse.ts
│   │   │   ├── lever.ts
│   │   │   └── ashby.ts
│   │   └── email/linkedin.ts
│   ├── core/
│   │   ├── normalize.ts
│   │   ├── eligibility.ts
│   │   ├── seniority.ts
│   │   ├── skills.ts
│   │   ├── scoring.ts
│   │   ├── dedupe.ts
│   │   ├── url.ts
│   │   └── salary.ts
│   ├── scraping/
│   │   ├── http-client.ts
│   │   ├── domain-gate.ts
│   │   ├── robots-policy.ts
│   │   ├── retry-policy.ts
│   │   ├── circuit-breaker.ts
│   │   └── redirect-guard.ts
│   ├── data/
│   │   ├── keys.ts
│   │   ├── jobs.ts
│   │   ├── outbox.ts
│   │   ├── sources.ts
│   │   ├── domains.ts
│   │   ├── boards.ts
│   │   ├── settings.ts
│   │   └── telegram-updates.ts
│   ├── notifications/
│   │   ├── queue.ts
│   │   ├── sender.ts
│   │   └── formatting.ts
│   ├── telegram/
│   │   ├── bot.ts
│   │   ├── commands.ts
│   │   └── keyboards.ts
│   └── lib/
│       ├── secrets.ts
│       ├── logger.ts
│       └── time.ts
├── test/
│   ├── fixtures/
│   ├── unit/
│   ├── contracts/
│   └── integration/
├── scripts/
│   ├── put-secrets.sh
│   └── set-webhook.sh
└── .github/workflows/deploy.yml
```

## 16. Testing requirements

| Level | Coverage |
|---|---|
| Unit | normalize, eligibility, seniority, skill aliases, scoring, canonical URLs, fingerprints, HTML escaping, retry-after parser, backoff, source state transitions |
| HTTP policy | ETag/Last-Modified, 304, timeout, max body size, invalid content type, redirect allowlist, private-IP rejection, rate gate, 429 cooldown, 403 pause |
| Source contracts | Each adapter against saved real feed/API/email fixtures; do not rely on live websites in unit tests |
| DynamoDB | transactions, conditional put/update, locks/leases, TTL attributes, GSI queries, outbox status transitions, throttling retries |
| SQS/notification | FIFO grouping, duplicate dispatch, one sender at a time, 1.1-second spacing, retry-after, permanent Telegram errors, DLQ behavior |
| Webhook | invalid secret, wrong chat ID, duplicate update ID, valid commands and callbacks |
| End-to-end | fixture -> normalized job -> DynamoDB job/outbox -> SQS -> Telegram payload; local DynamoDB via Docker |
| Live smoke | `/status`, `/top`, one test alert, and one source run after deploy |

### Must-pass scenarios

1. A new qualifying job is saved once and creates one outbox item.
2. Reprocessing the same source item does not create another job/alert.
3. Cross-source duplicates are merged only when matching evidence is strong enough.
4. First source run stores historical jobs but sends only one connection summary.
5. `304` is considered successful and creates no new jobs.
6. A 429 honors `Retry-After` and does not trigger a tight retry loop.
7. A 403/CAPTCHA immediately pauses the source and never triggers proxy rotation or browser stealth.
8. Requests to the same hostname do not exceed the configured domain concurrency/rate gate.
9. A stream dispatcher retry or outbox reconciler cannot cause duplicate Telegram sends after the notification is marked `SENT`.
10. Telegram receives no more than one message per second in the private chat.
11. A Telegram 429 is retried after `retry_after`.
12. A permanent Telegram 400/403 marks the notification failed without endless retries.
13. A failed SQS message reaches the DLQ and appears in `/status`/health alerts.
14. A duplicate webhook update is handled once.
15. Wrong chat IDs and invalid webhook secrets are rejected.
16. DynamoDB capacity throttling is bounded and does not silently increase provisioned capacity.

## 17. Implementation roadmap

### Phase 0 — account, access, and source verification

- Check AWS account creation date and account plan; create billing alerts/budgets.
- Create Telegram bot and record private chat ID.
- Create dedicated Gmail mailbox and OAuth credentials if LinkedIn email alerts will be used.
- Verify each planned source's current API/feed access, terms, required attribution, and response shape.
- Specifically verify Wuzzuf RSS from the intended Lambda environment. If it returns 403, stop and do not evade the block.
- Create SAM skeleton and deploy `/start` + `/status` only.

### Phase 1 — first working job alerts

- Implement DynamoDB table and two GSIs.
- Implement shared HTTP client, conditional request cache, source/domain state, and circuit breaker.
- Implement one source adapter at a time: Himalayas daily, Remote OK, and Wuzzuf only if verified.
- Implement normalize, Egypt eligibility, deterministic score, dedupe, and transaction/outbox.
- Implement SQS FIFO notification dispatcher/sender and Telegram message formatting.
- Verify first-run flood protection and Telegram rate control.

### Phase 2 — additional sources and company boards

- Add Jobicy using its current documented public API and hourly minimum interval.
- Add Greenhouse, Lever, and Ashby published-posting adapters.
- Add five-minute due-board dispatcher with per-company next-check scheduling and per-host gate.
- Add cautious board discovery from supported ATS apply URLs only.

### Phase 3 — inbox and bot interaction

- Add Gmail API ingestion of subscribed LinkedIn job alert emails.
- Add Telegram buttons/commands, user status history, company mute, bounded search, and digest.
- Add Hacker News source if it produces useful jobs.

### Phase 4 — hardening

- Add outbox reconciler, SQS/stream DLQs, alarms, daily health report, weekly report, backup, and CI/CD OIDC.
- Run source freshness and request-volume measurements for at least one week.
- Tune schedules from measured useful-job yield and source response behavior, not guesswork.

## 18. Explicit decisions for the coding AI

The implementation AI must:

1. Read this plan fully before modifying files.
2. Verify current AWS and source-provider documentation before relying on limits, endpoint parameters, or API response fields.
3. Implement the plan incrementally, keeping each phase deployable and tested.
4. Never add proxy rotation, stealth browser settings, CAPTCHA solving, fake browser identities, or a workaround for explicit 401/403 restrictions.
5. Never add a paid service without first documenting its recurring cost and asking for approval.
6. Keep source-specific assumptions in configuration and fixtures, not scattered conditionals.
7. Keep AWS SDK clients outside Lambda handler functions where practical to benefit from execution-environment reuse.
8. Use least-privilege IAM policies per Lambda. Do not give every function full DynamoDB/SQS/SSM access.
9. Add unit/integration tests with each feature; do not disable lint/type checks or bypass failing tests.
10. Do not claim $0 cost. Show actual estimated request/compute/capacity use and any non-free components before production deployment.
11. Do not silently widen the scope to a dashboard, auto-apply, LLM scoring, or additional user support.
12. Report any conflict between a source's current terms and this plan and disable that source until the conflict is resolved.

## 19. References checked on 2026-11-10

### AWS

- [AWS Free Tier overview and account plans](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier.html)
- [AWS Free Tier plan changes announced July 2025](https://aws.amazon.com/about-aws/whats-new/2025/07/aws-free-tier-credits-month-free-plan/)
- [AWS Lambda pricing](https://aws.amazon.com/lambda/pricing/)
- [Amazon DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/)
- [Amazon EventBridge pricing](https://aws.amazon.com/eventbridge/pricing/)
- [Amazon SQS pricing](https://aws.amazon.com/sqs/pricing/)
- [Amazon SNS FAQ and free usage](https://aws.amazon.com/sns/faqs/)
- [Amazon CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/)
- [Lambda with SQS error handling and partial batch responses](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html)
- [Lambda SQS event source configuration](https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-configure.html)
- [Lambda DynamoDB Streams event source parameters](https://docs.aws.amazon.com/lambda/latest/dg/services-ddb-params.html)

### Telegram

- [Telegram Bots FAQ — broadcasting limits](https://core.telegram.org/bots/faq)
- [Telegram Bot API](https://core.telegram.org/bots/api)

### Job sources

- [Himalayas Remote Jobs API](https://himalayas.app/api)
- [Himalayas Remote Jobs API documentation](https://himalayas.app/docs/remote-jobs-api)
- [Jobicy public remote-jobs API and fair-use guidance](https://github.com/Jobicy/remote-jobs-api)
- [Remote OK FAQ — public API/RSS and attribution](https://remoteok.com/faq)
- [Greenhouse Job Board API](https://docs.greenhouse.io/job-board)
- [Ashby public Job Postings API](https://developers.ashbyhq.com/docs/public-job-posting-api)
- [Lever Postings API documentation](https://github.com/lever/postings-api)
- [WUZZUF policies](https://wuzzuf.net/policies)

---

## 20. Final recommendation

Build **a fast notification pipeline, not a hyper-aggressive crawler**. Poll the freshest permitted sources on their own schedules, watch a curated list of employer ATS boards at 30–60 minute intervals, use official APIs and subscribed email alerts, and put every discovered notification through a serialized SQS FIFO sender.

This achieves the useful goal—several Telegram alerts per minute when multiple suitable jobs are found—without hitting sources every few seconds, paying for a proxy network, or building infrastructure that is difficult to maintain.
