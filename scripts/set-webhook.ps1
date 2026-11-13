# Registers the Lambda Function URL as the Telegram webhook with the secret_token header
# and only the update types the bot uses (§11). Reads secrets from SSM; prints none.
# PowerShell equivalent of set-webhook.sh.
#
# Usage: .\scripts\set-webhook.ps1 -Region eu-north-1 [-Stack job-finder]
param(
  [Parameter(Mandatory = $true)][string]$Region,
  [string]$Stack = 'job-finder'
)
$ErrorActionPreference = 'Stop'

$aws = (Get-Command aws -ErrorAction SilentlyContinue).Source
if (-not $aws) { $aws = "$env:LOCALAPPDATA\Programs\Amazon\AWSCLIV2\aws.exe" }
if (-not (Test-Path $aws)) { throw 'AWS CLI not found. Install it or reopen the terminal.' }

$botParam = if ($env:TELEGRAM_BOT_TOKEN_PARAM) { $env:TELEGRAM_BOT_TOKEN_PARAM } else { '/jobfinder/telegram/bot-token' }
$secretParam = if ($env:TELEGRAM_WEBHOOK_SECRET_PARAM) { $env:TELEGRAM_WEBHOOK_SECRET_PARAM } else { '/jobfinder/telegram/webhook-secret' }

function Get-Param([string]$name) {
  $value = & $aws ssm get-parameter --region $Region --name $name --with-decryption --query Parameter.Value --output text
  if ($LASTEXITCODE -ne 0 -or -not $value) { throw "Could not read SSM parameter $name" }
  return $value.Trim()
}

$url = (& $aws cloudformation describe-stacks --region $Region --stack-name $Stack --query "Stacks[0].Outputs[?OutputKey=='WebhookUrl'].OutputValue" --output text).Trim()
if (-not $url.StartsWith('https://')) { throw "WebhookUrl output not found on stack $Stack" }

$token = Get-Param $botParam
$secret = Get-Param $secretParam

$body = @{
  url                  = $url
  secret_token         = $secret
  allowed_updates      = @('message', 'callback_query')
  drop_pending_updates = $true
  max_connections      = 5
} | ConvertTo-Json -Compress

try {
  $response = Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$token/setWebhook" -ContentType 'application/json' -Body $body
} catch {
  # Do not echo the request (it contains the token in the URL).
  throw "setWebhook request failed: $($_.Exception.Response.StatusCode) $($_.ErrorDetails.Message)"
}
if (-not $response.ok) { throw "setWebhook failed: $($response.description)" }
Write-Host "Webhook set to $url"

$info = Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/getWebhookInfo"
Write-Host ("Pending updates: {0}; last error: {1}" -f $info.result.pending_update_count, ($(if ($info.result.last_error_message) { $info.result.last_error_message } else { 'none' })))
