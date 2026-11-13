# Stores secrets as SSM Parameter Store *Standard* SecureString parameters encrypted with
# the AWS-managed key (§3, §14). The token is read without echo and never written to
# shell history. PowerShell equivalent of put-secrets.sh.
#
# Usage: .\scripts\put-secrets.ps1 -Region eu-north-1 [-Gmail]
param(
  [Parameter(Mandatory = $true)][string]$Region,
  [switch]$Gmail
)
$ErrorActionPreference = 'Stop'

$aws = (Get-Command aws -ErrorAction SilentlyContinue).Source
if (-not $aws) { $aws = "$env:LOCALAPPDATA\Programs\Amazon\AWSCLIV2\aws.exe" }
if (-not (Test-Path $aws)) { throw 'AWS CLI not found. Install it or reopen the terminal.' }

$botParam = if ($env:TELEGRAM_BOT_TOKEN_PARAM) { $env:TELEGRAM_BOT_TOKEN_PARAM } else { '/jobfinder/telegram/bot-token' }
$secretParam = if ($env:TELEGRAM_WEBHOOK_SECRET_PARAM) { $env:TELEGRAM_WEBHOOK_SECRET_PARAM } else { '/jobfinder/telegram/webhook-secret' }
$gmailParam = if ($env:GMAIL_OAUTH_PARAM) { $env:GMAIL_OAUTH_PARAM } else { '/jobfinder/gmail/oauth' }

function Read-Secret([string]$prompt) {
  $secure = Read-Host -Prompt $prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Put-Param([string]$name, [string]$value) {
  # Pass the value through a temp file so it never appears in the process command line.
  $tmp = New-TemporaryFile
  try {
    [IO.File]::WriteAllText($tmp.FullName, $value)
    & $aws ssm put-parameter --region $Region --name $name --type SecureString --tier Standard --value "file://$($tmp.FullName)" --overwrite | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to store $name" }
    Write-Host "stored $name"
  } finally { Remove-Item $tmp.FullName -Force }
}

$token = Read-Secret 'Telegram bot token (from @BotFather)'
if ($token -notmatch '^[0-9]+:[A-Za-z0-9_-]{30,}$') { throw 'That does not look like a bot token.' }
Put-Param $botParam $token

# Telegram secret_token: 1-256 chars of A-Z a-z 0-9 _ -
$chars = [char[]]'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
$bytes = New-Object byte[] 64
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$webhookSecret = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
Put-Param $secretParam $webhookSecret

if ($Gmail) {
  $clientId = Read-Host -Prompt 'Gmail OAuth client_id'
  $clientSecret = Read-Secret 'Gmail OAuth client_secret'
  $refreshToken = Read-Secret 'Gmail OAuth refresh_token (scope gmail.readonly)'
  $json = @{ client_id = $clientId; client_secret = $clientSecret; refresh_token = $refreshToken } | ConvertTo-Json -Compress
  Put-Param $gmailParam $json
}

Write-Host 'Done. Next: deploy (sam deploy --guided), then .\scripts\set-webhook.ps1'
