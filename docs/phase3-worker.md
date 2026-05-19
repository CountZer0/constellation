# Phase 3 — Cloudflare Worker + D1 Telemetry Authority

Phase 3 adds the backend authority for Constellation telemetry.

The current git-based cron remains active until the Worker is deployed, seeded, and verified.

## Files

```text
worker/src/index.js        Worker routes, HMAC verification, validation, merge
worker/schema.sql          D1 schema
worker/test/worker.test.js Node test suite with MockD1
worker/wrangler.toml       Wrangler config template
package.json               Worker/Python test scripts
```

## Routes

### POST /v1/snapshots/:machine

Accepts signed machine snapshots.

Required headers:

```http
Content-Type: application/json
X-Constellation-Machine: linux
X-Constellation-Timestamp: 2026-05-19T12:00:00Z
X-Constellation-Signature: sha256=<hex>
```

Behavior:

1. Rejects payloads over 256 KiB
2. Validates required headers
3. Enforces path/header/body machine match
4. Rejects timestamp skew over 5 minutes
5. Parses and validates snapshot JSON
6. Verifies HMAC signature
7. Upserts `latest_snapshots`
8. Appends `snapshot_events`

### GET /agents.json

Loads latest snapshots from D1 and produces the canonical merged graph server-side.

This mirrors the Phase 1 `merge_agents.py` behavior:

- scopes non-service nodes as `<machine>_<node>`
- leaves shared services unscoped
- annotates machine freshness status
- preserves stale/offline machines
- adds cross-mesh edges between default agents

### GET /v1/machines

Returns machine summaries and freshness status.

### GET /v1/health

Returns basic service health.

## Local Tests

Run everything:

```bash
npm test
```

Worker only:

```bash
npm run test:worker
```

Python only:

```bash
python3 -m unittest discover -s tests -v
```

## Cloudflare Setup

Install dependencies if needed:

```bash
npm install
```

Login:

```bash
npx wrangler login
```

Create D1 database:

```bash
npx wrangler d1 create constellation
```

Wrangler will return a `database_id`. Paste it into:

```text
worker/wrangler.toml
```

Apply schema remotely:

```bash
npm run d1:migrate:remote
```

Set machine secrets as a single JSON secret:

```bash
npx wrangler secret put CONSTELLATION_SECRETS --config worker/wrangler.toml
```

Value shape:

```json
{"linux":"...","mac":"...","win":"..."}
```

Deploy:

```bash
npm run worker:deploy
```

## First Endpoint Test

On Linux server:

```bash
export CONSTELLATION_ENDPOINT="https://constellation-telemetry.<account>.workers.dev"
export CONSTELLATION_SECRET="<linux secret>"
export CONSTELLATION_MACHINE="linux"
export CONSTELLATION_DEFAULT_NAME="CLU"
export CONSTELLATION_SNAPSHOT_OUT="/tmp/linux_agents.json"
bash constellation-post.sh
```

Then verify:

```bash
curl -fsS "$CONSTELLATION_ENDPOINT/v1/health"
curl -fsS "$CONSTELLATION_ENDPOINT/v1/machines"
curl -fsS "$CONSTELLATION_ENDPOINT/agents.json"
```

## Cutover Gates

Do not disable `constellation-update.sh` until all are true:

- Linux post succeeds repeatedly
- Mac and Win post their snapshots
- `/agents.json` contains all three machines
- frontend can load Worker-backed data
- stale/offline behavior matches Phase 1
- no secrets appear in git

## Current Boundary

This phase creates and tests the Worker scaffold. It does not deploy because deployment requires Cloudflare account authorization and a real D1 database ID.
