const SHARED_SERVICES = new Set(['telegram', 'discord', 'slack', 'whatsapp', 'signal', 'mattermost', 'matrix', 'webhook']);
// Any agent id with one of these prefixes is treated as a shared cross-machine
// node (no machine-tag scoping during merge). Used for repo:, guild:, etc.
const SHARED_SERVICE_PREFIXES = ['repo:', 'guild:'];
function isSharedService(id) {
  if (SHARED_SERVICES.has(id)) return true;
  for (const prefix of SHARED_SERVICE_PREFIXES) {
    if (id.startsWith(prefix)) return true;
  }
  return false;
}
const SCHEMA_VERSION = 1;
const STALE_AFTER_SECONDS = 10 * 60;
const OFFLINE_AFTER_SECONDS = 60 * 60;
const MAX_SKEW_SECONDS = 5 * 60;
const MAX_BODY_BYTES = 256 * 1024;

const encoder = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    // The three Langfuse jobs hit different endpoints with different quota
    // buckets, so don't gate them on each other:
    //   - tagLangfuseTraces  → /api/public/traces + /api/public/ingestion
    //   - refreshLangfuseAggregate, refreshLangfusePerAgent
    //                        → /api/public/metrics/daily (heavily quota'd on
    //                          free tier; retry-after can be hours)
    //
    // Run the tagger every tick so it stays caught up on new traces. Run the
    // metrics/daily jobs at most once per hour so the daily quota isn't
    // burned by the 15-minute cron.
    ctx.waitUntil((async () => {
      const tag = await tagLangfuseTraces(env);
      if (tag && tag.reason === 'rate_limited') {
        console.log('scheduled: tagger 429 this tick');
      }

      const minute = new Date().getUTCMinutes();
      const isHourlyTick = minute < 15;
      if (!isHourlyTick) {
        console.log(`scheduled: minute=${minute}, skipping metrics/daily jobs (hourly cadence)`);
        return;
      }
      const agg = await refreshLangfuseAggregate(env);
      if (agg && agg.reason === 'rate_limited') {
        console.log('scheduled: aggregate 429, skipping per-agent this tick');
        return;
      }
      await refreshLangfusePerAgent(env);
    })());
    // Phase B will add: ctx.waitUntil(refreshDiscordGuilds(env));
  },
};

export async function handleRequest(request, env, ctx = {}, now = new Date()) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') return corsResponse(null, { status: 204 });

  if (request.method === 'GET' && url.pathname === '/v1/health') {
    return json({ ok: true, service: 'constellation-telemetry', now: now.toISOString() });
  }

  if (request.method === 'GET' && url.pathname === '/v1/machines') {
    const snapshots = await loadSnapshots(env.DB);
    return json({ machines: snapshots.map((s) => machineSummary(s.snapshot, s.received_at, now)) });
  }

  if (request.method === 'GET' && url.pathname === '/agents.json') {
    const [snapshots, usageRows] = await Promise.all([
      loadSnapshots(env.DB),
      loadUsageRows(env.DB, null, 35),
    ]);
    return json(mergeSnapshots(snapshots.map((s) => s.snapshot), now, usageRows));
  }

  if (request.method === 'GET' && url.pathname === '/v1/usage') {
    return handleUsageGet(url, env, now);
  }

  if (request.method === 'GET' && url.pathname === '/v1/layout') {
    return handleLayoutGet(env);
  }

  if (request.method === 'POST' && url.pathname === '/v1/layout') {
    return handleLayoutPost(request, env, now);
  }

  if (request.method === 'DELETE' && url.pathname === '/v1/layout') {
    return handleLayoutDelete(request, env);
  }

  const layoutItemMatch = url.pathname.match(/^\/v1\/layout\/([^/]+)$/);
  if (request.method === 'DELETE' && layoutItemMatch) {
    return handleLayoutDeleteOne(request, env, decodeURIComponent(layoutItemMatch[1]));
  }

  const match = url.pathname.match(/^\/v1\/snapshots\/([^/]+)$/);
  if (request.method === 'POST' && match) {
    return handleSnapshotPost(request, env, decodeURIComponent(match[1]), now);
  }

  return json({ error: 'not_found' }, { status: 404 });
}

