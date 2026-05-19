#!/bin/bash
# constellation-post.sh
# Phase 2 post-only client for Constellation telemetry.
# Collects this machine's snapshot, validates it, signs it, and POSTs it to the telemetry API.
#
# Required env:
#   CONSTELLATION_ENDPOINT    Base URL, e.g. https://constellation-api.example.workers.dev
#   CONSTELLATION_SECRET      Per-machine HMAC secret
#
# Optional env:
#   CONSTELLATION_MACHINE       Default: linux
#   CONSTELLATION_DEFAULT_NAME  Default: CLU
#   CONSTELLATION_SNAPSHOT_OUT  If set, copy the generated snapshot there for inspection

set -euo pipefail

REPO_DIR="${HOME}/.hermes/constellation"
MACHINE="${CONSTELLATION_MACHINE:-linux}"
DEFAULT_NAME="${CONSTELLATION_DEFAULT_NAME:-CLU}"
ENDPOINT="${CONSTELLATION_ENDPOINT:-}"
SECRET="${CONSTELLATION_SECRET:-}"

if [ -z "$ENDPOINT" ]; then
  echo "CONSTELLATION_ENDPOINT is required" >&2
  exit 2
fi

if [ -z "$SECRET" ]; then
  echo "CONSTELLATION_SECRET is required" >&2
  exit 2
fi

cd "$REPO_DIR" || { echo "Repo not found at $REPO_DIR" >&2; exit 1; }

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE"' EXIT

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Collecting Constellation snapshot for $MACHINE"
python3 collect_agents.py \
  --machine "$MACHINE" \
  --default-name "$DEFAULT_NAME" \
  -o "$BODY_FILE"

python3 validate_snapshot.py "$BODY_FILE" >/dev/null

if [ -n "${CONSTELLATION_SNAPSHOT_OUT:-}" ]; then
  cp "$BODY_FILE" "$CONSTELLATION_SNAPSHOT_OUT"
fi

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SIGNATURE="$(python3 signing.py \
  --secret "$SECRET" \
  --timestamp "$TIMESTAMP" \
  --machine "$MACHINE" \
  --body "$BODY_FILE")"

URL="${ENDPOINT%/}/v1/snapshots/${MACHINE}"

echo "[$TIMESTAMP] POST $URL"
curl --fail --silent --show-error \
  -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-Constellation-Machine: $MACHINE" \
  -H "X-Constellation-Timestamp: $TIMESTAMP" \
  -H "X-Constellation-Signature: $SIGNATURE" \
  --data-binary "@$BODY_FILE"

echo
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Snapshot posted"
