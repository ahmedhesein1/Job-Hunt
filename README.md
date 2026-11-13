# Job Finder

A private Telegram bot that finds new backend, full-stack and software-engineering Node.js / TypeScript jobs open to someone in Egypt (on-site or hybrid in Egypt only; remote in any country) and alerts you within seconds of discovering them. It runs on AWS Lambda, DynamoDB, EventBridge Scheduler and SQS FIFO, with no servers, VPC, NAT, RDS, Redis or paid APIs. The design is in [JOB-FINDER-PLAN-v3.md](JOB-FINDER-PLAN-v3.md); section numbers (§) below refer to it.

## How it works

```
EventBridge Scheduler ─┬─ sync-source (Himalayas daily · Remote OK 2 h · Jobicy 65 min · HN hourly→daily · Wuzzuf off)
                       ├─ sync-company-boards (every minute; Egyptian boards every 5 min, others every 15)
                       ├─ sync-rendered-pages (headless Chromium for JavaScript-only career sites, every 3 h)
                       ├─ linkedin-orchestrator (scrapes the 37 saved LinkedIn searches, every 3 min)
                       ├─ sync-gmail (LinkedIn alert emails, every 10 min — off until configured)
                       ├─ reconcile-outbox (every 5 min) · digest (09:00, 18:00 Cairo) · maintenance (health/report/backup)
                       ▼
     HTTP policy: domain gate (1 request/host, spacing, breaker) · ETag/Last-Modified · redirect+SSRF guard · robots
                       ▼
     normalize → eligibility (on-site/hybrid in Egypt only; remote in any country unless the text restricts who can apply; citizens-only roles rejected) → score → dedupe → DynamoDB transaction (Job + dedupe + outbox)
                       ▼
     DynamoDB Stream (NOTIF inserts) → dispatcher → SQS FIFO → sender (concurrency 1, ≥1.1 s gap) → Telegram
```

Telegram commands: `/top` `/saved` `/applied` `/search` `/status` `/pause` `/resume [source]` `/mute` `/missed` `/digest` `/help`.

## Repository layout

| Path | What it contains |
|---|---|
| `config/` | Search profile (`profiles.ts`), source policies and cadence floors (`sources.ts`), all numeric limits (`limits.ts`) |
| `src/handlers/` | One file per Lambda |
| `src/sources/` | Adapters, verified against the live APIs on 2026-11-10 (see the header comment in each file) |
| `src/core/` | Matching, scoring, dedupe and the shared ingest pipeline |
| `src/scraping/` | HTTP client, domain gate, retry policy, circuit breaker, redirect/SSRF guard, robots.txt |
| `src/data/` | DynamoDB single-table access; the key layout is in `keys.ts` |
| `src/notifications/`, `src/telegram/` | Outbox delivery, formatting, bot commands |
| `test/` | Unit, contract (real fixtures in `test/fixtures`) and integration tests (DynamoDB Local) |
| `template.yaml` | SAM application |
| `scripts/bootstrap.yaml` | One-time stack: artifact bucket with a 14-day lifecycle rule, and the GitHub OIDC deploy role |

## Development

```bash
npm ci
npm run check                  # typecheck + lint + unit/contract tests
docker run --rm -p 8000:8000 amazon/dynamodb-local:3.3.2
npm run test:integration       # DynamoDB Local tests incl. end-to-end fixture → Telegram payload
npm run build                  # sam build (runs through npm so SAM finds the project's esbuild)
```

**Windows + this NVM installation:** SAM's esbuild workflow runs `npm.cmd`, but NVM here only ships `npm.exe`. For local `sam build`, put a one-line `npm.cmd` containing `@npm.exe %*` on your PATH. CI runs on Linux and doesn't need it.

## First deployment (Phase 0, §17)

1. **Check the AWS account plan.** Free and Paid plans differ (§14). Create AWS Budgets alerts at **$1 and $5** before deploying.
2. **Telegram:** create the bot with @BotFather, send it `/start`, and get your chat ID (for example from `https://api.telegram.org/bot<token>/getUpdates` before the webhook is set).
3. **Bootstrap stack** (artifact bucket and CI role), once per account and region:
   ```bash
   aws cloudformation deploy --template-file scripts/bootstrap.yaml --stack-name job-finder-bootstrap \
     --capabilities CAPABILITY_NAMED_IAM --parameter-overrides GitHubRepository=ahmedhesein1/Job-Hunt
   ```
