# Hermes Agent Constellation

A dynamic, cyberpunk-styled network visualization of your [Hermes Agent](https://github.com/NousResearch/hermes-agent) ecosystem. Constellation shows Hermes agents across multiple machines, profiles, gateways, repositories, services, models, and platform connections using live telemetry from each client.

![Constellation Preview](preview.png)

## Current Architecture

Constellation is no longer a git-as-telemetry system. Machines do not commit generated JSON snapshots to the repository. Each machine runs a post-only telemetry client that signs its local snapshot and sends it to a Cloudflare Worker. The Worker stores the newest snapshot per machine in D1 and serves the canonical merged graph to the frontend.

```text
Machine A                  Machine B                  Machine C
mac                        win                        linux
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│ Hermes profiles  │       │ Hermes profiles  │       │ Hermes profiles  │
│ ~/.hermes/       │       │ ~/.hermes/       │       │ ~/.hermes/       │
│ collect_agents.py│       │ collect_agents.py│       │ collect_agents.py│
└────────┬─────────┘       └────────┬─────────┘       └────────┬─────────┘
         │ signed POST              │ signed POST              │ signed POST
         │ /v1/snapshots/:machine   │ /v1/snapshots/:machine   │ /v1/snapshots/:machine
         └──────────────┬───────────┴──────────────┬───────────┘
                        ▼                          ▼
              ┌─────────────────────────────────────────┐
              │ Cloudflare Worker + D1                  │
              │ latest_snapshots + snapshot_events      │
              │ server-side merge + freshness status    │
              └────────────────────┬────────────────────┘
                                   │
                 GET /agents.json  │  GET /v1/machines
                 GET /v1/layout    │  POST /v1/layout
                                   ▼
              GitHub Pages static frontend
              https://countzer0.github.io/constellation/
```

Production Worker endpoint used by this repo:

```text
https://constellation-telemetry.count-zr0.workers.dev
```

## Features

- Multi-machine graph: Mac, Windows/WSL, Linux, and any additional Hermes host.
- Live Hermes discovery: reads `~/.hermes`, `SOUL.md`, `config.yaml`, `profiles/*`, gateway state, Honcho metadata, and local repo/service links.
- Worker-backed telemetry: clients POST signed snapshots; the Worker owns merge state.
- Freshness status: machines stay visible as `online`, `stale`, or `offline` instead of disappearing.
- Interactive frontend: click nodes for details, drag nodes, sync/reset shared layout.
- Static frontend: GitHub Pages serves `index.html`; live graph data comes from the Worker.
- Low dependency client: Python stdlib + `curl` + `bash`; no Node install required on telemetry clients.

## How Updates Flow

Each machine runs `constellation-post.sh` hourly. The script:

1. Collects local agent data with `collect_agents.py`.
2. Validates the generated snapshot with `validate_snapshot.py`.
3. Signs the exact JSON body with HMAC-SHA256 via `signing.py`.
4. POSTs to `${CONSTELLATION_ENDPOINT}/v1/snapshots/${CONSTELLATION_MACHINE}`.
5. The Worker verifies timestamp skew, machine ID consistency, schema, and HMAC signature.
6. The Worker upserts D1 tables:
   - `latest_snapshots`: newest snapshot per machine.
   - `snapshot_events`: append-only event history.
7. The frontend fetches `GET /agents.json` from the Worker and renders the merged graph.

Clients only know their own machine tag and secret. They do not merge other machines. They do not edit `agents.json`. They do not push telemetry commits.

## Status Rules

Machine snapshots are retained when a machine stops reporting.

| Status | Rule | Display |
|--------|------|---------|
| `online` | last seen under 10 minutes ago | normal machine color |
| `stale` | last seen 10-59 minutes ago | yellow/degraded |
| `offline` | last seen 60+ minutes ago | dim/gray |
| `unknown` | missing or invalid timestamp | unknown |

## Known Machine Tags

| Machine | Tag | Default Agent | Notes |
|---------|-----|---------------|-------|
| MacBook Pro | `mac` | `Count Zer0` | macOS Hermes host |
| Windows/WSL | `win` | `TRON` | Windows or WSL Hermes host |
| Linux server | `linux` | `CLU` | Default Linux Hermes host |

New machines can use any stable lowercase tag, for example `lab`, `gpu`, `home`, or `prod-1`. The tag must match in three places: Worker secret JSON key, `CONSTELLATION_MACHINE`, and snapshot `machine.tag`.

---

# Client Setup — Connect a New Hermes Machine

Use this section on each machine that already runs, or will run, Hermes Agent.

## Prerequisites

Required on the client machine:

- Hermes Agent installed and configured.
- `git`.
- `python3`.
- `bash`.
- `curl`.
- Access to this repository.
- A per-machine HMAC secret that has also been added to the Worker secret `CONSTELLATION_SECRETS`.

Node.js and Wrangler are not required for ordinary client machines. They are only required for Worker deployment/maintenance.

## 1. Install or update the repo

Default location expected by `constellation-post.sh`:

```bash
mkdir -p ~/.hermes
git clone https://github.com/CountZer0/constellation.git ~/.hermes/constellation
cd ~/.hermes/constellation
```

If the repo already exists:

```bash
cd ~/.hermes/constellation
git pull --ff-only origin main
```

If local history diverged because an older cron committed telemetry snapshots, preserve it on a backup branch first, then reset main to origin:

```bash
cd ~/.hermes/constellation
git fetch origin --prune
git branch "backup/local-legacy-constellation-$(date -u +%Y%m%dT%H%M%SZ)" HEAD
git reset --hard origin/main
```

Do this only when you are sure old generated `agents.json` / `*_agents.json` commits do not need to remain on `main`.

## 2. Choose the machine identity

Set these per machine:

| Variable | Example | Purpose |
|----------|---------|---------|
| `CONSTELLATION_MACHINE` | `linux` | Stable machine tag used by Worker and graph merge |
| `CONSTELLATION_DEFAULT_NAME` | `CLU` | Display name for the default/root Hermes profile |
| `CONSTELLATION_ENDPOINT` | `https://constellation-telemetry.count-zr0.workers.dev` | Worker base URL |
| `CONSTELLATION_SECRET` | generated secret | Per-machine HMAC secret |

Common values:

```text
mac    -> CONSTELLATION_DEFAULT_NAME="Count Zer0"
win    -> CONSTELLATION_DEFAULT_NAME="TRON"
linux  -> CONSTELLATION_DEFAULT_NAME="CLU"
```

## 3. Create the client env file

Create `~/.hermes/constellation/.env.constellation`:

```bash
cat > ~/.hermes/constellation/.env.constellation <<'EOF'
CONSTELLATION_ENDPOINT="https://constellation-telemetry.count-zr0.workers.dev"
CONSTELLATION_SECRET="<secret for this machine>"
CONSTELLATION_MACHINE="linux"
CONSTELLATION_DEFAULT_NAME="CLU"
EOF
chmod 600 ~/.hermes/constellation/.env.constellation
```

Replace:

- `CONSTELLATION_SECRET` with the secret assigned to this machine.
- `CONSTELLATION_MACHINE` with this machine's tag.
- `CONSTELLATION_DEFAULT_NAME` with the local default Hermes agent name.

Security rule: do not commit real `.env.constellation` values. Keep secrets in local env files, password managers, or Cloudflare Worker secrets only.

## 4. Test one signed telemetry post

```bash
cd ~/.hermes/constellation
set -a
. ~/.hermes/constellation/.env.constellation
set +a
bash constellation-post.sh
```

Expected output includes:

```json
{
  "ok": true,
  "machine": "linux",
  "received_at": "..."
}
```

Verify the Worker can see machines:

```bash
curl -fsS "$CONSTELLATION_ENDPOINT/v1/machines"
```

Optional: save the generated local snapshot for inspection without posting it anywhere else:

```bash
CONSTELLATION_SNAPSHOT_OUT=/tmp/constellation-snapshot.json bash constellation-post.sh
python3 validate_snapshot.py /tmp/constellation-snapshot.json
```

## 5. Schedule telemetry

There are two supported schedulers. Prefer Hermes cron when Hermes is already running as a durable agent service. Use system crontab when you want the OS scheduler to own the job independently of Hermes.

### Option A: Hermes cron, script-only job

Hermes cron resolves relative script paths under `~/.hermes/scripts/`. Create a small wrapper there:

```bash
mkdir -p ~/.hermes/scripts ~/.hermes/logs
cat > ~/.hermes/scripts/constellation-cron.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${HOME}/.hermes/constellation"
ENV_FILE="${REPO_DIR}/.env.constellation"
LOG_FILE="${HOME}/.hermes/logs/constellation-cron.log"
POST_LOG_FILE="/tmp/constellation-post.log"

mkdir -p "$(dirname "$LOG_FILE")"

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '[%s] %s\n' "$(stamp)" "$*"; }

{
  log "Constellation post start"

  if [ ! -d "$REPO_DIR" ]; then
    log "ERROR repo not found: $REPO_DIR"
    exit 1
  fi

  if [ ! -f "$ENV_FILE" ]; then
    log "ERROR env file not found: $ENV_FILE"
    exit 1
  fi

  set -a
  . "$ENV_FILE"
  set +a

  if [ -z "${CONSTELLATION_ENDPOINT:-}" ]; then
    log "ERROR CONSTELLATION_ENDPOINT is not set"
    exit 2
  fi

  if [ -z "${CONSTELLATION_SECRET:-}" ]; then
    log "ERROR CONSTELLATION_SECRET is not set"
    exit 2
  fi

  cd "$REPO_DIR"
  /bin/bash "$REPO_DIR/constellation-post.sh"
  log "Constellation post complete"
} 2>&1 | tee -a "$LOG_FILE" "$POST_LOG_FILE"
EOF
chmod 700 ~/.hermes/scripts/constellation-cron.sh
```

Create the hourly Hermes cron job:

```bash
hermes cron create '0 * * * *' \
  --name 'Constellation Update' \
  --deliver local \
  --script constellation-cron.sh \
  --no-agent
```

Verify it exists:

```bash
hermes cron list
```

Trigger a test run on the next scheduler tick:

```bash
hermes cron run <job_id>
hermes cron list
```

A healthy job shows `Last run: ... ok` and `Next run` at the next hour.

If you need to replace an old broken Constellation job:

```bash
hermes cron list
hermes cron remove <old_job_id>
hermes cron create '0 * * * *' --name 'Constellation Update' --deliver local --script constellation-cron.sh --no-agent
hermes cron list
```

### Option B: OS crontab

Install an OS cron line:

```bash
( crontab -l 2>/dev/null | grep -v 'constellation-post.sh' ; \
  echo '0 * * * * set -a && . $HOME/.hermes/constellation/.env.constellation && set +a && /bin/bash $HOME/.hermes/constellation/constellation-post.sh >> /tmp/constellation-post.log 2>&1' \
) | crontab -
```

Verify:

```bash
crontab -l | grep constellation-post
```

Logs:

```bash
tail -50 /tmp/constellation-post.log
```

## 6. Client health checklist

```bash
cd ~/.hermes/constellation

git status --short --branch
bash -n constellation-post.sh
python3 collect_agents.py --machine "$CONSTELLATION_MACHINE" --default-name "$CONSTELLATION_DEFAULT_NAME" -o /tmp/constellation-check.json
python3 validate_snapshot.py /tmp/constellation-check.json
bash constellation-post.sh
curl -fsS "$CONSTELLATION_ENDPOINT/v1/machines"
```

Healthy state:

- Git working tree is clean, unless you are actively editing the repo.
- Snapshot validates locally.
- `constellation-post.sh` returns `ok: true`.
- The Worker reports the machine in `/v1/machines`.
- Scheduler log shows hourly successful posts.

---

# Adding a New Hermes Agent/Profile

Constellation auto-discovers Hermes profiles from `~/.hermes/profiles/*`.

1. Create or configure the Hermes profile:

   ```bash
   hermes profile create myagent
   hermes --profile myagent setup
   ```

2. Add or update profile identity files as needed:

   ```text
   ~/.hermes/profiles/myagent/SOUL.md
   ~/.hermes/profiles/myagent/config.yaml
   ```

3. Run a local post:

   ```bash
   cd ~/.hermes/constellation
   set -a && . .env.constellation && set +a
   bash constellation-post.sh
   ```

The new profile should appear after the frontend refreshes.

---

# Worker Deployment and Maintenance

Deploy the Worker once per Constellation installation. Ordinary telemetry clients do not need this section.

## Prerequisites

- Cloudflare account.
- Node.js 20+.
- Wrangler, installed from this repo with `npm install`.
- Permission to create/edit Workers, D1 databases, and Worker secrets.

## 1. Install deploy dependencies

```bash
git clone https://github.com/CountZer0/constellation.git ~/.hermes/constellation
cd ~/.hermes/constellation
npm install
```

## 2. Authenticate Cloudflare

Use either `wrangler login` or an API token:

```bash
export CLOUDFLARE_API_TOKEN="<cloudflare api token>"
npx wrangler whoami
```

Required token capabilities:

- Workers Scripts: Edit
- D1: Edit
- Account access for the target account

## 3. Create or bind D1

Create a D1 database if one does not exist:

```bash
npx wrangler d1 create constellation --config worker/wrangler.toml
```

Copy the returned `database_id` into `worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "constellation"
database_id = "<database id>"
```

Apply the schema:

```bash
npm run d1:migrate:remote
```

## 4. Configure machine secrets

Generate one secret per machine:

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

Set the Worker secret as a JSON map from machine tag to secret:

```bash
npx wrangler secret put CONSTELLATION_SECRETS --config worker/wrangler.toml
```

Example value shape:

```json
{"linux":"<linux secret>","mac":"<mac secret>","win":"<win secret>"}
```

To add a new machine later, generate a new secret and re-run `wrangler secret put` with the full updated JSON object.

## 5. Deploy

```bash
npm run worker:deploy
```

Verify endpoints:

```bash
curl -fsS https://constellation-telemetry.<your-subdomain>.workers.dev/v1/health
curl -fsS https://constellation-telemetry.<your-subdomain>.workers.dev/v1/machines
curl -fsS https://constellation-telemetry.<your-subdomain>.workers.dev/agents.json
```

---

# Frontend

The frontend is static `index.html` served by GitHub Pages:

```text
https://countzer0.github.io/constellation/
```

Current data endpoints are configured near the top of `index.html`:

```javascript
const AGENTS_URL = 'https://constellation-telemetry.count-zr0.workers.dev/agents.json' || 'agents.json';
const LAYOUT_URL = 'https://constellation-telemetry.count-zr0.workers.dev/v1/layout';
```

To point a fork or new deployment at a different Worker, change those constants and push to GitHub. The Pages workflow redeploys the static frontend.

---

# API Reference

## POST /v1/snapshots/:machine

Accepts a signed machine snapshot.

Required headers:

```http
Content-Type: application/json
X-Constellation-Machine: <machine tag>
X-Constellation-Timestamp: <ISO 8601 UTC>
X-Constellation-Signature: sha256=<hex>
```

The path machine ID, header machine ID, and body `machine.tag` must match.

The signature is HMAC-SHA256 over:

```text
<timestamp>\n<machine_id>\n<sha256(body_bytes)>
```

Response on success:

```json
{"ok":true,"machine":"linux","received_at":"..."}
```

## GET /agents.json

Returns the canonical merged graph with all machines, agents, edges, gateway status, and freshness status.

## GET /v1/machines

Returns machine summaries with last-seen timestamps and status.

## GET /v1/health

Returns service health.

## GET /v1/layout

Returns shared frontend layout overrides.

## POST /v1/layout

Stores shared frontend layout overrides.

## DELETE /v1/layout

Resets shared frontend layout overrides.

---

# File Reference

| File | Purpose |
|------|---------|
| `collect_agents.py` | Reads local Hermes configs and outputs one machine snapshot |
| `constellation-post.sh` | Current telemetry client: collect -> validate -> sign -> POST |
| `validate_snapshot.py` | Stdlib snapshot validator |
| `signing.py` | HMAC-SHA256 signing helper and CLI |
| `schemas/snapshot.schema.json` | Canonical snapshot schema |
| `worker/src/index.js` | Cloudflare Worker telemetry authority and merge service |
| `worker/schema.sql` | D1 database schema |
| `worker/wrangler.toml` | Wrangler Worker/D1 config |
| `index.html` | GitHub Pages visualization frontend |
| `docs/telemetry-api.md` | Lower-level telemetry contract notes |
| `docs/phase3-worker.md` | Worker/D1 deployment notes |
| `merge_agents.py` | Legacy/local utility for merging machine JSON files |
| `constellation-update.sh` | Legacy git-based updater; do not use for current telemetry cron |
| `agents.json`, `*_agents.json` | Legacy/static snapshots; no longer the live telemetry source |

---

# CLI Reference

## collect_agents.py

```bash
python3 collect_agents.py --machine linux --default-name CLU -o /tmp/linux_agents.json
```

Options:

```text
--machine TAG       Machine identifier: mac, win, linux, etc.
--default-name NAME Display name for the default Hermes agent
-o, --output FILE   Output file path; stdout if omitted
```

## validate_snapshot.py

```bash
python3 validate_snapshot.py /tmp/linux_agents.json
```

## signing.py

```bash
python3 signing.py --secret "$CONSTELLATION_SECRET" --timestamp "$TIMESTAMP" --machine "$CONSTELLATION_MACHINE" --body /tmp/linux_agents.json
```

## constellation-post.sh

Required environment:

```bash
export CONSTELLATION_ENDPOINT="https://constellation-telemetry.count-zr0.workers.dev"
export CONSTELLATION_SECRET="<machine secret>"
```

Optional environment:

```bash
export CONSTELLATION_MACHINE="linux"
export CONSTELLATION_DEFAULT_NAME="CLU"
export CONSTELLATION_SNAPSHOT_OUT="/tmp/constellation-snapshot.json"
```

Run:

```bash
bash constellation-post.sh
```

---

# Development

Run all tests:

```bash
npm test
```

Python tests only:

```bash
python3 -m unittest discover -s tests -v
```

Worker tests only:

```bash
npm run test:worker
```

Local Worker development:

```bash
npm run worker:dev
```

Local D1 migration:

```bash
npm run d1:migrate:local
```

Remote D1 migration:

```bash
npm run d1:migrate:remote
```

---

# Legacy Migration Notes

Older Constellation clients used `constellation-update.sh` to:

```text
collect -> merge -> commit agents.json/linux_agents.json -> git push
```

That flow is deprecated. If you see hourly commits named like `Update constellation YYYY-MM-DD_HH:MM`, migrate that machine to `constellation-post.sh` and disable/remove the old git-push cron.

Migration pattern:

1. Preserve old local history if needed:

   ```bash
   git branch "backup/local-legacy-constellation-$(date -u +%Y%m%dT%H%M%SZ)" HEAD
   ```

2. Sync main to upstream:

   ```bash
   git fetch origin --prune
   git reset --hard origin/main
   ```

3. Install the post-only env file and cron job from the Client Setup section.

4. Verify `constellation-post.sh` returns `ok: true`.

---

# View

```text
https://countzer0.github.io/constellation/
```

# License

MIT
