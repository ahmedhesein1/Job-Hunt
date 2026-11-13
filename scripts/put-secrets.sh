#!/usr/bin/env bash
# Stores secrets as SSM Parameter Store *Standard* SecureString parameters encrypted with
# the AWS-managed key (§3, §14). Values are read from the terminal, never from arguments,
# so they do not end up in shell history.
#
# Usage: scripts/put-secrets.sh [--region eu-central-1] [--gmail]
set -euo pipefail

REGION_ARGS=()
GMAIL=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION_ARGS=(--region "$2"); shift 2 ;;
    --gmail) GMAIL=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

BOT_PARAM="${TELEGRAM_BOT_TOKEN_PARAM:-/jobfinder/telegram/bot-token}"
SECRET_PARAM="${TELEGRAM_WEBHOOK_SECRET_PARAM:-/jobfinder/telegram/webhook-secret}"
GMAIL_PARAM="${GMAIL_OAUTH_PARAM:-/jobfinder/gmail/oauth}"

put() {
  local name="$1" value="$2"
  aws ssm put-parameter "${REGION_ARGS[@]}" --name "$name" --type SecureString --tier Standard \
    --value "$value" --overwrite >/dev/null
  echo "stored $name"
}

read -r -s -p "Telegram bot token (from @BotFather): " BOT_TOKEN; echo
[[ "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || { echo "That does not look like a bot token." >&2; exit 1; }
put "$BOT_PARAM" "$BOT_TOKEN"

# Webhook secret: 1–256 chars of A-Z a-z 0-9 _ - (Telegram setWebhook secret_token).
WEBHOOK_SECRET="$(LC_ALL=C tr -dc 'A-Za-z0-9_-' </dev/urandom | head -c 64)"
put "$SECRET_PARAM" "$WEBHOOK_SECRET"

if [[ "$GMAIL" == true ]]; then
  read -r -p "Gmail OAuth client_id: " CLIENT_ID
  read -r -s -p "Gmail OAuth client_secret: " CLIENT_SECRET; echo
  read -r -s -p "Gmail OAuth refresh_token (scope gmail.readonly): " REFRESH_TOKEN; echo
  put "$GMAIL_PARAM" "$(printf '{"client_id":"%s","client_secret":"%s","refresh_token":"%s"}' "$CLIENT_ID" "$CLIENT_SECRET" "$REFRESH_TOKEN")"
fi

echo "Done. Next: deploy, then run scripts/set-webhook.sh."
