# Langfuse Usage Stats

The Worker pulls Langfuse usage metrics on a 15-minute cron and serves them
back through `/v1/usage` (raw rollups) and `/agents.json` (`meta.usage_24h`
and `meta.usage_aggregate` used by the header + detail-panel Usage section).

Phase C ships the project-wide aggregate. Phase D ships the per-agent
breakdown after Hermes starts tagging traces with `agent:<name>`.

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

Once the Hermes trace-tagging PR lands and is deployed to every machine,
the Worker's `refreshLangfusePerAgent` job (added in Phase D) will pull
`metrics/daily?tags=agent:<name>` for each agent name found in
`latest_snapshots`. The detail-panel Usage table then shows per-agent
numbers instead of the project-wide aggregate, and the "project-wide
estimate" italic note disappears. See `phase-cd-plan.md` for the full
Phase D scope.

Expected latency before per-agent numbers appear: up to ~15 min cron lag
plus Langfuse ingest lag (~5 min).