async function handleSnapshotPost(request, env, pathMachine, now) {
  const body = await request.text();
  if (encoder.encode(body).byteLength > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large' }, { status: 413 });
  }

  const headerMachine = request.headers.get('x-constellation-machine') || '';
  const timestamp = request.headers.get('x-constellation-timestamp') || '';
  const signature = request.headers.get('x-constellation-signature') || '';

  if (!headerMachine || !timestamp || !signature) {
    return json({ error: 'missing_signature_headers' }, { status: 400 });
  }
  if (headerMachine !== pathMachine) {
    return json({ error: 'machine_mismatch' }, { status: 400 });
  }

  const skewError = validateTimestampSkew(timestamp, now);
  if (skewError) return json({ error: skewError }, { status: 401 });

  let snapshot;
  try {
    snapshot = JSON.parse(body);
  } catch {
    return json({ error: 'invalid_json' }, { status: 400 });
  }

  if (snapshot?.machine?.tag !== pathMachine) {
    return json({ error: 'machine_mismatch' }, { status: 400 });
  }

  const validationErrors = validateSnapshot(snapshot);
  if (validationErrors.length) {
    return json({ error: 'invalid_snapshot', details: validationErrors }, { status: 400 });
  }

  const secret = secretForMachine(env, pathMachine);
  if (!secret) return json({ error: 'unknown_machine' }, { status: 403 });

  const valid = await verifySignature(secret, timestamp, pathMachine, body, signature);
  if (!valid) return json({ error: 'invalid_signature' }, { status: 401 });

  const receivedAt = now.toISOString();
  const agentCount = Object.values(snapshot.agents || {}).filter((a) => a.type === 'agent').length;
  const gatewayState = snapshot.gateway?.state || null;

  await env.DB.prepare(`
    INSERT INTO latest_snapshots (machine_id, hostname, os, snapshot_json, schema_version, collected_at, received_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(machine_id) DO UPDATE SET
      hostname=excluded.hostname,
      os=excluded.os,
      snapshot_json=excluded.snapshot_json,
      schema_version=excluded.schema_version,
      collected_at=excluded.collected_at,
      received_at=excluded.received_at,
      updated_at=excluded.updated_at
  `).bind(
    pathMachine,
    snapshot.machine.hostname,
    snapshot.machine.os,
    body,
    snapshot.schema_version,
    snapshot.collected_at,
    receivedAt,
    receivedAt,
  ).run();

  await env.DB.prepare(`
    INSERT INTO snapshot_events (machine_id, collected_at, received_at, agent_count, gateway_state, snapshot_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(pathMachine, snapshot.collected_at, receivedAt, agentCount, gatewayState, body).run();

  return json({ ok: true, machine: pathMachine, received_at: receivedAt });
}

async function loadSnapshots(db) {
  const rows = await db.prepare(`
    SELECT machine_id, hostname, os, snapshot_json, schema_version, collected_at, received_at
    FROM latest_snapshots
    ORDER BY machine_id ASC
  `).all();
  return (rows.results || []).map((row) => ({ ...row, snapshot: JSON.parse(row.snapshot_json) }));
}

export function validateSnapshot(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['snapshot must be an object'];
  if (![1, 2].includes(data.schema_version)) errors.push('schema_version must be 1 or 2');
  if (!isObject(data.machine)) {
    errors.push('machine must be an object');
  } else {
    for (const field of ['tag', 'hostname', 'os']) {
      if (typeof data.machine[field] !== 'string' || !data.machine[field].trim()) errors.push(`machine.${field} is required`);
    }
  }
  if (!parseTimestamp(data.collected_at)) errors.push('collected_at must be an ISO timestamp');
  if (!isObject(data.gateway)) errors.push('gateway must be an object');
  if (!isObject(data.agents)) {
    errors.push('agents must be an object');
  } else {
    for (const [id, agent] of Object.entries(data.agents)) {
      if (!isObject(agent)) {
        errors.push(`agents.${id} must be an object`);
        continue;
      }
      for (const field of ['id', 'label', 'type']) {
        if (typeof agent[field] !== 'string' || !agent[field].trim()) errors.push(`agents.${id}.${field} is required`);
      }
      if (agent.type && !['infra', 'agent', 'service'].includes(agent.type)) errors.push(`agents.${id}.type is invalid`);
    }
  }
  if (!Array.isArray(data.edges)) {
    errors.push('edges must be an array');
  } else {
    data.edges.forEach((edge, idx) => {
      if (!Array.isArray(edge) || edge.length !== 4 || edge.some((v) => typeof v !== 'string' || !v)) {
        errors.push(`edges[${idx}] must be [from, to, type, color]`);
      }
    });
  }
  return errors;
}

export function mergeSnapshots(dataList, now = new Date(), usageRows = []) {
  const merged = {
    schema_version: SCHEMA_VERSION,
    generated_at: now.toISOString(),
    machines: [],
    agents: {},
    edges: [],
    gateway: {},
  };
  const machineDefaults = new Map();

  for (const data of dataList) {
    const machine = data.machine || {};
    const machineTag = machine.tag || machine.hostname || 'unknown';
    const collectedAt = data.collected_at;
    const { status, age_seconds } = machineStatus(collectedAt, now);

    merged.machines.push({
      tag: machineTag,
      hostname: machine.hostname || '',
      os: machine.os || '',
      last_seen_at: collectedAt,
      age_seconds,
      status,
    });

    merged.gateway[machineTag] = {
      ...(data.gateway || {}),
      last_seen_at: collectedAt,
      age_seconds,
      status,
    };

    for (const [agentId, originalAgent] of Object.entries(data.agents || {})) {
      const annotated = annotateNode(originalAgent, status, age_seconds, collectedAt);
      if (isSharedService(agentId)) {
        // Last writer wins for shared service nodes — fine: their content
        // (e.g. repo url) is identical across machines that connect to them.
        merged.agents[agentId] = annotated;
        continue;
      }
      const scopedId = `${machineTag}_${agentId}`;
      annotated.machine = machineTag;
      annotated.id = scopedId;
      merged.agents[scopedId] = annotated;
      if (originalAgent.sublabel === '[default]') machineDefaults.set(machineTag, scopedId);
    }

    for (const edge of data.edges || []) {
      if (!Array.isArray(edge) || edge.length < 4) continue;
      let [fromId, toId, type, color] = edge;
      if (!isSharedService(fromId)) fromId = `${machineTag}_${fromId}`;
      if (!isSharedService(toId)) toId = `${machineTag}_${toId}`;
      merged.edges.push([fromId, toId, type, color]);
    }
  }

  if (usageRows && usageRows.length) injectUsage(merged, usageRows);

  return merged;
}

export function injectUsage(merged, usageRows) {
  const aggregateRows = usageRows.filter((r) => r.agent_id === '__aggregate__');
  if (aggregateRows.length) {
    const r24 = computeRollup(aggregateRows, 1);
    const r7  = computeRollup(aggregateRows, 7);
    const r30 = computeRollup(aggregateRows, 30);
    const rAll = computeRollup(aggregateRows, null);
    merged.meta = {
      ...(merged.meta || {}),
      usage_24h: {
        total_tokens: r24.totals.total_tokens,
        cost_usd: r24.totals.cost_usd,
        input_tokens: r24.totals.input_tokens,
        output_tokens: r24.totals.output_tokens,
      },
      usage_aggregate: {
        '24h': r24.totals,
        '7d':  r7.totals,
        '30d': r30.totals,
        all:   rAll.totals,
        daily: rAll.daily,
      },
    };
  }

  const perAgent = new Map();
  for (const r of usageRows) {
    if (r.agent_id === '__aggregate__') continue;
    const arr = perAgent.get(r.agent_id) || [];
    arr.push(r);
    perAgent.set(r.agent_id, arr);
  }
  if (perAgent.size) {
    const labelIndex = new Map();
    for (const [scopedId, agent] of Object.entries(merged.agents)) {
      if (agent && agent.type === 'agent' && typeof agent.label === 'string') {
        const existing = labelIndex.get(agent.label);
        if (existing) existing.push(scopedId);
        else labelIndex.set(agent.label, [scopedId]);
      }
    }
    for (const [name, rows] of perAgent) {
      const scopedIds = labelIndex.get(name);
      if (!scopedIds) continue;
      const r24 = computeRollup(rows, 1);
      const r7  = computeRollup(rows, 7);
      const r30 = computeRollup(rows, 30);
      const rAll = computeRollup(rows, null);
      const usage = {
        '24h': r24.totals,
        '7d':  r7.totals,
        '30d': r30.totals,
        all:   rAll.totals,
        daily: rAll.daily,
      };
      for (const scopedId of scopedIds) {
        merged.agents[scopedId] = {
          ...merged.agents[scopedId],
          details: {
            ...(merged.agents[scopedId].details || {}),
            usage,
          },
        };
      }
    }
  }
}

export function computeRollup(rows, windowDays) {
  const sorted = [...rows].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  let filtered = sorted;
  if (windowDays === 1) {
    // 24h window. Data is bucketed by UTC day, so a strict "day == today"
    // filter returns 0 between UTC midnight and the next Langfuse refresh
    // (we've seen the header read 0 at ~01:00 UTC for that reason). Take
    // the most recent day-bucket we have instead — that's the freshest
    // 24h-ish slice of data available.
    const latestDay = sorted.length ? sorted[sorted.length - 1].day : null;
    filtered = latestDay ? sorted.filter((r) => r.day === latestDay) : [];
  } else if (windowDays != null) {
    // windowDays = N → include today and the (N-1) days before it
    const cutoff = new Date(Date.now() - (windowDays - 1) * 86400 * 1000);
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    filtered = sorted.filter((r) => r.day >= cutoffDay);
  }
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
    trace_count: 0,
  };
  for (const r of filtered) {
    totals.input_tokens  += r.input_tokens  || 0;
    totals.output_tokens += r.output_tokens || 0;
    totals.total_tokens  += r.total_tokens  || 0;
    totals.cost_usd      += r.cost_usd      || 0;
    totals.trace_count   += r.trace_count   || 0;
  }
  const daily = sorted.map((r) => ({
    day: r.day,
    total_tokens: r.total_tokens || 0,
    cost_usd: r.cost_usd || 0,
  }));
  return { totals, daily };
}

export async function loadUsageRows(db, agentId = null, days = 35) {
  const cutoffDay = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
  let stmt;
  if (agentId) {
    stmt = db.prepare(
      `SELECT agent_id, day, input_tokens, output_tokens, total_tokens, cost_usd, trace_count, model_breakdown, fetched_at
       FROM usage_daily WHERE agent_id = ? AND day >= ? ORDER BY day ASC`
    ).bind(agentId, cutoffDay);
  } else {
    stmt = db.prepare(
      `SELECT agent_id, day, input_tokens, output_tokens, total_tokens, cost_usd, trace_count, model_breakdown, fetched_at
       FROM usage_daily WHERE day >= ? ORDER BY agent_id ASC, day ASC`
    ).bind(cutoffDay);
  }
  // Resilient to missing table — pre-migration, this just returns []
  // so /agents.json never breaks waiting on the usage_daily migration.
  try {
    const rows = await stmt.all();
    return rows.results || [];
  } catch (err) {
    console.log(`loadUsageRows: query failed (${err.message}), returning empty`);
    return [];
  }
}

async function handleUsageGet(url, env, now) {
  const param = url.searchParams.get('window') || '24h';
  const windowMap = { '24h': 1, '7d': 7, '30d': 30, 'all': null };
  if (!(param in windowMap)) {
    return json({ error: 'invalid_window', allowed: Object.keys(windowMap) }, { status: 400 });
  }
  const agentId = url.searchParams.get('agent_id') || '__aggregate__';
  const rows = await loadUsageRows(env.DB, agentId, 35);
  const main = computeRollup(rows, windowMap[param]);
  const by_window = {};
  for (const [name, days] of Object.entries(windowMap)) {
    by_window[name] = computeRollup(rows, days).totals;
  }
  const by_agent = {};
  if (agentId === '__aggregate__') {
    const allRows = await loadUsageRows(env.DB, null, 35);
    const grouped = new Map();
    for (const r of allRows) {
      if (r.agent_id === '__aggregate__') continue;
      const arr = grouped.get(r.agent_id) || [];
      arr.push(r);
      grouped.set(r.agent_id, arr);
    }
    for (const [name, agentRows] of grouped) {
      by_agent[name] = computeRollup(agentRows, windowMap[param]).totals;
    }
  }
  return json({
    agent_id: agentId,
    window: param,
    as_of: now.toISOString(),
    totals: main.totals,
    daily: main.daily,
    by_window,
    by_agent,
  });
}

function langfuseEnv(env, logPrefix) {
  const host   = env.LANGFUSE_HOST;
  const pub    = env.LANGFUSE_PUBLIC_KEY;
  const secret = env.LANGFUSE_SECRET_KEY;
  if (!host || !pub || !secret) {
    console.log(`${logPrefix}: missing Langfuse env, skipping`);
    return { ok: false, reason: 'missing_env' };
  }
  const hostTrimmed = String(host).trim().replace(/\/+$/, '');
  let parsedHost;
  try { parsedHost = new URL(hostTrimmed); } catch { parsedHost = null; }
  if (!parsedHost || !/^https?:$/.test(parsedHost.protocol)) {
    console.log(`${logPrefix}: malformed LANGFUSE_HOST (length=${String(host).length} prefix=${JSON.stringify(String(host).slice(0, 40))})`);
    return { ok: false, reason: 'bad_host' };
  }
  const auth = `Basic ${btoa(`${pub}:${secret}`)}`;
  return { ok: true, hostTrimmed, auth };
}

async function fetchLangfuseDaily(env, { tag = null, fetchImpl = fetch, now = new Date(), logPrefix }) {
  const e = langfuseEnv(env, logPrefix);
  if (!e.ok) return e;
  const from = new Date(now.getTime() - 30 * 86400 * 1000).toISOString();
  const to   = now.toISOString();
  const params = new URLSearchParams({ fromTimestamp: from, toTimestamp: to });
  if (tag) params.set('tags', tag);
  const endpoint = `${e.hostTrimmed}/api/public/metrics/daily?${params.toString()}`;

  let res;
  try {
    res = await fetchImpl(endpoint, { headers: { authorization: e.auth } });
  } catch (err) {
    console.log(`${logPrefix}: fetch failed: ${err.message}`);
    return { ok: false, reason: 'fetch_error' };
  }
  if (res.status === 429) {
    console.log(`${logPrefix}: 429 rate limited, retry-after=${res.headers.get('retry-after')}`);
    return { ok: false, reason: 'rate_limited' };
  }
  if (!res.ok) {
    console.log(`${logPrefix}: HTTP ${res.status}`);
    return { ok: false, reason: `http_${res.status}` };
  }

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    console.log(`${logPrefix}: invalid JSON: ${err.message}`);
    return { ok: false, reason: 'invalid_json' };
  }

  const rawRows = Array.isArray(payload) ? payload : (payload.data || []);
  const byDay = new Map();
  for (const r of rawRows) {
    const day = (r.date || '').slice(0, 10);
    if (!day) continue;
    const entry = byDay.get(day) || {
      input_tokens: 0, output_tokens: 0, total_tokens: 0,
      cost_usd: 0, trace_count: 0, models: {},
    };
    entry.cost_usd    += Number(r.totalCost   || 0);
    entry.trace_count += Number(r.countTraces || 0);
    const usageArr = Array.isArray(r.usage) ? r.usage : (r.usage ? [r.usage] : []);
    if (usageArr.length) {
      for (const u of usageArr) {
        entry.input_tokens  += Number(u.inputUsage  || 0);
        entry.output_tokens += Number(u.outputUsage || 0);
        entry.total_tokens  += Number(u.totalUsage  || 0);
        const modelName = u.model || 'unknown';
        const m = entry.models[modelName] || { tokens: 0, cost: 0 };
        m.tokens += Number(u.totalUsage || 0);
        m.cost   += Number(u.totalCost  || 0);
        entry.models[modelName] = m;
      }
    } else {
      entry.input_tokens  += Number(r.inputUsage  || 0);
      entry.output_tokens += Number(r.outputUsage || 0);
      entry.total_tokens  += Number(r.totalUsage  || 0);
      if (r.model) {
        const m = entry.models[r.model] || { tokens: 0, cost: 0 };
        m.tokens += Number(r.totalUsage || 0);
        m.cost   += Number(r.totalCost  || 0);
        entry.models[r.model] = m;
      }
    }
    byDay.set(day, entry);
  }
  return { ok: true, byDay };
}

async function upsertUsageDaily(db, agentId, byDay, fetchedAt) {
  const stmts = [];
  for (const [day, e] of byDay) {
    stmts.push(db.prepare(
      `INSERT INTO usage_daily (agent_id, day, input_tokens, output_tokens, total_tokens, cost_usd, trace_count, model_breakdown, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, day) DO UPDATE SET
         input_tokens=excluded.input_tokens,
         output_tokens=excluded.output_tokens,
         total_tokens=excluded.total_tokens,
         cost_usd=excluded.cost_usd,
         trace_count=excluded.trace_count,
         model_breakdown=excluded.model_breakdown,
         fetched_at=excluded.fetched_at`
    ).bind(
      agentId, day,
      e.input_tokens, e.output_tokens, e.total_tokens,
      e.cost_usd, e.trace_count,
      JSON.stringify(e.models), fetchedAt,
    ));
  }
  if (stmts.length) await db.batch(stmts);
}

export async function refreshLangfuseAggregate(env, fetchImpl = fetch, now = new Date()) {
  const logPrefix = 'refreshLangfuseAggregate';
  const result = await fetchLangfuseDaily(env, { tag: null, fetchImpl, now, logPrefix });
  if (!result.ok) return result;
  const { byDay } = result;

  await upsertUsageDaily(env.DB, '__aggregate__', byDay, now.toISOString());

  await env.DB.prepare(
    `DELETE FROM usage_daily WHERE agent_id = '__aggregate__' AND day < date('now','-35 days')`
  ).run();

  let totalTokens = 0;
  let totalCost = 0;
  for (const e of byDay.values()) {
    totalTokens += e.total_tokens;
    totalCost   += e.cost_usd;
  }
  console.log(`${logPrefix}: ok days=${byDay.size} tokens=${totalTokens} cost=$${totalCost.toFixed(2)}`);

  return { ok: true, days: byDay.size };
}

async function loadAgentNamesForUsage(db) {
  const snaps = await loadSnapshots(db);
  const names = new Set();
  for (const s of snaps) {
    for (const a of Object.values(s.snapshot.agents || {})) {
      if (a && a.type === 'agent' && typeof a.label === 'string' && a.label.trim()) {
        names.add(a.label.trim());
      }
    }
  }
  return [...names];
}

export async function refreshLangfusePerAgent(env, fetchImpl = fetch, now = new Date()) {
  const logPrefix = 'refreshLangfusePerAgent';
  const envCheck = langfuseEnv(env, logPrefix);
  if (!envCheck.ok) return envCheck;

  let names;
  try {
    names = await loadAgentNamesForUsage(env.DB);
  } catch (err) {
    console.log(`${logPrefix}: failed to load agent names: ${err.message}`);
    return { ok: false, reason: 'load_agents_failed' };
  }
  if (!names.length) {
    console.log(`${logPrefix}: no agents found in latest_snapshots, skipping`);
    return { ok: true, agents: 0 };
  }

  const fetchedAt = now.toISOString();
  let okCount = 0;
  let failCount = 0;
  let totalDays = 0;
  let totalTokens = 0;
  for (const name of names) {
    const result = await fetchLangfuseDaily(env, {
      tag: `agent:${name}`,
      fetchImpl,
      now,
      logPrefix: `${logPrefix}[${name}]`,
    });
    if (!result.ok) {
      failCount += 1;
      if (result.reason === 'rate_limited') break;
      continue;
    }
    await upsertUsageDaily(env.DB, name, result.byDay, fetchedAt);
    okCount += 1;
    totalDays += result.byDay.size;
    for (const e of result.byDay.values()) totalTokens += e.total_tokens;
  }

  await env.DB.prepare(
    `DELETE FROM usage_daily WHERE agent_id != '__aggregate__' AND day < date('now','-35 days')`
  ).run();

  console.log(`${logPrefix}: ok agents=${okCount}/${names.length} fails=${failCount} days=${totalDays} tokens=${totalTokens}`);
  return { ok: true, agents: okCount, fails: failCount };
}

// ── Trace tagger ────────────────────────────────────────────────────────────
// Hermes doesn't tag traces with agent:<name> yet, but every trace's first
// system/developer message starts with one of these shapes:
//   "# SOUL.md — CAAC"
//   "# TRON — Security Program | ENCOM System"
// We sniff the input, extract the name, and write the tag back to Langfuse so
// the existing tag-based refreshLangfusePerAgent flow picks it up next tick.

function _firstMessageContent(input) {
  if (input == null) return null;
  if (typeof input === 'string') {
    // Fast path: extract the first "content":"..." substring up to the first
    // newline escape without parsing the entire JSON. Trace.input can be
    // 100KB+ (full conversation history); calling JSON.parse on every trace
    // exceeded the Worker CPU budget during backfill.
    // Bounded work: scan at most the first 4KB and capture up to 300 chars.
    const head = input.length > 4096 ? input.slice(0, 4096) : input;
    const m = head.match(/"content"\s*:\s*"([^"\\]{0,300})/);
    if (m) {
      // The downstream extractor only looks at the first line, so stopping
      // at the first unescaped quote or capturing 300 chars is enough.
      return m[1];
    }
    // No structured content found — treat raw input as text.
    return input;
  }
  if (typeof input === 'object') {
    let messages = null;
    if (Array.isArray(input.messages)) messages = input.messages;
    else if (Array.isArray(input)) messages = input;
    if (Array.isArray(messages) && messages.length) {
      const c = messages[0]?.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        const piece = c.find((p) => typeof p?.text === 'string');
        if (piece) return piece.text;
      }
    }
  }
  return null;
}

export function extractAgentNameFromTrace(trace) {
  if (!trace) return null;
  if (Array.isArray(trace.tags)) {
    for (const t of trace.tags) {
      if (typeof t === 'string' && t.startsWith('agent:')) return null; // already tagged
    }
  }
  const text = _firstMessageContent(trace.input);
  if (typeof text !== 'string' || !text.trim()) return null;
  const firstLine = text.split('\n', 1)[0].trim();

  // "# SOUL.md — NAME"  (em / en / hyphen all accepted)
  let m = firstLine.match(/^#\s+SOUL\.md\s*[—–-]\s*(.+?)\s*$/i);
  if (m && m[1]) return m[1].trim();

  // "# NAME — anything"  or  "# NAME"
  m = firstLine.match(/^#\s+([^—–]+?)(?:\s*[—–-]\s*.*)?$/);
  if (m && m[1]) return m[1].trim();

  return null;
}

async function postLangfuseTagBatch(env, fetchImpl, events, logPrefix) {
  const e = langfuseEnv(env, logPrefix);
  if (!e.ok) return e;
  const url = `${e.hostTrimmed}/api/public/ingestion`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: e.auth, 'content-type': 'application/json' },
      body: JSON.stringify({ batch: events }),
    });
  } catch (err) {
    console.log(`${logPrefix}: ingestion fetch failed: ${err.message}`);
    return { ok: false, reason: 'fetch_error' };
  }
  // Langfuse returns 207 multi-status for partial; treat 2xx as ok.
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
  console.log(`${logPrefix}: ingestion HTTP ${res.status}`);
  return { ok: false, reason: `http_${res.status}` };
}

export async function tagLangfuseTraces(env, fetchImpl = fetch, now = new Date()) {
  const logPrefix = 'tagLangfuseTraces';
  const e = langfuseEnv(env, logPrefix);
  if (!e.ok) return e;

  let knownNames;
  try {
    knownNames = new Set(await loadAgentNamesForUsage(env.DB));
  } catch (err) {
    console.log(`${logPrefix}: failed to load agent names: ${err.message}`);
    return { ok: false, reason: 'load_agents_failed' };
  }

  // Default 4h window — steady-state we just need to catch traces ingested
  // between cron ticks. Bump LANGFUSE_TAG_LOOKBACK_HOURS for a one-shot
  // backfill, then drop it back.
  const lookbackHours = Number(env.LANGFUSE_TAG_LOOKBACK_HOURS) || 4;
  const from = new Date(now.getTime() - lookbackHours * 3600 * 1000).toISOString();
  const to   = now.toISOString();
  const limit = 100;
  // Steady-state we expect tens of traces per tick. Cap kept low to bound
  // CPU + Langfuse calls per cron invocation. Override via env for backfill.
  // NOTE: do not raise this without testing — each Langfuse trace input can
  // be tens of KB (full conversation prompts), and a single Worker invocation
  // has a 128MB ceiling. We stream page-by-page below, but each page still
  // sits in memory while we process it.
  const MAX_PAGES = Number(env.LANGFUSE_TAG_MAX_PAGES) || 5; // 500 traces / tick
  // Flush tag-events to Langfuse ingestion in chunks so they don't pile up
  // across many pages during a backfill.
  const CHUNK = 50;

  let scanned = 0;
  let posted = 0;
  let queued = 0;
  let skippedAlreadyTagged = 0;
  let skippedNoMatch = 0;
  let skippedUnknown = 0;
  // Sample of names rejected by the knownNames filter — surfaced in the
  // final log line so we can diagnose label mismatches (casing, decoration,
  // genuinely-unknown agents) without dumping every trace.
  const unknownSamples = new Map(); // name → count
  let events = [];
  let abortReason = null;

  async function flush() {
    while (events.length >= CHUNK) {
      const chunk = events.slice(0, CHUNK);
      events = events.slice(CHUNK);
      const result = await postLangfuseTagBatch(env, fetchImpl, chunk, logPrefix);
      if (!result.ok) {
        abortReason = result.reason;
        return false;
      }
      posted += chunk.length;
    }
    return true;
  }

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = `${e.hostTrimmed}/api/public/traces?fromTimestamp=${encodeURIComponent(from)}&toTimestamp=${encodeURIComponent(to)}&page=${page}&limit=${limit}`;
    let res;
    try {
      res = await fetchImpl(url, { headers: { authorization: e.auth } });
    } catch (err) {
      console.log(`${logPrefix}: fetch failed page=${page}: ${err.message}`);
      abortReason = 'fetch_error';
      break;
    }
    if (res.status === 429) {
      console.log(`${logPrefix}: 429 rate limited page=${page}`);
      abortReason = 'rate_limited';
      break;
    }
    if (!res.ok) {
      console.log(`${logPrefix}: HTTP ${res.status} page=${page}`);
      abortReason = `http_${res.status}`;
      break;
    }
    let payload;
    try { payload = await res.json(); } catch (err) {
      console.log(`${logPrefix}: invalid JSON page=${page}: ${err.message}`);
      abortReason = 'invalid_json';
      break;
    }
    const batch = Array.isArray(payload) ? payload : (payload.data || []);
    if (!batch.length) { payload = null; break; }

    // Process page inline so trace bodies (which can be large) don't stay
    // in memory across pages.
    for (const trace of batch) {
      scanned += 1;
      if (!trace?.id) continue;
      if (Array.isArray(trace.tags) && trace.tags.some((t) => typeof t === 'string' && t.startsWith('agent:'))) {
        skippedAlreadyTagged += 1;
        continue;
      }
      const name = extractAgentNameFromTrace(trace);
      if (!name) { skippedNoMatch += 1; continue; }
      if (knownNames.size && !knownNames.has(name)) {
        skippedUnknown += 1;
        unknownSamples.set(name, (unknownSamples.get(name) || 0) + 1);
        continue;
      }

      const existing = Array.isArray(trace.tags) ? trace.tags.filter((t) => typeof t === 'string') : [];
      const mergedTags = Array.from(new Set([...existing, `agent:${name}`]));
      events.push({
        id: `tag-${trace.id}-${now.getTime()}`,
        timestamp: now.toISOString(),
        type: 'trace-create',
        body: { id: trace.id, tags: mergedTags },
      });
      queued += 1;
    }

    const totalPages = payload?.meta?.totalPages;
    const batchLen = batch.length;
    // Drop references before flushing to maximize GC headroom.
    payload = null;

    if (!(await flush())) break;

    if (totalPages != null && page >= totalPages) break;
    if (batchLen < limit) break;
  }

  // Final flush of any remainder (< CHUNK).
  if (!abortReason && events.length) {
    const chunk = events;
    events = [];
    const result = await postLangfuseTagBatch(env, fetchImpl, chunk, logPrefix);
    if (result.ok) posted += chunk.length;
    else abortReason = result.reason;
  }

  const status = abortReason ? `aborted=${abortReason}` : 'ok';
  console.log(`${logPrefix}: ${status} tagged=${posted}/${queued} scanned=${scanned} already=${skippedAlreadyTagged} nomatch=${skippedNoMatch} unknown=${skippedUnknown}`);
  if (unknownSamples.size) {
    const sorted = [...unknownSamples.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const known = [...knownNames].slice(0, 20).join(', ');
    console.log(`${logPrefix}: unknown-name samples (top 10): ${sorted.map(([n, c]) => `${JSON.stringify(n)}×${c}`).join(', ')}`);
    console.log(`${logPrefix}: knownNames (first 20 of ${knownNames.size}): ${known}`);
  }
  if (abortReason === 'rate_limited') return { ok: false, reason: 'rate_limited', tagged: posted, scanned };
  return { ok: true, tagged: posted, scanned };
}

function annotateNode(agent, status, ageSeconds, lastSeenAt) {
  return {
    ...agent,
    details: {
      ...(agent.details || {}),
      machine_status: status,
      machine_age_seconds: ageSeconds,
      machine_last_seen_at: lastSeenAt,
    },
  };
}

function machineSummary(snapshot, receivedAt, now) {
  const machine = snapshot.machine || {};
  const { status, age_seconds } = machineStatus(snapshot.collected_at, now);
  return {
    tag: machine.tag,
    hostname: machine.hostname,
    os: machine.os,
    last_seen_at: snapshot.collected_at,
    received_at: receivedAt,
    age_seconds,
    status,
  };
}

function machineStatus(collectedAt, now) {
  const seen = parseTimestamp(collectedAt);
  if (!seen) return { status: 'unknown', age_seconds: null };
  const age = Math.max(0, Math.floor((now.getTime() - seen.getTime()) / 1000));
  if (age >= OFFLINE_AFTER_SECONDS) return { status: 'offline', age_seconds: age };
  if (age >= STALE_AFTER_SECONDS) return { status: 'stale', age_seconds: age };
  return { status: 'online', age_seconds: age };
}

function validateTimestampSkew(timestamp, now) {
  const parsed = parseTimestamp(timestamp);
  if (!parsed) return 'invalid_timestamp';
  const skew = Math.abs(now.getTime() - parsed.getTime()) / 1000;
  if (skew > MAX_SKEW_SECONDS) return 'timestamp_out_of_range';
  return null;
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.endsWith('Z') ? value : value;
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) return null;
  return new Date(ms);
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function secretForMachine(env, machine) {
  if (env[`CONSTELLATION_SECRET_${machine.toUpperCase()}`]) return env[`CONSTELLATION_SECRET_${machine.toUpperCase()}`];
  if (!env.CONSTELLATION_SECRETS) return null;
  try {
    return JSON.parse(env.CONSTELLATION_SECRETS)[machine] || null;
  } catch {
    return null;
  }
}


async function handleLayoutGet(env) {
  const rows = await env.DB.prepare(
    'SELECT agent_id, x, y, updated_at FROM layout_overrides'
  ).all();
  const overrides = {};
  for (const row of rows.results || []) {
    overrides[row.agent_id] = { x: row.x, y: row.y, updated_at: row.updated_at };
  }
  return json({ overrides });
}

async function handleLayoutPost(request, env, now) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, { status: 400 });
  }
  const overrides = body && typeof body === 'object' ? body.overrides : null;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return json({ error: 'overrides_required' }, { status: 400 });
  }
  const updatedAt = now.toISOString();
  const stmts = [];
  let written = 0;
  for (const [agentId, pos] of Object.entries(overrides)) {
    if (typeof agentId !== 'string' || !agentId.trim()) continue;
    if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') continue;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO layout_overrides (agent_id, x, y, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         x=excluded.x, y=excluded.y, updated_at=excluded.updated_at`
    ).bind(agentId, pos.x, pos.y, updatedAt));
    written += 1;
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, written, updated_at: updatedAt });
}