4. **Secrets** (SSM Standard SecureString; prompts without echo): `scripts/put-secrets.sh --region <region>`. Add `--gmail` later for LinkedIn alerts.
5. **Deploy:** `npm run build && sam deploy --guided --s3-bucket <ArtifactBucketName>`. Use one region. Set `TelegramChatId`, `AlarmEmail` and, optionally, `UserAgentContact` (e.g. `mailto:you@example.com`, §5.2). Confirm the SNS subscription email.
   If the deploy fails on reserved concurrency (new accounts can have a low concurrency limit), redeploy with `SenderReservedConcurrency=0`. The single FIFO message group still serializes sending.
6. **Webhook:** `scripts/set-webhook.sh --region <region>`.
7. **Smoke test (§16):** `/status`, `/top`, then `aws lambda invoke --function-name job-finder-sync-source --payload '{"sourceId":"remoteok"}' --cli-binary-format raw-in-base64-out out.json`. A source's first run stores matches and sends one "connected" summary instead of a flood of alerts.

**CI/CD:** push to `main`. The workflow tests, then deploys through OIDC using GitHub environment `production`. Set repo secret `AWS_DEPLOY_ROLE_ARN` and repo variables `AWS_REGION`, `SAM_ARTIFACT_BUCKET`, `TELEGRAM_CHAT_ID`, `ALARM_EMAIL`, and optionally `USER_AGENT_CONTACT`, `GMAIL_ENABLED`, `SENDER_RESERVED_CONCURRENCY`.

## Sources: status and what blocks the disabled ones

| Source | State | Notes |
|---|---|---|
| Himalayas | on, daily | Apply must use Himalayas' `applicationLink`, and its jobs can't seed board discovery (no re-syndication) |
| Remote OK | on, 2 h | Must link back to the Remote OK listing (in every alert) |
| Jobicy | on, 65 min | Never more often than hourly; this is also enforced in code |
| Hacker News | on | Hourly for 72 h after the monthly thread opens, then daily; only new comments are fetched |
| Company boards | on | Greenhouse, Lever, Ashby, Workable, Recruitee, Teamtailor and Personio. Add boards in `config/sources.ts` `watchlistBoards`, or send `/missed <job URL>`. Recruitee needs a per-company token from 2027-02-10, after which its boards pause for review |
| Wuzzuf | on, 4 h | Official RSS feed (site footer). Terms allow personal, non-commercial use and forbid redistribution; this bot republishes nothing. The ~15 MB feed is streamed |
| Career pages | on, 2 h | Custom career sites in `config/sources.ts` `careerPages`. Jobs are read from schema.org `JobPosting` data; robots.txt is checked on every run; each job page is fetched once. Check a site's terms before adding it . Pages with no `JobPosting` data fall back to the page heading and text. robots.txt `Crawl-delay` is honoured, and hidden or `nofollow` links are never followed |
| Career pages (rendered) | on, 3 h | Career pages marked `render: true` load in headless Chromium (separate x86_64 function with a Chromium layer). It identifies itself honestly and follows the same robots.txt, per-host gate and stop-on-block rules |
| **LinkedIn search** | **on, 3 min** | Primary LinkedIn source. Scrapes LinkedIn's logged-out results endpoint (`jobs-guest/jobs/api/seeMoreJobPostings/search`) for every search in `config/linkedin-searches.ts`, with all its filters as URL parameters (`src/sources/linkedin/linkedIn-adapter.ts`). Cards are parsed by `src/sources/linkedin/search-page.ts`, then scored and deduplicated like any source. Cards have no description, so the Node.js must-have is judged from the title |
| LinkedIn saved pages | on, when you send one | `/linkedin` lists the saved searches in `config/linkedin-searches.ts` as buttons that open in **your** browser. Save the results page (Ctrl+S, after scrolling to the end of the list) and send the `.html` file to the bot: it is parsed (`src/sources/linkedin/search-page.ts`), scored and deduplicated like any source, and the bot replies with each job's score and reason. A sign-in or security-check page is reported and not imported |
| **Not supported** | — | SmartRecruiters (robots.txt blocks bots on its API), Breezy (terms forbid scraping), Bayt (robots.txt + Cloudflare challenge), Forasna (terms silent; needs written permission) |
| **LinkedIn alerts** | **off** | Needs Gmail OAuth (scope `gmail.readonly`) in SSM, plus saved examples of *your* alert emails as fixtures to validate the parser (§12). Then deploy with `GmailEnabled=true` |

