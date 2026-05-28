# Constellation Telemetry API — Phase 2 Contract

Phase 2 defines the ingestion contract. It does not yet replace the git-based production cron. The current cron remains active until a real endpoint is deployed and verified.

## Goal

Move Constellation from git-as-telemetry to explicit machine snapshots:

```text
machine collect_agents.py
  → validate_snapshot.py
  → signing.py
  → POST /v1/snapshots/{machine_id}
  → central state store
  → canonical GET /agents.json
```

Machines own only their own snapshots. They do not merge other machines. They do not edit `agents.json`. They do not push data commits.

## Snapshot Schema

Canonical schema file:

```text
schemas/snapshot.schema.json
```

The local validator is intentionally stdlib-only:

```bash
python3 validate_snapshot.py linux_agents.json
```

A valid snapshot must include:

```json
{
  "schema_version": 1,
  "machine": {
    "tag": "linux",
    "hostname": "ubuntu-4gb-hil-1",
    "os": "Linux"
  },
  "gateway": { "pid": 123, "state": "running" },
  "agents": {},
  "edges": [],
  "collected_at": "2026-05-19T10:46:18+00:00"
}
```

## Ingest Endpoint

```http
POST /v1/snapshots/{machine_id}
Content-Type: application/json
X-Constellation-Machine: linux
X-Constellation-Timestamp: 2026-05-19T10:46:18Z
X-Constellation-Signature: sha256=<hex>
```

Request body is the exact JSON bytes to store.

The path machine ID, `X-Constellation-Machine`, and `body.machine.tag` must match.

## HMAC Signature

The signature covers the timestamp, machine ID, and exact request-body hash.

Body hash:

```text
body_sha256_hex = sha256(body_bytes).hexdigest()
```

Signing input:

```text
<timestamp>\n<machine_id>\n<body_sha256_hex>
```

Signature:

```text
sha256=<hmac_sha256(secret, signing_input).hexdigest()>
```

Local signing command:

```bash
python3 signing.py \
  --secret "$CONSTELLATION_SECRET" \
  --timestamp "2026-05-19T10:46:18Z" \
  --machine linux \
  --body linux_agents.json
```

Verification must use constant-time comparison.

## Security Rules

The ingest service must reject:

- missing required headers
- path/header/body machine mismatch
- invalid HMAC signature
- timestamp outside the allowed skew window
- invalid JSON
- invalid snapshot schema
- payloads above the maximum size

Recommended defaults:

| Setting | Value |
|---------|-------|
| Allowed timestamp skew | 5 minutes |
| Max payload size | 256 KiB |
| Secret scope | one secret per machine |

Secrets belong in environment variables only. Do not commit them.

## Post-Only Client

`constellation-post.sh` is the Phase 2 machine client.

Required environment:

```bash
export CONSTELLATION_ENDPOINT="https://constellation-api.example.workers.dev"
export CONSTELLATION_SECRET="..."
```

Optional environment:

```bash
export CONSTELLATION_MACHINE="linux"
export CONSTELLATION_DEFAULT_NAME="CLU"
export CONSTELLATION_SNAPSHOT_OUT="/tmp/linux_agents.json"
```

Run:

```bash
bash constellation-post.sh
```

The script:

1. Collects a fresh snapshot into a temp file
2. Validates it locally
3. Signs the exact request body
4. POSTs it to `/v1/snapshots/{machine}`

It deliberately does not call git.

## Future Read Endpoints

The telemetry service should eventually expose:

```http
GET /agents.json
GET /v1/machines
GET /v1/health
```

`GET /agents.json` becomes the frontend data source. It should derive the merged graph server-side using the same merge semantics currently in `merge_agents.py`.

## Deployment Target

Preferred backend:

```text
Cloudflare Worker + D1
```

D1 should store:

- latest snapshot per machine
- heartbeat/history rows for uptime and change tracking

The static GitHub Pages frontend can remain in place and fetch the Worker URL for `agents.json` once CORS and cache behavior are verified.

## Cutover Rule

Do not disable the git-based cron until all are true:

- `constellation-post.sh` succeeds from linux
- endpoint validates signatures and schema
- endpoint serves a merged `/agents.json`
- frontend can load Worker-backed data
- stale/offline behavior matches Phase 1 output
