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
    const snapshots = await loadSnapshots(env.DB);
    return json(mergeSnapshots(snapshots.map((s) => s.snapshot), now));
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
  if (data.schema_version !== 1) errors.push('schema_version must be 1');
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

export function mergeSnapshots(dataList, now = new Date()) {
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

  const defaults = [...machineDefaults.values()];
  for (let i = 0; i < defaults.length; i += 1) {
    for (let j = i + 1; j < defaults.length; j += 1) {
      merged.edges.push([defaults[i], defaults[j], 'cross-mesh', '#ff8c00']);
    }
  }

  return merged;
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