When a source is paused for manual review (401, 403, CAPTCHA or a changed response shape), check the cause first, then send `/resume <source>`. Nothing ever retries around a block (§5.6).

## Cost and usage measurement

Costs are **measured**, not assumed. The modelled table below is only a starting point; `/cost` replaces it with measured figures.

```
EventBridge Scheduler ──cron 00:20 UTC──▶ maintenance {task:"cost"} ──▶ COST/DAY#<date> items (400-day TTL)
Telegram /cost ──▶ webhook ── reads COST/LATEST ──▶ reply
                         └─ stale (>26 h) or "/cost refresh" ──async invoke──▶ maintenance ──▶ report via outbox
every Lambda invocation ──▶ in-memory counters ──1 UpdateItem (ADD)──▶ USAGE#<date>/APP
```

**What is measured** (`src/cost/collect.ts`, free APIs only):

| Area | Measures | Read with |
|---|---|---|
| Lambda (every stack function) | invocations, errors, throttles, avg / p50 / p95 / max duration, GB-s (memory × duration), timeouts (max ≥ timeout) | `GetMetricStatistics`, `GetFunctionConfiguration` |
| DynamoDB | consumed RCU/WCU (table + GSIs), read/write throttles, provisioned units, table size | `GetMetricStatistics`, `DescribeTable` |
| SQS (all 3 queues) | sent, received, deleted, empty receives (Lambda long-polling), max visible, max age, request count | `GetMetricStatistics` |
| EventBridge Scheduler | invocation attempts, target errors, throttles, dropped | `GetMetricStatistics` |
| CloudWatch | log bytes ingested per group, stored bytes, retention, alarm and dashboard counts | `GetMetricStatistics`, `DescribeLogGroups`, `DescribeAlarms`, `ListDashboards` |
| Network | outgoing HTTP requests and downloaded bytes per host, browser navigations, network errors | in-app counters |
| Telegram | Bot API calls, messages sent, failures, 429s | in-app counters |
| Billing (actual) | budget limit, actual month-to-date spend, AWS forecast; Free plan credits | `budgets:DescribeBudget`, `freetier:GetAccountPlanState` |

Not used, on purpose: `GetMetricData` ($0.01 per 1,000 metrics), Cost Explorer ($0.01 per request), custom CloudWatch metrics ($0.30 each).

**Estimates** (`src/cost/estimate.ts`): eu-north-1 prices from the AWS Price List API (`config/pricing.ts`, dated). Each service's always-free allowance is applied separately, with a `safetyMarginPct` (20 %) on top. Low, expected and high scenarios come from the quietest, average and busiest measured day. The estimate is cost before credits, which is what the `job-hunt` budget (UnblendedCost) tracks. **The bill is the budget's "actual" figure, not the estimate.**

**Budget:** the existing `job-hunt` budget ($1/month) is read, never created or changed (stack parameter `BudgetName`). The daily run sends a warning when the projection, actual or AWS forecast reaches 80 % (`costSettings.warnAtBudgetPct`). Budget email alerts are configured in the AWS Budgets console on that budget.

**Dashboard:** `job-finder-usage` (stack output `UsageDashboardUrl`), 39 metrics, which keeps it within the free dashboard allowance.

**Measured so far** (2026-11-11, collector run read-only against the account): one partial day (2026-11-10, first deployment): 152 invocations, 198 RCU / 451 WCU consumed, 4,321 SQS empty receives; budget actual $0.00; Free plan, $140 credits until 2027-05-10. That is too little to project from: use `/cost` after a few full days.

**Modelled monthly use** (configuration-based, to be replaced by measurement):

| Service | Modelled use | Free allowance |
|---|---|---|
| Lambda requests | ~90k (boards 43k, LinkedIn orchestrator 14.4k, Gmail 14.4k if on, reconciler 8.6k, sources ~3k, sends/webhook ~2k) | 1M |
| Lambda compute | ~260–310k GB-s; headless browser and board ticks dominate. **The line that can exceed the free allowance** (each extra 10k GB-s ≈ $0.13) | 400k GB-s |
| DynamoDB | 15 RCU / 15 WCU provisioned, auto scaling off | 25 / 25, 25 GB |
| SQS | ~650k requests, mostly the Lambda poller's empty receives on the FIFO queue | 1M |
| Scheduler | ~90k | 14M |
| CloudWatch | 6 alarms, 1 dashboard, ~2.6k API calls, logs kept 14 days | 10 / 3 / 1M / 5 GB |
| S3 (SAM artifacts) | a few MB, 14-day lifecycle | may cost cents |

