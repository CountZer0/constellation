# Hermes Agent Constellation

A dynamic, cyberpunk-styled network visualization of your [Hermes Agent](https://github.com/NousResearch/hermes-agent) ecosystem. Shows all agents across multiple machines, their connections, models, roles, and platform status — auto-updating from live config data.

![Constellation Preview](preview.png)

## Features

- **Multi-machine** — visualize agents across Mac, Windows, Linux
- **Auto-refreshing** — HTML polls `agents.json` every 60 seconds
- **Live data** — collector scripts read real Hermes configs (SOUL.md, config.yaml, honcho.json, gateway_state.json)
- **Interactive** — click any node to see agent details (model, provider, voice, toolsets, connections)
- **Animated** — glowing nodes, pulsing edges, traveling data dots, scanline effect
- **Zero dependencies** — pure HTML/CSS/Canvas, no build step

## Architecture

```
Machine A (Mac)         Machine B (Win/WSL)        Machine C (Linux)
┌─────────────────┐     ┌─────────────────┐        ┌─────────────────┐
│ collect_agents.py│     │ collect_agents.py│        │ collect_agents.py│
│ reads:           │     │ reads:           │        │ reads:           │
│  ~/.hermes/      │     │  ~/.hermes/      │        │  ~/.hermes/      │
│   SOUL.md        │     │   SOUL.md        │        │   SOUL.md        │
│   config.yaml    │     │   config.yaml    │        │   config.yaml    │
│   gateway_state  │     │   gateway_state  │        │   gateway_state  │
│   profiles/*     │     │   profiles/*     │        │   profiles/*     │
└────────┬────────┘     └────────┬────────┘        └────────┬────────┘
         │ POST                  │ POST                      │ POST
         ▼                       ▼                           ▼
   ┌─────────────────────────────────────────────────────────────┐
   │            Cloudflare Worker + D1 (telemetry)               │
   │         constellation-telemetry.count-zr0.workers.dev       │
   └─────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
                          GET /agents.json
                                 │
                                 ▼
   GitHub Pages (static frontend)
   https://countzer0.github.io/constellation/
```

## How Updates Flow

Each machine runs `constellation-post.sh` on a cron (hourly). The script:

1. **Collects** local agent data from Hermes configs
2. **Validates** the snapshot against the schema
3. **Signs** the payload with HMAC-SHA256 (per-machine secret)
4. **POSTs** the snapshot to the Cloudflare Worker
5. Worker **upserts** into D1 (`latest_snapshots` + `snapshot_events`)
6. Frontend fetches `GET /agents.json` from the Worker (server-side merge)

Each machine only knows its own config and secret. The Worker owns the merge.

## Status Rules

Machine snapshots are not deleted when they stop reporting. They remain visible with degraded status:

| Status | Rule | Display |
|--------|------|---------|
| `online` | last seen under 10 minutes ago | normal machine color |
| `stale` | last seen 10–59 minutes ago | yellow |
| `offline` | last seen 60+ minutes ago | dim/gray |
| `unknown` | missing/invalid timestamp | unknown |

## Machine Reference

| Machine | Tag | Hostname | Default Agent | Profiles |
|---------|-----|----------|---------------|----------|
| MacBook Pro | `mac` | Countzer0s-MacBook-Pro | Count Zer0 | buddha, hiro, wintermute |
| Win/WSL | `win` | Cyberspace-Seven | TRON | ares, caac |
| Linux server | `linux` | ubuntu-4gb-hil-1 | CLU | silveroak |

---

## Setup — Deploying the Worker (one-time)

The Cloudflare Worker is the central telemetry authority. Deploy it once, then each machine just POSTs to it.

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- Node.js 20+ on the deploy machine
- `wrangler` CLI (installed via `npm install` in this repo)

### 1. Clone and install

```bash
git clone https://github.com/CountZer0/constellation.git ~/.hermes/constellation
cd ~/.hermes/constellation
npm install
```

### 2. Authenticate with Cloudflare

Create an API token at https://dash.cloudflare.com/profile/api-tokens:

- Click **Create Token**
- Use the **Edit Cloudflare Workers** template
- Add permission: **Account > D1 > Edit**
- Under **Account Resources**, select your account
- Click **Continue to summary** → **Create Token**
- Copy the token

Set it as an environment variable:

```bash
export CLOUDFLARE_API_TOKEN="<your token>"
```

Verify:

```bash
npx wrangler whoami
```

### 3. Create the D1 database

```bash
npx wrangler d1 create constellation --config worker/wrangler.toml
```

Copy the `database_id` from the output and paste it into `worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "constellation"
database_id = "<paste here>"
```

### 4. Apply the schema

```bash
npm run d1:migrate:remote
```

### 5. Generate HMAC secrets

Each machine gets its own secret. Generate three:

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

Run it three times. Save the outputs — you'll need them for each machine.

### 6. Set the Worker secret

Store all three secrets as a single JSON object:

```bash
npx wrangler secret put CONSTELLATION_SECRETS --config worker/wrangler.toml
```

When prompted, paste:

```json
{"linux":"<linux secret>","mac":"<mac secret>","win":"<win secret>"}
```

### 7. Deploy

```bash
npm run worker:deploy
```

Output will show your Worker URL:

```
https://constellation-telemetry.<your-subdomain>.workers.dev
```

### 8. Verify

```bash
curl https://constellation-telemetry.<your-subdomain>.workers.dev/v1/health
curl https://constellation-telemetry.<your-subdomain>.workers.dev/v1/machines
curl https://constellation-telemetry.<your-subdomain>.workers.dev/agents.json
```

---

## Setup — Configuring Each Machine

Each machine needs: the repo, its HMAC secret, and a cron job.

### 1. Clone the repo

```bash
git clone https://github.com/CountZer0/constellation.git ~/.hermes/constellation
cd ~/.hermes/constellation
```

### 2. Get the HMAC secret for this machine

The secrets were generated during Worker deployment. To retrieve them, the person who deployed the Worker can:

**Option A:** Check the deploy machine's shell history (the secret was printed during `python3 -c "import secrets; ..."`).

**Option B:** Re-generate and update. On the deploy machine:

```bash
# Generate a new secret
python3 -c "import secrets; print(secrets.token_hex(32))"

# Update the Worker's secret store
npx wrangler secret put CONSTELLATION_SECRETS --config worker/wrangler.toml
# Paste the full JSON with the updated secret for this machine
```

**Option C:** If you have `CLOUDFLARE_API_TOKEN` access, read the secret JSON:

```bash
npx wrangler secret list --config worker/wrangler.toml
# Then use the Cloudflare dashboard to view the secret value
```

### 3. Test the post

```bash
export CONSTELLATION_ENDPOINT="https://constellation-telemetry.<your-subdomain>.workers.dev"
export CONSTELLATION_SECRET="<this machine's secret>"
export CONSTELLATION_MACHINE="linux"    # or "mac" or "win"
export CONSTELLATION_DEFAULT_NAME="CLU" # or "Count Zer0" for mac
bash constellation-post.sh
```

Verify the data landed:

```bash
curl "$CONSTELLATION_ENDPOINT/v1/machines"
```

### 4. Set up the cron job

**System crontab (recommended):**

```bash
crontab -e
```

Add:

```
0 * * * * CONSTELLATION_ENDPOINT="https://constellation-telemetry.<your-subdomain>.workers.dev" CONSTELLATION_SECRET="<this machine's secret>" CONSTELLATION_MACHINE="linux" CONSTELLATION_DEFAULT_NAME="CLU" /bin/bash ~/.hermes/constellation/constellation-post.sh >> /tmp/constellation-post.log 2>&1
```

Adjust `CONSTELLATION_MACHINE` and `CONSTELLATION_DEFAULT_NAME` per machine (see Machine Reference above).

**Hermes cron:**

In a Hermes session:
```
Create a cron job: run constellation-post.sh every hour with env vars CONSTELLATION_ENDPOINT and CONSTELLATION_SECRET set
```

---

## Setup — Frontend

The GitHub Pages frontend loads `index.html` which fetches `agents.json`.

### Point the frontend at the Worker

Edit `index.html` — find this line:

```javascript
const resp = await fetch('agents.json', { cache: 'no-cache' });
```

Change it to:

```javascript
const resp = await fetch('https://constellation-telemetry.<your-subdomain>.workers.dev/agents.json', { cache: 'no-cache' });
```

Commit and push. GitHub Actions will redeploy Pages.

---

## Adding a New Machine

1. Clone the repo on the new machine
2. Generate a new HMAC secret: `python3 -c "import secrets; print(secrets.token_hex(32))"`
3. Update the Worker secret: `npx wrangler secret put CONSTELLATION_SECRETS` (on any machine with `CLOUDFLARE_API_TOKEN`)
4. Test: `bash constellation-post.sh`
5. Set up crontab

## Adding a New Agent (Profile)

1. Create a profile directory: `~/.hermes/profiles/myagent/`
2. Add `SOUL.md` with identity info (Name, Title, Voice, Role)
3. Add `config.yaml` with model/provider settings
4. Re-run `bash constellation-post.sh` — the collector auto-discovers profiles

---

## Development

### Run all tests

```bash
npm test
```

This runs both Python tests (collector, merge, signing, validation) and Node tests (Worker routes, D1 persistence, merge logic).

### Worker tests only

```bash
npm run test:worker
```

### Python tests only

```bash
python3 -m unittest discover -s tests -v
```

### Local Worker development

```bash
npm run worker:dev
```

### Local D1 migration

```bash
npm run d1:migrate:local
```

---

## API Reference

### POST /v1/snapshots/:machine

Accepts a signed machine snapshot.

Required headers:

```http
Content-Type: application/json
X-Constellation-Machine: <machine tag>
X-Constellation-Timestamp: <ISO 8601 UTC>
X-Constellation-Signature: sha256=<hex>
```

The signature is HMAC-SHA256 of:

```
<timestamp>\n<machine_id>\n<sha256(body)>
```

### GET /agents.json

Returns the canonical merged graph with all machines, agents, edges, and freshness status.

### GET /v1/machines

Returns a list of machines with their last-seen timestamps and status.

### GET /v1/health

Returns service health.

---

## File Reference

| File | Purpose |
|------|---------|
| `collect_agents.py` | Reads local Hermes configs, outputs machine-specific JSON |
| `merge_agents.py` | Legacy: merges machine JSON files into `agents.json` |
| `constellation-update.sh` | Legacy git-based: collect → merge → commit → push |
| `constellation-post.sh` | Telemetry client: collect → validate → sign → POST |
| `validate_snapshot.py` | Stdlib snapshot validator |
| `signing.py` | HMAC-SHA256 signing helper and CLI |
| `schemas/snapshot.schema.json` | Canonical machine snapshot schema |
| `docs/telemetry-api.md` | Telemetry ingestion contract |
| `docs/phase3-worker.md` | Cloudflare Worker + D1 deployment guide |
| `worker/src/index.js` | Cloudflare Worker telemetry authority |
| `worker/schema.sql` | D1 database schema |
| `worker/wrangler.toml` | Wrangler deployment config |
| `index.html` | Interactive visualization frontend |
| `*_agents.json` | Per-machine data (legacy, auto-generated) |

## CLI Reference

### collect_agents.py

```
python3 collect_agents.py [OPTIONS]

Options:
  --machine TAG     Machine identifier: mac, win, linux, etc.
  --default-name    Display name for the default agent (e.g., "CLU")
  -o, --output      Output file path (default: stdout)
```

### signing.py

```
python3 signing.py --secret SECRET --timestamp TIMESTAMP --machine MACHINE --body FILE
```

### validate_snapshot.py

```
python3 validate_snapshot.py <machine>_agents.json
```

## Customization

### Changing colors

Edit the `COLOR_MAP` in `collect_agents.py`:

```python
COLOR_MAP = {
    "count":      "#00e5ff",  # cyan
    "hiro":       "#ff2d7b",  # pink
    "buddha":     "#ffd700",  # yellow
    "wintermute": "#b24dff",  # purple
    "clu":        "#ff8c00",  # orange
    "caac":       "#ff6b6b",  # red
    "ares":       "#e055ff",  # magenta
}
```

## View

https://countzer0.github.io/constellation/

## License

MIT
