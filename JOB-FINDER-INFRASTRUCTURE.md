# Job Finder: Infrastructure Guide (AWS Free Tier)

The step-by-step setup for [`JOB-FINDER-PLAN-v3.md`](./JOB-FINDER-PLAN-v3.md). Follow the steps in order. Each step ends with **✅ Done when …** so you know it worked.

**Region:** `eu-central-1` (Frankfurt). It offers every service used here and is close to Egypt and to Telegram's servers.
**Profile name used below:** `jobfinder`
**Time needed:** about 3–4 hours the first time.

**Windows note:** the operator commands in this guide are written for Bash. Since this setup is being run from Windows PowerShell, use the PowerShell commands in sections 0, 4, 5, and 7 below for prerequisites, AWS login, Telegram setup, and secret storage. For the remaining Bash-only scripts, use Git Bash or WSL from the project directory; do not paste Bash syntax such as `export`, `read -rsp`, `$()`, or `chmod` into PowerShell.

---

## Contents

0. [Before you start](#0-before-you-start)
1. [Create the AWS account](#1-create-the-aws-account)
2. [Secure the root user](#2-secure-the-root-user)
3. [Cost guardrails](#3-cost-guardrails-do-not-skip)
4. [Admin user and CLI login](#4-admin-user-and-cli-login-no-access-keys)
5. [Create the Telegram bot](#5-create-the-telegram-bot)
6. [Gmail inbox for job alerts](#6-gmail-inbox-for-job-alerts)
7. [Store secrets in SSM Parameter Store](#7-store-secrets-in-ssm-parameter-store)
8. [Create the deploy artifacts bucket](#8-create-the-deploy-artifacts-bucket)
9. [Create the project](#9-create-the-project)
10. [The SAM template](#10-the-sam-template-templateyaml)
11. [Build and deploy](#11-build-and-deploy)
12. [Connect Telegram and run smoke tests](#12-connect-telegram-and-run-smoke-tests)
13. [CI/CD with GitHub Actions](#13-cicd-with-github-actions-no-stored-aws-keys)
14. [Day-to-day operations](#14-day-to-day-operations)
15. [Backup and restore](#15-backup-and-restore)
16. [Monthly free-tier check](#16-monthly-free-tier-check-5-minutes)
17. [Things that would cost money: never enable](#17-things-that-would-cost-money-never-enable)
18. [Troubleshooting](#18-troubleshooting)
19. [Tear everything down](#19-tear-everything-down)

---

## 0. Before you start

Install these on your machine:

| Tool | Version | Check |
|---|---|---|
| Node.js + npm | 24.x | `node -v` |
| AWS CLI v2 | **2.32.0 or newer** (needed for `aws login`) | `aws --version` |
| AWS SAM CLI | latest | `sam --version` |
| Git | any | `git --version` |
| Docker | any (only for local DynamoDB tests) | `docker --version` |
| OpenSSL | any | `openssl version` |

### Windows PowerShell installation and version checks

Run these from PowerShell. `winget` installs the generally available Windows packages; install SAM CLI from the official AWS MSI page linked below. Open a new PowerShell window after installs so PATH changes take effect.

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Git.Git -e
winget install --id Docker.DockerDesktop -e
winget install --id ShiningLight.OpenSSL.Light -e
irm https://awscli.amazonaws.com/v2/install.ps1 | iex
```

Install the latest 64-bit SAM CLI MSI from the [AWS SAM CLI Windows installation instructions](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), then verify:

```powershell
node -v
npm -v
aws --version
sam --version
git --version
docker --version
openssl version
```

If OpenSSL is installed but not on PATH, use its full path, for example `& 'C:\Program Files\OpenSSL-Win64\bin\openssl.exe' version`.

You also need:

- a GitHub account (a private repo is fine);
- Telegram on your phone;
- a **payment card**. AWS requires one at sign-up even if you never pay.

✅ **Done when** every command in the table prints a version.

---

## 1. Create the AWS account

1. Go to <https://aws.amazon.com/free> and choose **Create a free account**.
2. Enter your email and an account name, for example `jobfinder`, then verify the email.
3. **When asked to choose a plan, pick "Paid plan".**

   | | Free plan | Paid plan |
   |---|---|---|
   | Sign-up credits | yes ($100, plus up to $100 more from activities) | yes, the same |
   | Always Free services (Lambda, DynamoDB, …) | yes | yes |
   | After 6 months | **the account closes** unless you upgrade | keeps running |
   | What you pay | $0 | $0 while you stay inside Always Free, which this design does |

   This bot must run indefinitely, so the Free plan would just force an upgrade at month 6. Step 3 makes sure you hear about any charge long before it matters.
4. Enter your card and phone number, and choose the **Basic support** plan (free).

✅ **Done when** you can sign in to the AWS console as the root user.

---

## 2. Secure the root user

1. Console, top-right account menu → **Security credentials**.
2. **Multi-factor authentication (MFA)** → **Assign MFA device** → a passkey or an authenticator app.
3. **Do not** create access keys for the root user, ever.

✅ **Done when** signing in as root asks for MFA.

---

## 3. Cost guardrails (do not skip)

### 3.1 Free Tier alerts

Console → **Billing and Cost Management** → **Billing preferences** → **Alert preferences** → turn on **AWS Free Tier alerts** and enter your email.

### 3.2 Zero-spend budget

1. **Billing and Cost Management** → **Budgets** → **Create budget**.
2. Choose **Use a template (simplified)** → **Zero spend budget**.
3. Enter your email → **Create budget**.
4. Open the budget → **Edit** → **Advanced options** → **untick "Credits"**.
   By default, spending paid from your sign-up credits doesn't show as cost. Unticking it means you're alerted even when credits are covering a charge.

### 3.3 One-dollar safety budget (optional; your first two budgets are free)

**Create budget** → **Cost budget** → **Monthly**, amount **$1.00** → alerts at **100% actual** and **100% forecasted** → your email.

✅ **Done when** **Budgets** lists `My Zero-Spend Budget` (and `$1 safety`).

---

## 4. Admin user and CLI login (no access keys)

You'll work as an IAM user and sign in to the CLI with `aws login`, which issues short-lived credentials. No long-lived keys are stored on your machine.

1. Console → **IAM** → **Users** → **Create user**:
   - Name: `admin`
   - Tick **Provide user access to the AWS Management Console** and set a custom password.
   - **Attach policies directly** → `AdministratorAccess` → **Create user**.
2. Note the **console sign-in URL** shown (`https://<account-id>.signin.aws.amazon.com/console`). Sign out of root and sign in as `admin`.
3. As `admin`: **Security credentials** → **Assign MFA device**.
4. On your machine:

   ```powershell
   aws login --profile jobfinder          # opens the browser; sign in as admin
   aws configure set region eu-central-1 --profile jobfinder
   $env:AWS_PROFILE = 'jobfinder'
   aws sts get-caller-identity            # must show .../user/admin
   ```

5. Check your Lambda concurrency limit. New accounts can start low:

   ```bash
   aws lambda get-account-settings --query 'AccountLimit.ConcurrentExecutions'
   ```

   If it prints `10`, the design still works. To give yourself headroom, request 100 in **Service Quotas** → **AWS Lambda** → **Concurrent executions**; asking is free.

✅ **Done when** `aws sts get-caller-identity` prints your `admin` user's ARN.

> In every new PowerShell terminal, run `$env:AWS_PROFILE = 'jobfinder'`. In Git Bash, use `export AWS_PROFILE=jobfinder`. When the session expires, run `aws login --profile jobfinder` again.

---

## 5. Create the Telegram bot

1. In Telegram, open **@BotFather** → `/newbot` → choose a name and a username ending in `bot`.
2. Copy the **bot token**, which looks like `123456789:AA…`. It's a password: never commit it.
3. In @BotFather → `/setjoingroups` → choose your bot → **Disable**, so nobody can add it to a group.
4. Open your new bot and send it any message, for example `hi`.
5. Get your **chat ID**. This only works *before* the webhook is set in step 12:

   ```powershell
   $secureToken = Read-Host 'Bot token' -AsSecureString
   $token = [System.Net.NetworkCredential]::new('', $secureToken).Password
   try {
       $updates = Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/getUpdates"
       $update = $updates.result |
           Where-Object { $_.message.chat.type -eq 'private' -and $null -ne $_.message.chat.id } |
           Select-Object -First 1
       if ($update) { $update.message.chat.id }
       else { 'No private message found. Send your bot a message and run this again.' }
   } finally {
       Remove-Variable token, secureToken, updates, update -ErrorAction SilentlyContinue
   }
   ```

   PowerShell prints the matching message's numeric private chat ID. Save it for section 7. If the command reports no private message, send the bot another message and rerun it. Do this before step 12 sets the webhook; after a webhook is active, `getUpdates` is unavailable.
6. Generate the webhook secret:

   ```powershell
   & 'C:\Program Files\OpenSSL-Win64\bin\openssl.exe' rand -hex 32
   ```

   If OpenSSL is on PATH, `openssl rand -hex 32` also works. If it is installed elsewhere, substitute that executable's full path. Alternatively, generate an equivalent 32-byte secret with built-in .NET:

   ```powershell
   $bytes = [byte[]]::new(32)
   $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
   try { $rng.GetBytes($bytes); [Convert]::ToHexString($bytes).ToLowerInvariant() }
   finally { $rng.Dispose() }
   ```

   Keep the token and secret private. Do not paste them into chat or commit them to the repository. The chat ID is not an authentication secret, but keep it out of public source control too.

✅ **Done when** you have three values: **bot token**, **chat ID** and **webhook secret**.

---

## 6. Gmail inbox for job alerts

The bot reads job-alert emails from a **separate Gmail account**, so it never holds the password to your personal inbox.

### 6.1 Create the bot inbox

1. Create a new Gmail account, for example `yourname.jobalerts@gmail.com`.
2. **Google Account** → **Security** → turn on **2-Step Verification**.
3. **Security** → **App passwords** → create one named `jobfinder`. Copy the 16 characters and **remove the spaces**.
4. Gmail → **Settings** → **See all settings** → **Forwarding and POP/IMAP** → make sure **IMAP is enabled** (if the option is shown) → **Save**.
5. Create the label `jobbot/processed`.

### 6.2 Forward LinkedIn alerts to the bot inbox

LinkedIn sends alerts to your **main** email address. Forward them on:

1. In your main Gmail: **Settings** → **Forwarding and POP/IMAP** → **Add a forwarding address** → enter the bot address. Confirm the code that arrives in the bot inbox.
2. Wait until you receive one real LinkedIn job alert. Note its exact **From** address; check it on the email itself, don't assume it.
3. Create a filter: **From:** that address → **Forward to:** the bot inbox. Optionally also **Skip the Inbox**.

### 6.3 Create the LinkedIn alerts (up to 20)

On LinkedIn → **Jobs** → search → set the filters → **Set alert** → frequency **Daily**, notify by **Email**. Suggested alerts:

| Keywords | Location | Filters |
|---|---|---|
| Node.js | Egypt | Date posted: past 24 h |
| Backend Developer | Egypt | — |
| NestJS | Egypt | — |
| Node.js | Europe, Middle East and Africa | Remote |
| Backend Node.js | Worldwide | Remote |
| TypeScript Backend | Worldwide | Remote |

### 6.4 Wuzzuf alerts (fallback only)

Only needed if step 12 shows Wuzzuf blocks AWS. Create Wuzzuf alerts for your searches and forward them the same way as in 6.2.

✅ **Done when** you have the **bot Gmail address** and **app password**, and at least one LinkedIn alert email has reached the bot inbox.

---

## 7. Store secrets in SSM Parameter Store

Standard parameters are free. `SecureString` values are encrypted with the free AWS-managed key `aws/ssm`.

For PowerShell, use this interactive snippet to enter all five values without echoing the token, webhook secret, or Gmail app password or placing them in command history. Run it after section 4 has set `$env:AWS_PROFILE` and configured the `eu-central-1` region:

```powershell
$tokenSecure = Read-Host 'Telegram bot token' -AsSecureString
$token = [System.Net.NetworkCredential]::new('', $tokenSecure).Password
$chatId = Read-Host 'Telegram private chat ID'
$secretSecure = Read-Host 'Webhook secret' -AsSecureString
$webhookSecret = [System.Net.NetworkCredential]::new('', $secretSecure).Password
$gmailUser = Read-Host 'Bot Gmail address'
$appPasswordSecure = Read-Host 'Bot Gmail app password (remove spaces)' -AsSecureString
$appPassword = [System.Net.NetworkCredential]::new('', $appPasswordSecure).Password

try {
    aws ssm put-parameter --name /jobfinder/telegram/bot-token --type SecureString --value $token --overwrite
    aws ssm put-parameter --name /jobfinder/telegram/chat-id --type String --value $chatId --overwrite
    aws ssm put-parameter --name /jobfinder/telegram/webhook-secret --type SecureString --value $webhookSecret --overwrite
    aws ssm put-parameter --name /jobfinder/gmail/user --type String --value $gmailUser --overwrite
    aws ssm put-parameter --name /jobfinder/gmail/app-password --type SecureString --value $appPassword --overwrite
} finally {
    Remove-Variable tokenSecure, token, chatId, secretSecure, webhookSecret, gmailUser, appPasswordSecure, appPassword -ErrorAction SilentlyContinue
}

aws ssm get-parameters-by-path --path /jobfinder --recursive --query 'Parameters[].Name' --output table
```

The following Bash alternative remains useful if you are running this guide entirely from Git Bash/WSL; it prompts without echoing secret values:

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${AWS_PROFILE:?run: export AWS_PROFILE=jobfinder}"

put() { # $1 = name under /jobfinder, $2 = String|SecureString, $3 = prompt
  local value
  read -rsp "$3: " value; echo
  aws ssm put-parameter --name "/jobfinder/$1" --type "$2" --value "$value" --overwrite >/dev/null
  echo "  ✔ /jobfinder/$1"
}

put telegram/bot-token      SecureString "Telegram bot token"
put telegram/chat-id        String       "Your Telegram chat ID"
put telegram/webhook-secret SecureString "Webhook secret (from openssl rand -hex 32)"
put gmail/user              String       "Bot Gmail address"
put gmail/app-password      SecureString "Gmail app password (no spaces)"
```

Run it:

```bash
chmod +x put-secrets.sh && ./put-secrets.sh
aws ssm get-parameters-by-path --path /jobfinder --recursive --query 'Parameters[].Name'
```

> Optional: Himalayas offers a free API key that raises its rate limits. To store it: `aws ssm put-parameter --name /jobfinder/himalayas/api-key --type SecureString --value '<key>'`.

✅ **Done when** the last command lists all five parameter names.

---

## 8. Create the deploy artifacts bucket

`sam deploy` uploads your code bundles to S3. This bucket is the **only** resource outside Always Free; it costs a fraction of a cent a month.

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="jobfinder-artifacts-${ACCOUNT_ID}"

aws s3api create-bucket --bucket "$BUCKET" --region eu-central-1 \
  --create-bucket-configuration LocationConstraint=eu-central-1

# Delete artifacts older than 90 days so the bucket stays tiny
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration '{
  "Rules": [{ "ID": "expire-old-artifacts", "Status": "Enabled", "Filter": {},
              "Expiration": { "Days": 90 } }]
}'
echo "$BUCKET"
```

New S3 buckets block public access by default; keep it that way.

✅ **Done when** `aws s3 ls | grep jobfinder-artifacts` shows the bucket.

---

## 9. Create the project

```bash
mkdir job-finder && cd job-finder && git init
mkdir -p src/{handlers,sources,core,data,telegram,lib} config test/fixtures scripts .github/workflows

npm init -y
npm i grammy imapflow mailparser sax \
      @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-ssm @aws-sdk/client-sqs
npm i -D typescript esbuild vitest @types/node @types/aws-lambda @types/sax @types/mailparser
```

### 9.1 `package.json` scripts

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "build": "sam build",
    "deploy": "sam deploy"
  }
}
```

### 9.2 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "config", "test"]
}
```

### 9.3 `.gitignore`

```text
node_modules/
.aws-sam/
*.env
out.json
```

### 9.4 Minimum code so the first deploy works

**`src/lib/secrets.ts`** loads secrets once per cold start and caches them:

```typescript
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});
const NAMES = ['telegram/bot-token', 'telegram/chat-id', 'telegram/webhook-secret', 'gmail/user', 'gmail/app-password'];
let cache: Promise<Record<string, string>> | undefined;

export function secrets(): Promise<Record<string, string>> {
  cache ??= (async () => {
    const prefix = process.env.PARAM_PREFIX!;
    const out = await ssm.send(new GetParametersCommand({
      Names: NAMES.map((n) => `${prefix}/${n}`),
      WithDecryption: true,
    }));
    if (out.InvalidParameters?.length) {
      throw new Error(`Missing SSM parameters: ${out.InvalidParameters.join(', ')}`);
    }
    return Object.fromEntries(out.Parameters!.map((p) => [p.Name!.slice(prefix.length + 1), p.Value!]));
  })().catch((err) => { cache = undefined; throw err; });   // don't cache a failure
  return cache;
}
```

**`src/handlers/telegram-webhook.ts`** checks the secret, answers only you, and handles `/start` and `/status`:

```typescript
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { timingSafeEqual } from 'node:crypto';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { secrets } from '../lib/secrets';

let ready: Promise<{ bot: Bot; webhookSecret: string }> | undefined;

function init() {
  ready ??= (async () => {
    const s = await secrets();
    const ownerId = Number(s['telegram/chat-id']);
    const bot = new Bot(s['telegram/bot-token']);
    bot.use(async (ctx, next) => { if (ctx.from?.id === ownerId) await next(); }); // ignore everyone else
    bot.command('start', (ctx) => ctx.reply('Job Finder is running. Try /status.'));
    bot.command('status', (ctx) => ctx.reply('✅ Deployed. Sources arrive in slice 1.'));
    await bot.init();                                  // one getMe call per cold start
    return { bot, webhookSecret: s['telegram/webhook-secret'] };
  })().catch((err) => { ready = undefined; throw err; });
  return ready;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const handler = async (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> => {
  const { bot, webhookSecret } = await init();
  if (!sameSecret(event.headers['x-telegram-bot-api-secret-token'] ?? '', webhookSecret)) {
    return { statusCode: 401 };
  }
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '{}');
  try {
    await bot.handleUpdate(JSON.parse(raw) as Update);
  } catch (err) {
    console.error(JSON.stringify({ msg: 'update failed', error: String(err) }));
  }
  return { statusCode: 200 };   // always 200, so Telegram doesn't re-send in a loop
};
```

**Placeholders** for the other handlers. Replace each one in its roadmap slice.

```typescript
// src/handlers/sync.ts, sync-email.ts, digest.ts, maintenance.ts
export const handler = async (event: unknown): Promise<void> => {
  console.log(JSON.stringify({ msg: 'not implemented yet', event }));
};
```

```typescript
// src/handlers/notifier.ts
import type { DynamoDBStreamEvent, DynamoDBBatchResponse } from 'aws-lambda';
export const handler = async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
  console.log(JSON.stringify({ msg: 'not implemented yet', records: event.Records.length }));
  return { batchItemFailures: [] };
};
```

✅ **Done when** `npm run typecheck` passes.

---

## 10. The SAM template (`template.yaml`)

This one file creates **everything**: the table, 6 functions, 13 schedules, the dead-letter queue, the alarm email topic and 6 alarms.

```yaml
AWSTemplateFormatVersion: "2010-09-09"
Transform: AWS::Serverless-2016-10-31
Description: Job Finder - Telegram job alerts on the AWS Always Free tier

Parameters:
  AlarmEmail:
    Type: String
    Description: Email that receives alarm notifications (independent of Telegram)

Globals:
  Function:
    Runtime: nodejs24.x
    Architectures: [arm64]
    CodeUri: .
    MemorySize: 256
    Timeout: 60
    LoggingConfig:
      LogFormat: JSON
      ApplicationLogLevel: INFO
      SystemLogLevel: WARN
      LogGroup: !Ref LogGroup
    Environment:
      Variables:
        TABLE_NAME: !Ref Table
        PARAM_PREFIX: /jobfinder
        USER_TIMEZONE: Africa/Cairo
        NODE_OPTIONS: --enable-source-maps
    # For functions run by schedules (asynchronous): retry once, then park the event in the DLQ
    EventInvokeConfig:
      MaximumRetryAttempts: 1
      MaximumEventAgeInSeconds: 3600
    DeadLetterQueue:
      Type: SQS
      TargetArn: !GetAtt DeadLetterQueue.Arn

Resources:
  # ---------- Storage ----------
  Table:
    Type: AWS::DynamoDB::Table
    DeletionPolicy: Retain
    UpdateReplacePolicy: Retain
    Properties:
      TableName: jobfinder
      BillingMode: PROVISIONED                  # the free tier covers provisioned capacity only
      ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 10 }
      DeletionProtectionEnabled: true
      AttributeDefinitions:
        - { AttributeName: PK,     AttributeType: S }
        - { AttributeName: SK,     AttributeType: S }
        - { AttributeName: GSI1PK, AttributeType: S }
        - { AttributeName: GSI1SK, AttributeType: S }
        - { AttributeName: GSI2PK, AttributeType: S }
        - { AttributeName: GSI2SK, AttributeType: S }
      KeySchema:
        - { AttributeName: PK, KeyType: HASH }
        - { AttributeName: SK, KeyType: RANGE }
      GlobalSecondaryIndexes:
        - IndexName: GSI1                       # jobs by user status, newest first
          KeySchema:
            - { AttributeName: GSI1PK, KeyType: HASH }
            - { AttributeName: GSI1SK, KeyType: RANGE }
          Projection:
            ProjectionType: INCLUDE
            NonKeyAttributes: [title, company, score, applyUrl, sourceId, skills, publishedAt, location]
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
        - IndexName: GSI2                       # sparse digest queue, best score first
          KeySchema:
            - { AttributeName: GSI2PK, KeyType: HASH }
            - { AttributeName: GSI2SK, KeyType: RANGE }
          Projection:
            ProjectionType: INCLUDE
            NonKeyAttributes: [title, company, score, applyUrl, sourceId, skills, publishedAt, location]
          ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
      TimeToLiveSpecification: { AttributeName: ttl, Enabled: true }
      StreamSpecification: { StreamViewType: NEW_IMAGE }
      # Total capacity: 20 read + 20 write units. The free tier allows 25 + 25. Keep auto scaling OFF.

  DeadLetterQueue:
    Type: AWS::SQS::Queue
    Properties:
      MessageRetentionPeriod: 1209600           # 14 days

  LogGroup:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: /jobfinder/lambda
      RetentionInDays: 14                       # keeps log storage inside the free 5 GB

  AlarmTopic:
    Type: AWS::SNS::Topic
    Properties:
      Subscription:
        - { Protocol: email, Endpoint: !Ref AlarmEmail }

  # ---------- Functions ----------
  SyncFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: sync.handler
      MemorySize: 512
      Timeout: 600
      Policies:
        - DynamoDBCrudPolicy: { TableName: !Ref Table }
        - SSMParameterReadPolicy: { ParameterName: jobfinder/* }
      Events:
        # Each interval is the fastest the source allows (plan §4.1). Do not poll faster.
        Wuzzuf:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: rate(2 hours)
            FlexibleTimeWindow: { Mode: FLEXIBLE, MaximumWindowInMinutes: 10 }
            Input: '{"source":"wuzzuf-rss"}'
        Himalayas:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: rate(2 hours)
            FlexibleTimeWindow: { Mode: FLEXIBLE, MaximumWindowInMinutes: 10 }
            Input: '{"source":"himalayas"}'
        Jobicy:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: rate(1 hour)       # Jobicy's stated maximum
            FlexibleTimeWindow: { Mode: FLEXIBLE, MaximumWindowInMinutes: 10 }
            Input: '{"source":"jobicy"}'
        RemoteOk:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: rate(1 hour)
            FlexibleTimeWindow: { Mode: FLEXIBLE, MaximumWindowInMinutes: 10 }
            Input: '{"source":"remoteok"}'
        HackerNewsLaunchDays:                       # the monthly thread fills up on days 1-3
          Type: ScheduleV2
          Properties:
            ScheduleExpression: cron(0 * 1-3 * ? *)
            ScheduleExpressionTimezone: Africa/Cairo
            FlexibleTimeWindow: { Mode: FLEXIBLE, MaximumWindowInMinutes: 10 }
            Input: '{"source":"hn"}'
        HackerNewsDaily:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: cron(0 10 4-31 * ? *)
            ScheduleExpressionTimezone: Africa/Cairo
            FlexibleTimeWindow: { Mode: FLEXIBLE, MaximumWindowInMinutes: 10 }
            Input: '{"source":"hn"}'
        CompanyBoards:                              # the freshest source: companies post here first
          Type: ScheduleV2
          Properties:
            ScheduleExpression: rate(30 minutes)
            FlexibleTimeWindow: { Mode: FLEXIBLE, MaximumWindowInMinutes: 5 }
            Input: '{"source":"ats"}'
    Metadata:
      BuildMethod: esbuild
      BuildProperties: { EntryPoints: [src/handlers/sync.ts], Minify: true, Sourcemap: true, Target: es2023 }

  SyncEmailFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: sync-email.handler
      Timeout: 120
      Policies:
        - DynamoDBCrudPolicy: { TableName: !Ref Table }
        - SSMParameterReadPolicy: { ParameterName: jobfinder/* }
      Events:
        Every10Minutes:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: rate(10 minutes)
            FlexibleTimeWindow: { Mode: FLEXIBLE, MaximumWindowInMinutes: 3 }
    Metadata:
      BuildMethod: esbuild
      BuildProperties: { EntryPoints: [src/handlers/sync-email.ts], Minify: true, Sourcemap: true, Target: es2023 }

  NotifierFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: notifier.handler
      Timeout: 120
      Policies:
        - DynamoDBCrudPolicy: { TableName: !Ref Table }
        - SSMParameterReadPolicy: { ParameterName: jobfinder/* }
      Events:
        Outbox:
          Type: DynamoDB
          Properties:
            Stream: !GetAtt Table.StreamArn
            StartingPosition: LATEST
            BatchSize: 10
            MaximumBatchingWindowInSeconds: 5
            MaximumRetryAttempts: 5
            BisectBatchOnFunctionError: true
            FunctionResponseTypes: [ReportBatchItemFailures]
            DestinationConfig:
              OnFailure: { Type: SQS, Destination: !GetAtt DeadLetterQueue.Arn }
            FilterCriteria:                     # wake only for NEW alert items, nothing else
              Filters:
                - Pattern: '{"eventName":["INSERT"],"dynamodb":{"Keys":{"PK":{"S":[{"prefix":"NOTIF#"}]}}}}'
    Metadata:
      BuildMethod: esbuild
      BuildProperties: { EntryPoints: [src/handlers/notifier.ts], Minify: true, Sourcemap: true, Target: es2023 }

  DigestFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: digest.handler
      Policies:
        - DynamoDBCrudPolicy: { TableName: !Ref Table }
        - SSMParameterReadPolicy: { ParameterName: jobfinder/* }
      Events:
        Morning:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: cron(0 9 * * ? *)
            ScheduleExpressionTimezone: Africa/Cairo
            FlexibleTimeWindow: { Mode: "OFF" }
        Evening:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: cron(0 18 * * ? *)
            ScheduleExpressionTimezone: Africa/Cairo
            FlexibleTimeWindow: { Mode: "OFF" }
    Metadata:
      BuildMethod: esbuild
      BuildProperties: { EntryPoints: [src/handlers/digest.ts], Minify: true, Sourcemap: true, Target: es2023 }

  TelegramWebhookFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: telegram-webhook.handler
      Timeout: 25
      FunctionUrlConfig:
        AuthType: NONE                          # protected by Telegram's secret-token header + chat-ID check
      Policies:
        - DynamoDBCrudPolicy: { TableName: !Ref Table }
        - SSMParameterReadPolicy: { ParameterName: jobfinder/* }
    Metadata:
      BuildMethod: esbuild
      BuildProperties: { EntryPoints: [src/handlers/telegram-webhook.ts], Minify: true, Sourcemap: true, Target: es2023 }

  MaintenanceFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: maintenance.handler
      MemorySize: 512
      Timeout: 300
      Environment:
        Variables:
          DLQ_URL: !Ref DeadLetterQueue
      Policies:
        - DynamoDBCrudPolicy: { TableName: !Ref Table }
        - SSMParameterReadPolicy: { ParameterName: jobfinder/* }
        - SQSPollerPolicy: { QueueName: !GetAtt DeadLetterQueue.QueueName }
      Events:
        DailyHealth:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: cron(0 21 * * ? *)
            ScheduleExpressionTimezone: Africa/Cairo
            FlexibleTimeWindow: { Mode: "OFF" }
            Input: '{"task":"health"}'
        WeeklyReport:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: cron(0 10 ? * FRI *)
            ScheduleExpressionTimezone: Africa/Cairo
            FlexibleTimeWindow: { Mode: "OFF" }
            Input: '{"task":"weekly-report"}'
        WeeklyBackup:
          Type: ScheduleV2
          Properties:
            ScheduleExpression: cron(0 3 ? * SUN *)
            ScheduleExpressionTimezone: Africa/Cairo
            FlexibleTimeWindow: { Mode: "OFF" }
            Input: '{"task":"backup"}'
    Metadata:
      BuildMethod: esbuild
      BuildProperties: { EntryPoints: [src/handlers/maintenance.ts], Minify: true, Sourcemap: true, Target: es2023 }

  # ---------- Alarms (6 of the 10 free) → email ----------
  LambdaErrorsAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmDescription: Lambda functions failed 3+ times in an hour
      Namespace: AWS/Lambda
      MetricName: Errors                        # no dimensions = all functions in the account
      Statistic: Sum
      Period: 3600
      EvaluationPeriods: 1
      Threshold: 3
      ComparisonOperator: GreaterThanOrEqualToThreshold
      TreatMissingData: notBreaching
      AlarmActions: [!Ref AlarmTopic]

  LambdaThrottlesAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmDescription: Lambda was throttled (concurrency limit reached)
      Namespace: AWS/Lambda
      MetricName: Throttles
      Statistic: Sum
      Period: 3600
      EvaluationPeriods: 1
      Threshold: 1
      ComparisonOperator: GreaterThanOrEqualToThreshold
      TreatMissingData: notBreaching
      AlarmActions: [!Ref AlarmTopic]

  SyncHeartbeatAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmDescription: sync has not run for 2 hours (normally runs every 30 min) - the bot is effectively down
      Namespace: AWS/Lambda
      MetricName: Invocations
      Dimensions: [{ Name: FunctionName, Value: !Ref SyncFunction }]
      Statistic: Sum
      Period: 3600
      EvaluationPeriods: 2
      Threshold: 1
      ComparisonOperator: LessThanThreshold
      TreatMissingData: breaching               # no data = no runs = alarm
      AlarmActions: [!Ref AlarmTopic]
      OKActions: [!Ref AlarmTopic]

  NotifierLagAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmDescription: Alerts are stuck - the notifier is more than 10 minutes behind
      Namespace: AWS/Lambda
      MetricName: IteratorAge
      Dimensions: [{ Name: FunctionName, Value: !Ref NotifierFunction }]
      Statistic: Maximum
      Period: 300
      EvaluationPeriods: 3
      Threshold: 600000
      ComparisonOperator: GreaterThanThreshold
      TreatMissingData: notBreaching
      AlarmActions: [!Ref AlarmTopic]

  DeadLetterAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmDescription: Something failed permanently and is waiting in the dead-letter queue
      Namespace: AWS/SQS
      MetricName: ApproximateNumberOfMessagesVisible
      Dimensions: [{ Name: QueueName, Value: !GetAtt DeadLetterQueue.QueueName }]
      Statistic: Maximum
      Period: 300
      EvaluationPeriods: 1
      Threshold: 1
      ComparisonOperator: GreaterThanOrEqualToThreshold
      TreatMissingData: notBreaching
      AlarmActions: [!Ref AlarmTopic]

  TableWriteThrottleAlarm:
    Type: AWS::CloudWatch::Alarm
    Properties:
      AlarmDescription: DynamoDB writes are throttling a lot - spread the schedules or lower batch sizes
      Namespace: AWS/DynamoDB
      MetricName: WriteThrottleEvents
      Dimensions: [{ Name: TableName, Value: !Ref Table }]
      Statistic: Sum
      Period: 3600
      EvaluationPeriods: 3
      Threshold: 200
      ComparisonOperator: GreaterThanThreshold
      TreatMissingData: notBreaching
      AlarmActions: [!Ref AlarmTopic]

Outputs:
  WebhookUrl:
    Value: !GetAtt TelegramWebhookFunctionUrl.FunctionUrl
  TableName:
    Value: !Ref Table
  DeadLetterQueueUrl:
    Value: !Ref DeadLetterQueue
```

**Notes on the template:**

- **Schedule jitter:** `FlexibleTimeWindow` lets AWS start each run up to N minutes late. That's free jitter, so the bot doesn't hit sites on a perfectly regular clock.
- **The webhook URL:** SAM creates it with `AuthType: NONE` plus both permissions that function URLs require since October 2025 (`lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`). Use a current SAM CLI.
- **The notifier filter:** only *new* `NOTIF#` items wake the notifier. Changes, TTL deletions and job writes don't, so the function isn't invoked for nothing.
- **Deletion safety:** the table has `DeletionPolicy: Retain` and deletion protection. Deleting the stack never deletes your data.

### 10.1 `samconfig.toml`

Replace `<ACCOUNT_ID>` and the email address:

```toml
version = 0.1

[default.global.parameters]
stack_name = "jobfinder"
region = "eu-central-1"

[default.build.parameters]
cached = true
parallel = true

[default.deploy.parameters]
s3_bucket = "jobfinder-artifacts-<ACCOUNT_ID>"
s3_prefix = "jobfinder"
capabilities = "CAPABILITY_IAM"
confirm_changeset = true
parameter_overrides = "AlarmEmail=you@example.com"
```

✅ **Done when** `sam validate --lint` prints `template.yaml is a valid SAM Template`.

---

## 11. Build and deploy

```bash
export AWS_PROFILE=jobfinder
sam validate --lint
sam build
sam deploy            # shows the change set; type y to apply
```

1. The first deploy takes about 3–5 minutes.
2. **Check your email.** SNS sent a "Subscription Confirmation" message. **Click the confirm link**, or alarm emails will never arrive.
3. Get the webhook URL:

   ```bash
   aws cloudformation describe-stacks --stack-name jobfinder \
     --query "Stacks[0].Outputs[?OutputKey=='WebhookUrl'].OutputValue" --output text
   ```

✅ **Done when** the stack shows `CREATE_COMPLETE`, you've confirmed the SNS email, and you have the webhook URL.

---

## 12. Connect Telegram and run smoke tests

### 12.1 Register the webhook and commands

Create `scripts/set-webhook.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${AWS_PROFILE:?run: export AWS_PROFILE=jobfinder}"

URL=$(aws cloudformation describe-stacks --stack-name jobfinder \
  --query "Stacks[0].Outputs[?OutputKey=='WebhookUrl'].OutputValue" --output text)
TOKEN=$(aws ssm get-parameter --name /jobfinder/telegram/bot-token --with-decryption --query Parameter.Value --output text)
SECRET=$(aws ssm get-parameter --name /jobfinder/telegram/webhook-secret --with-decryption --query Parameter.Value --output text)
API="https://api.telegram.org/bot${TOKEN}"

curl -sS "$API/setWebhook" \
  --data-urlencode "url=${URL}" \
  --data-urlencode "secret_token=${SECRET}" \
  --data-urlencode 'allowed_updates=["message","callback_query"]' \
  -d drop_pending_updates=true \
  -d max_connections=5
echo

curl -sS "$API/setMyCommands" -H 'Content-Type: application/json' -d '{"commands":[
  {"command":"top","description":"Best open jobs"},
  {"command":"saved","description":"Saved jobs"},
  {"command":"applied","description":"Jobs you applied to"},
  {"command":"search","description":"Search stored jobs"},
  {"command":"status","description":"Sources and health"},
  {"command":"pause","description":"Pause instant alerts"},
  {"command":"resume","description":"Resume instant alerts"},
  {"command":"digest","description":"Send the digest now"},
  {"command":"help","description":"All commands"}
]}'
echo

curl -sS "$API/getWebhookInfo"; echo
```

```bash
chmod +x scripts/set-webhook.sh && ./scripts/set-webhook.sh
```

`max_connections=5` caps how many updates Telegram delivers at the same time, which keeps the bot inside a low Lambda concurrency limit.

### 12.2 Smoke tests

| # | Test | Expected |
|---|---|---|
| 1 | Send `/start` to your bot | "Job Finder is running. Try /status." |
| 2 | Send `/status` | "✅ Deployed…" |
| 3 | From **another** Telegram account, send `/start` | No reply (only you are served) |
| 4 | `getWebhookInfo` (printed by the script) | `pending_update_count: 0` and no `last_error_message` |
| 5 | Run one function by hand: `aws lambda invoke --function-name $(aws cloudformation describe-stack-resource --stack-name jobfinder --logical-resource-id SyncFunction --query StackResourceDetail.PhysicalResourceId --output text) --cli-binary-format raw-in-base64-out --payload '{"source":"wuzzuf-rss"}' out.json && cat out.json` | `null` (the placeholder ran) |
| 6 | Watch the logs: `sam logs --stack-name jobfinder --tail` | JSON log lines appear |
| 7 | **Can AWS reach Wuzzuf?** Open **CloudShell** (free; the `>_` icon in the console) and run `curl -s -o /dev/null -w '%{http_code}\n' https://wuzzuf.net/feeds/all-jobs.xml` | `200` means the RSS source will work. `403` means use Wuzzuf alert emails instead (step 6.4) |

Test 7 is a strong hint, not a guarantee: CloudShell and Lambda both run on AWS addresses. The definitive answer is the first real `sync` run in slice 1. Check its `RUN#` record or its logs.

✅ **Done when** tests 1–4 pass and you know test 7's result.

---

## 13. CI/CD with GitHub Actions (no stored AWS keys)

GitHub gets **temporary** credentials through OIDC, so there's no AWS key in GitHub secrets.

### 13.1 Create the identity provider (once per account)

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

### 13.2 Create the deploy role

In both files, replace `<ACCOUNT_ID>` and `<GITHUB_USER>`.

`trust.json` allows only the `main` branch of your repo to use the role:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:<GITHUB_USER>/job-finder:ref:refs/heads/main"
      }
    }
  }]
}
```

`deploy-policy.json` grants only what `sam deploy` needs, only in `eu-central-1`. It can manage only roles whose names start with `jobfinder-`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DeployServicesInRegion",
      "Effect": "Allow",
      "Action": ["cloudformation:*", "lambda:*", "dynamodb:*", "scheduler:*", "sqs:*", "sns:*", "logs:*", "cloudwatch:*"],
      "Resource": "*",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "eu-central-1" } }
    },
    {
      "Sid": "Artifacts",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": ["arn:aws:s3:::jobfinder-artifacts-<ACCOUNT_ID>", "arn:aws:s3:::jobfinder-artifacts-<ACCOUNT_ID>/*"]
    },
    {
      "Sid": "StackRolesOnly",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole", "iam:TagRole", "iam:UntagRole",
        "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy",
        "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:UpdateAssumeRolePolicy",
        "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:PassRole"
      ],
      "Resource": "arn:aws:iam::<ACCOUNT_ID>:role/jobfinder-*"
    }
  ]
}
```

```bash
aws iam create-role --role-name jobfinder-github-deploy --assume-role-policy-document file://trust.json
aws iam put-role-policy --role-name jobfinder-github-deploy --policy-name deploy --policy-document file://deploy-policy.json
```

### 13.3 The workflow (`.github/workflows/deploy.yml`)

```yaml
name: deploy
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  id-token: write      # required for OIDC
  contents: read

concurrency:
  group: deploy
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - name: Install SAM CLI
        run: pipx install aws-sam-cli
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::<ACCOUNT_ID>:role/jobfinder-github-deploy
          aws-region: eu-central-1
      - run: sam build
      - run: sam deploy --no-confirm-changeset --no-fail-on-empty-changeset
```

> The action versions shown are the current major versions as of November 2026. Dependabot can keep them updated for free.

### 13.4 Push

```bash
git add . && git commit -m "Job Finder skeleton"
git branch -M main
git remote add origin git@github.com:<GITHUB_USER>/job-finder.git
git push -u origin main
```

✅ **Done when** the **Actions** tab shows a green `deploy` run.

---

## 14. Day-to-day operations

| I want to… | Do this |
|---|---|
| See live logs | `sam logs --stack-name jobfinder --tail` |
| See one function's logs | `sam logs --stack-name jobfinder -n SyncFunction --tail` |
| Run a source now | `aws lambda invoke --function-name <SyncFunction name> --cli-binary-format raw-in-base64-out --payload '{"source":"himalayas"}' out.json` |
| Check bot health | `/status` in Telegram |
| Pause one source by hand | `aws dynamodb update-item --table-name jobfinder --key '{"PK":{"S":"SOURCE#remoteok"},"SK":{"S":"STATE"}}' --update-expression 'SET pausedUntil = :t' --expression-attribute-values '{":t":{"S":"2099-01-01T00:00:00Z"}}'` |
| Un-pause it | the same command with `REMOVE pausedUntil` as the update expression and without `--expression-attribute-values` |
| Inspect failed events | `aws sqs receive-message --queue-url <DeadLetterQueueUrl> --max-number-of-messages 10` |
| Change search profiles | edit `config/profiles.ts` → push to `main` → CI deploys |
| Rotate the bot token | @BotFather `/revoke` → `./scripts/put-secrets.sh` → `./scripts/set-webhook.sh`. Functions pick up the new value on their next cold start; redeploying forces it |

---

## 15. Backup and restore

- **Automatic:** every Sunday at 03:00 Cairo time, `maintenance` sends `jobfinder-backup-YYYY-MM-DD.json.gz` to your Telegram chat. It holds your saved and applied jobs with their history, your companies and your settings. Bots can send files up to 50 MB, and this stays far below that.
- **Why not DynamoDB's built-in backups?** Point-in-time recovery and on-demand backups are **not free**. Job listings themselves can be fetched again; only *your* data needs keeping, and that's small.
- **Restore** (written in slice 5): `npx tsx scripts/restore.ts jobfinder-backup-YYYY-MM-DD.json.gz` batch-writes the items back into the table.
- **Accidental deletion:** the table has deletion protection, and the stack keeps it (`Retain`) even if you delete the stack.

---

## 16. Monthly free-tier check (5 minutes)

On the first of each month:

1. **Billing and Cost Management** → **Free Tier**. Every service should be well under 100%.
2. **Bills** → the current month should read **$0.00**. The S3 line may show `$0.00`, with less than a cent of usage.
3. **Budgets** → no alerts fired.
4. **CloudWatch** → **Alarms** → all `OK`.
5. Telegram `/status` → every source ran recently.

---

## 17. Things that would cost money: never enable

| Don't | Why it costs | Use instead |
|---|---|---|
| Put Lambda in a VPC, or create a NAT Gateway | about $35+/month for NAT | Lambda outside a VPC (the default) |
| Secrets Manager | $0.40 per secret per month | SSM Parameter Store standard parameters |
| DynamoDB **on-demand** mode, or **auto scaling** above 25 units | outside the free tier | provisioned 20/20, fixed |
| DynamoDB point-in-time recovery or on-demand backups | billed per GB | the weekly Telegram backup |
| RDS, Aurora, ElastiCache, EC2, Fargate | not in Always Free | DynamoDB + Lambda |
| API Gateway | not in Always Free | Lambda Function URL |
| Customer-managed KMS keys | $1 per key per month | the AWS-managed `aws/ssm` key |
| Provisioned concurrency, or SnapStart | billed per hour | normal on-demand Lambda |
| More than 10 alarms, or custom metrics | beyond the free 10 | health checks write to DynamoDB instead |
| Heavy CloudWatch Logs Insights queries | billed per GB scanned | `sam logs` |
| Log groups without retention | storage grows forever | 14-day retention (already set) |

---

## 18. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot doesn't reply | Webhook not set, or the secret doesn't match | Run `./scripts/set-webhook.sh` and read `last_error_message` in its output |
| `getWebhookInfo` shows **403 Forbidden** | The function URL's resource policy is missing `lambda:InvokeFunction` (required since Oct 2025) | Update SAM CLI, then `sam build && sam deploy`. Check with `aws lambda get-policy --function-name <webhook fn>`: there must be two statements |
| `getWebhookInfo` shows **401** | The secret token differs between SSM and Telegram | Re-run `./scripts/set-webhook.sh` |
| `Missing SSM parameters` in logs | A parameter name has a typo, or a value is missing | `aws ssm get-parameters-by-path --path /jobfinder --recursive` |
| Wuzzuf `sync` logs HTTP 403 | Cloudflare blocks AWS addresses | Disable that source in code and use Wuzzuf alert emails (step 6.4) |
| `sync-email` logs `AUTHENTICATIONFAILED` | Wrong or revoked app password, or Google blocked a sign-in from a new location | Check the bot Gmail's **Security** alerts and approve the sign-in; regenerate the app password; if it keeps happening, switch to the Gmail API (OAuth, free) |
| Lots of `ProvisionedThroughputExceededException` | First runs write many jobs at once | Normal at the start: the SDK retries. If it persists, spread the schedules further apart |
| Throttles alarm fires | The Lambda concurrency limit is 10 | Request a higher limit (step 4.5) |
| `sam build` says esbuild was not found | esbuild isn't installed in the project | `npm i -D esbuild` |
| Budget alert email | Something unexpected is being billed | **Bills** → open the service line → compare with §17 |
| Stack is in `UPDATE_ROLLBACK_FAILED` | A rollback needed a deleted artifact or resource | `aws cloudformation continue-update-rollback --stack-name jobfinder`, then deploy again |

---

## 19. Tear everything down

```bash
export AWS_PROFILE=jobfinder
TOKEN=$(aws ssm get-parameter --name /jobfinder/telegram/bot-token --with-decryption --query Parameter.Value --output text)
curl -sS "https://api.telegram.org/bot${TOKEN}/deleteWebhook"

sam delete --stack-name jobfinder                  # removes everything except the table (Retain)

aws dynamodb update-table --table-name jobfinder --no-deletion-protection-enabled
aws dynamodb delete-table --table-name jobfinder

aws ssm delete-parameters --names /jobfinder/telegram/bot-token /jobfinder/telegram/chat-id \
  /jobfinder/telegram/webhook-secret /jobfinder/gmail/user /jobfinder/gmail/app-password

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws s3 rb "s3://jobfinder-artifacts-${ACCOUNT_ID}" --force

aws iam delete-role-policy --role-name jobfinder-github-deploy --policy-name deploy
aws iam delete-role --role-name jobfinder-github-deploy
aws iam delete-open-id-connect-provider \
  --open-id-connect-provider-arn "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
```

Finally, delete the budgets (**Billing** → **Budgets**) and, if you want, close the account (**Account** → **Close account**).