Modelled scenarios (before credits, +20 %): low **$0.00**, expected **$0.00**, high **≈ $0.10–$1.00**. The high case is reached only if Lambda compute goes over 400k GB-s.

**LinkedIn searches:** one schedule (`rate(3 minutes)`) invokes one orchestrator, which scrapes LinkedIn's search results for the 37 saved searches (outside Egypt, remote roles only). That is 480 scheduler invocations/day and 14,400/month. Each search is one request to the guest results endpoint (`limits.linkedinSearch.scrapePagesPerSearch`). Requests to linkedin.com go one at a time through the domain gate with a 250 ms gap (`limits.domainGate.hostMinGapMs`; other hosts keep 1.5 s), so all searches fit in the 45 s deadline (39 searches took ≈40 s, measured on 2026-11-13). A 5xx or network error is retried once inside the request (`scrapeTransientRetries`) and the search itself is not retried, so a failing search costs at most 2 requests. The cycle deadline cancels a request in flight (`DEADLINE`, retried next cycle). The search order rotates every cycle, so a search cut off by the deadline leads a later cycle. Cards LinkedIn returns are re-checked against the search's country, workplace, date posted and experience where the card states them; employment type and Easy Apply are applied by LinkedIn only (noted on the search outcome). A rate limit (HTTP 429, or LinkedIn's 999), a sign-in wall or a security check stops the cycle, and the host breaker cools linkedin.com down before the next one. Outcomes distinguish `SUCCESS`, `NO_RESULTS`, `RATE_LIMITED`, `BLOCKED`, `AUTH_REQUIRED`, `PROVIDER_STOPPED`, `DEADLINE` and `FAILED`. Alert emails (Gmail) and saved pages are additional LinkedIn inputs.

**LinkedIn schedule cost:** no AWS resources or paid APIs beyond the existing schedule and orchestrator. At 14,400 monthly Lambda invocations, request charges are below the 1M-request monthly free tier; compute depends on duration and total account usage. A conservative upper bound at 512 MB and the full 60-second timeout every invocation is 432,000 GB-s, about $0.53 above a remaining 400,000 GB-s free allowance (at $0.0000166667/GB-s). Each scraping cycle runs up to the 45 s deadline, so expect close to that bound. Scheduler and DynamoDB usage may add cost depending on the account's remaining free tiers and existing capacity, so the $1 account budget cannot be guaranteed from repository data alone. No budget was changed.

**New data items:** `USAGE#<day>/APP` (counters, ADD), `COST/DAY#<day>` (one collected day), `COST/LATEST` (billing snapshot); `SOURCE#linkedin-search/RUN#…` holds per-search outcomes. All are read by key or by a single-partition range query; no scans.

**New IAM (maintenance, read-only):** `cloudwatch:GetMetricStatistics|DescribeAlarms|ListDashboards`, `logs:DescribeLogGroups` (these support no resource scoping); `dynamodb:DescribeTable` on the table; `lambda:GetFunctionConfiguration` on `job-finder-*`; `budgets:ViewBudget` on `budget/job-hunt`; `freetier:GetAccountPlanState`. The webhook gets `lambda:InvokeFunction` on the maintenance function only.

**New environment variables:** `STACK_NAME` (all functions), `ACCOUNT_ID`, `BUDGET_NAME` (maintenance), `MAINTENANCE_FUNCTION` (webhook).

## Where the implementation adds detail the plan left open

- **Retry budget:** SQS `maxReceiveCount` is 10 rather than the plan's example of 5. Waiting for the 1.1 s send slot or for a Telegram 429 counts as a receive.
- **`/resume <source>`** clears a manual-review pause after a human has checked the cause; the plan requires manual review but doesn't name a command. Plain `/resume` still resumes instant alerts.
- **Discovered boards** start at a 180-minute interval and a `low` priority. Watchlist boards marked `high` move to 30 minutes after 24 stable checks.
- **`/missed` reports** are stored under the source's partition (`SOURCE#<id>` / `MISSED#…`, TTL 30 days). The URL is never fetched.
- **Jobs that pass the hard filters** but score below 60 are still stored (no alert), so `/search` and `/top` can find them.
