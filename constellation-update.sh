#!/bin/bash
# constellation-update.sh
# Collects local Hermes agent data and pushes to GitHub.
# Run via Hermes cron or manually.
#
# Usage:
#   bash constellation-update.sh
#
# Setup:
#   1. Clone the repo: git clone https://github.com/CountZer0/constellation.git ~/.hermes/constellation
#   2. Make executable: chmod +x ~/.hermes/constellation/constellation-update.sh
#   3. Set up Hermes cron: /cron create → schedule "every 1h" → prompt "bash ~/.hermes/constellation/constellation-update.sh"

set -euo pipefail

REPO_DIR="${HOME}/.hermes/constellation"
MACHINE="${1:-mac}"           # Pass 'win' on Windows machines
DEFAULT_NAME="${2:-Count Zer0}" # Pass 'CLU' on Windows

cd "$REPO_DIR" || { echo "Repo not found at $REPO_DIR"; exit 1; }

echo "[$(date)] Collecting agent data for machine: $MACHINE"

# Collect this machine's data
python3 collect_agents.py \
  --machine "$MACHINE" \
  --default-name "$DEFAULT_NAME" \
  -o "${MACHINE}_agents.json"

# Merge all available machine JSONs
MERGE_INPUTS=()
for f in *_agents.json; do
  [ -f "$f" ] && MERGE_INPUTS+=("$f")
done

if [ ${#MERGE_INPUTS[@]} -gt 0 ]; then
  echo "[$(date)] Merging ${#MERGE_INPUTS[@]} machine files"
  python3 merge_agents.py "${MERGE_INPUTS[@]}" -o agents.json
fi

# Commit and push if there are changes
if git diff --quiet agents.json 2>/dev/null; then
  echo "[$(date)] No changes to push"
  exit 0
fi

git add -A
git commit -m "Update constellation $(date +%Y-%m-%d_%H:%M)" || true
git push origin main

echo "[$(date)] Pushed to GitHub"
