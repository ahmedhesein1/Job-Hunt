#!/usr/bin/env bash
# Registers the Lambda Function URL as the Telegram webhook with the secret_token header
# and only the update types the bot uses (§11). Reads secrets from SSM; prints none.
#
# Usage: scripts/set-webhook.sh [--region eu-central-1] [--stack job-finder]
set -euo pipefail

REGION_ARGS=()
STACK="job-finder"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION_ARGS=(--region "$2"); shift 2 ;;
    --stack) STACK="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

BOT_PARAM="${TELEGRAM_BOT_TOKEN_PARAM:-/jobfinder/telegram/bot-token}"
SECRET_PARAM="${TELEGRAM_WEBHOOK_SECRET_PARAM:-/jobfinder/telegram/webhook-secret}"

get_param() {
  aws ssm get-parameter "${REGION_ARGS[@]}" --name "$1" --with-decryption --query Parameter.Value --output text
}

URL="$(aws cloudformation describe-stacks "${REGION_ARGS[@]}" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='WebhookUrl'].OutputValue" --output text)"
[[ "$URL" == https://* ]] || { echo "WebhookUrl output not found on stack $STACK" >&2; exit 1; }

TOKEN="$(get_param "$BOT_PARAM")"
SECRET="$(get_param "$SECRET_PARAM")"

# Send parameters as JSON on stdin so the token/secret never appear in the process list.
RESPONSE="$(printf '{"url":"%s","secret_token":"%s","allowed_updates":["message","callback_query"],"drop_pending_updates":true,"max_connections":5}' "$URL" "$SECRET" \
  | curl -sS -X POST -H 'content-type: application/json' --data-binary @- "https://api.telegram.org/bot${TOKEN}/setWebhook")"

if [[ "$RESPONSE" == *'"ok":true'* ]]; then
  echo "Webhook set to $URL"
else
  echo "setWebhook failed: $RESPONSE" >&2
  exit 1
fi
