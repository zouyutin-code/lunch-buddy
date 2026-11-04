#!/bin/bash
# Uploads the phone-alert private key from .dev.vars to Cloudflare as the
# VAPID_PRIVATE_JWK secret, for the preview and production sites.
# Run from anywhere: bash tools/set-push-secret.sh
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .dev.vars ]; then echo "No .dev.vars file here; the key is missing." >&2; exit 1; fi
key() {
  node -e 'const l=require("fs").readFileSync(".dev.vars","utf8").split("\n").find(x=>x.startsWith("VAPID_PRIVATE_JWK="));process.stdout.write(JSON.parse(l.slice(18)))'
}
for env in preview production; do
  echo "Setting VAPID_PRIVATE_JWK for $env..."
  key | npx --yes wrangler@4 pages secret put VAPID_PRIVATE_JWK --project-name lunch-buddy --env "$env"
done
echo "Done. New deployments will be able to send phone alerts."
