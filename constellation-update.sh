#!/bin/bash
# constellation-update.sh
# Collects local Hermes agent data, merges with other machines' data, pushes to GitHub.
# Each machine in the constellation runs this on its own cron.
#
# Usage:
#   bash constellation-update.sh [machine_tag] [default_name]
#
# Defaults are set per-machine (see MACHINE/DEFAULT_NAME below).
# Other machines' *_agents.json files are preserved from the repo —
# this script only overwrites its own machine file, then merges all.
#
# Setup:
#   1. Clone the repo: git clone https://github.com/CountZer0/constellation.git ~/.hermes/constellation
#   2. Make executable: chmod +x ~/.hermes/constellation/constellation-update.sh
#   3. Crontab: 0 * * * * /bin/bash ~/.hermes/constellation/constellation-update.sh >> /tmp/constellation-update.log 2>&1

set -euo pipefail

REPO_DIR="${HOME}/.hermes/constellation"
MACHINE="${1:-linux}"         # Machine tag for this host
DEFAULT_NAME="${2:-CLU}"      # Default agent name for this host

cd "$REPO_DIR" || { echo "Repo not found at $REPO_DIR"; exit 1; }

echo "[$(date)] === constellation-update: machine=$MACHINE ==="

# Pull latest first — picks up other machines' recent updates
git pull --rebase origin main 2>/dev/null || {
  echo "[$(date)] WARNING: pull failed, continuing with local state"
}

# Collect this machine's data (overwrites only OUR file)
python3 collect_agents.py \
  --machine "$MACHINE" \
  --default-name "$DEFAULT_NAME" \
  -o "${MACHINE}_agents.json"

# Merge ALL available machine JSONs into agents.json
MERGE_INPUTS=()
for f in *_agents.json; do
  [ -f "$f" ] && MERGE_INPUTS+=("$f")
done

if [ ${#MERGE_INPUTS[@]} -gt 0 ]; then
  echo "[$(date)] Merging ${#MERGE_INPUTS[@]} machine files: ${MERGE_INPUTS[*]}"
  python3 merge_agents.py "${MERGE_INPUTS[@]}" -o agents.json
fi

# Check for changes before committing
if git diff --quiet HEAD -- agents.json "${MACHINE}_agents.json" 2>/dev/null; then
  echo "[$(date)] No changes to push"
  exit 0
fi

git add -A
git commit -m "Update constellation $(date +%Y-%m-%d_%H:%M) [$MACHINE]" || true

# Push with retry on conflict
if ! git push origin main 2>/dev/null; then
  echo "[$(date)] Push rejected, pulling and retrying..."
  git pull --rebase origin main
  git push origin main
fi

echo "[$(date)] Pushed to GitHub"