async function handleLayoutDelete(request, env) {
  await env.DB.prepare('DELETE FROM layout_overrides').run();
  return json({ ok: true, cleared: true });
}

async function handleLayoutDeleteOne(request, env, agentId) {
  await env.DB.prepare('DELETE FROM layout_overrides WHERE agent_id = ?').bind(agentId).run();
  return json({ ok: true, deleted: agentId });
}

export async function bodySha256Hex(body) {
  const bytes = typeof body === 'string' ? encoder.encode(body) : body;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return hex(new Uint8Array(digest));
}

export async function buildSigningInput(timestamp, machine, body) {
  return `${timestamp}\n${machine}\n${await bodySha256Hex(body)}`;
}

export async function signSnapshot(secret, timestamp, machine, body) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(await buildSigningInput(timestamp, machine, body)));
  return `sha256=${hex(new Uint8Array(signature))}`;
}

async function verifySignature(secret, timestamp, machine, body, signature) {
  const expected = await signSnapshot(secret, timestamp, machine, body);
  return timingSafeEqual(expected, signature || '');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(body, init = {}) {
  return corsResponse(JSON.stringify(body, null, 2), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  });
}

function corsResponse(body, init = {}) {
  return new Response(body, {
    ...init,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'Content-Type, X-Constellation-Machine, X-Constellation-Timestamp, X-Constellation-Signature, Authorization',
      'cache-control': 'no-store',
      ...(init.headers || {}),
    },
  });
}
