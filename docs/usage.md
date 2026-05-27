# Langfuse Usage Stats

The Worker pulls Langfuse usage metrics on a 15-minute cron and serves them
back through `/v1/usage` (raw rollups) and `/agents.json` (`meta.usage_24h`
and `meta.usage_aggregate` used by the header + detail-panel Usage section).

Phase C ships the project-wide aggregate. Phase D adds the per-agent
breakdown: the Worker also pulls
`metrics/daily?tags=agent:<name>` for each agent name found in
`latest_snapshots` and attaches the per-agent rollup to
`agents[id].details.usage` in `/agents.json`. Per-agent numbers only
appear once Hermes is tagging traces with `agent:<name>`; until then the
per-agent fetches return empty data and the frontend falls back to the
project-wide aggregate.

## Setup

### 1. Generate API keys in Langfuse

Langfuse project settings → **API keys** → create a new key pair. The public
key starts with `pk-lf-…`, the secret with `sk-lf-…`.

### 2. Set the three Worker secrets

```sh
npx wrangler secret put LANGFUSE_PUBLIC_KEY --config worker/wrangler.toml
npx wrangler secret put LANGFUSE_SECRET_KEY --config worker/wrangler.toml
npx wrangler secret put LANGFUSE_HOST       --config worker/wrangler.toml
# value for LANGFUSE_HOST: https://us.cloud.langfuse.com (or your self-hosted URL)
```

`LANGFUSE_PROJECT_ID` is optional and documented only — the Worker doesn't
read it.

### 3. Apply the schema migration

```sh
npm run d1:migrate:remote
```

The `CREATE TABLE IF NOT EXISTS usage_daily (...)` clause is a forward-only
migration — re-running on an already-migrated DB is a no-op.

### 4. Deploy the Worker

```sh
npm run worker:deploy
```

The cron trigger (`*/15 * * * *`) is in `worker/wrangler.toml`. First cron
fire happens at the next quarter-hour boundary after deploy.

## Verifying

Tail the Worker logs:

```sh
npx wrangler tail --format=pretty --config worker/wrangler.toml
```

Within 15 minutes you should see a `refreshLangfuseAggregate` log line. To
confirm the rollups are populated:

```sh
curl https://constellation-telemetry.count-zr0.workers.dev/v1/usage?window=24h | jq .totals
```

And to confirm the header surface picks them up:

```sh
curl https://constellation-telemetry.count-zr0.workers.dev/agents.json | jq .meta
```

You should see `usage_24h` and `usage_aggregate` populated.

## Credential rotation

1. Generate a new key pair in Langfuse (keeps the old pair active).
2. `npx wrangler secret put LANGFUSE_PUBLIC_KEY` / `..._SECRET_KEY` with the
   new values.
3. Wait one cron cycle (≤15 min) — the next refresh uses the new keys.
4. Revoke the old key pair in Langfuse.

No downtime: the in-flight cron uses whichever pair was active when it
started; rollups already in D1 are served as-is from cache.

## Per-agent breakdown (Phase D)

Each cron tick the Worker first runs `tagLangfuseTraces`, which lists
recent Langfuse traces (rolling window, default 36h, override via
`LANGFUSE_TAG_LOOKBACK_HOURS`), sniffs each trace's first system /
developer message for an `# SOUL.md — NAME` or `# NAME — …` header,
and writes `tags: [...existing, agent:<NAME>]` back via
`POST /api/public/ingestion`. Only names that already appear as agent
labels in `latest_snapshots` are tagged — typos and unknown headers
are dropped. Traces that already carry an `agent:*` tag are skipped.

After the tagger runs, `refreshLangfusePerAgent` enumerates agent
labels from `latest_snapshots` and fetches
`metrics/daily?tags=agent:<label>` once per label. Rows land in
`usage_daily` keyed by the agent label as `agent_id`, and
`/agents.json` merges them into `agents[scopedId].details.usage` with
`24h` / `7d` / `30d` / `all` rollups plus a daily array for sparklines.

The detail-panel Usage table then shows per-agent numbers and hides the
"project-wide estimate" italic note. Agents that have no per-agent rows
(because Hermes isn't tagging traces yet for that name) continue to
fall back to the project-wide aggregate.

Expected latency before per-agent numbers appear: up to ~15 min cron lag
plus Langfuse ingest lag (~5 min).

Operational notes:

- A 429 from Langfuse on any agent short-circuits the rest of the loop
  for that cron tick; the next tick retries from scratch.
- Per-agent rows older than 35 days are pruned each tick.
- `GET /v1/usage?agent_id=<label>` returns the per-agent rollup for
  scripts and debugging; the default `agent_id=__aggregate__` also now
  populates `by_agent` with per-agent totals for the current window.
