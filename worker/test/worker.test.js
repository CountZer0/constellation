import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleRequest,
  signSnapshot,
  mergeSnapshots,
  computeRollup,
  injectUsage,
  refreshLangfuseAggregate,
} from '../src/index.js';

class MockD1 {
  constructor() {
    this.latest = new Map();
    this.events = [];
    this.layout = new Map();
    this.usage = new Map(); // key = `${agent_id}|${day}`
  }

  prepare(sql) {
    return new MockStatement(this, sql);
  }

  async batch(stmts) {
    const results = [];
    for (const s of stmts) results.push(await s.run());
    return results;
  }
}

class MockStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  async run() {
    if (this.sql.includes('INSERT INTO latest_snapshots')) {
      const [machine_id, hostname, os, snapshot_json, schema_version, collected_at, received_at] = this.params;
      this.db.latest.set(machine_id, { machine_id, hostname, os, snapshot_json, schema_version, collected_at, received_at, updated_at: received_at });
      return { success: true };
    }
    if (this.sql.includes('INSERT INTO snapshot_events')) {
      const [machine_id, collected_at, received_at, agent_count, gateway_state, snapshot_json] = this.params;
      this.db.events.push({ machine_id, collected_at, received_at, agent_count, gateway_state, snapshot_json });
      return { success: true };
    }
    if (this.sql.includes('INSERT INTO layout_overrides')) {
      const [agent_id, x, y, updated_at] = this.params;
      this.db.layout.set(agent_id, { agent_id, x, y, updated_at });
      return { success: true };
    }
    if (this.sql.includes('DELETE FROM layout_overrides WHERE agent_id')) {
      this.db.layout.delete(this.params[0]);
      return { success: true };
    }
    if (this.sql.includes('DELETE FROM layout_overrides')) {
      this.db.layout.clear();
      return { success: true };
    }
    if (this.sql.includes('INSERT INTO usage_daily')) {
      const [agent_id, day, input_tokens, output_tokens, total_tokens, cost_usd, trace_count, model_breakdown, fetched_at] = this.params;
      this.db.usage.set(`${agent_id}|${day}`, {
        agent_id, day, input_tokens, output_tokens, total_tokens,
        cost_usd, trace_count, model_breakdown, fetched_at,
      });
      return { success: true };
    }
    if (this.sql.includes("DELETE FROM usage_daily WHERE agent_id = '__aggregate__'")) {
      return { success: true };
    }
    throw new Error(`Unhandled SQL run: ${this.sql}`);
  }

  async all() {
    if (this.sql.includes('FROM latest_snapshots')) {
      return { results: [...this.db.latest.values()].sort((a, b) => a.machine_id.localeCompare(b.machine_id)) };
    }
    if (this.sql.includes('FROM layout_overrides')) {
      return { results: [...this.db.layout.values()] };
    }
    if (this.sql.includes('FROM usage_daily')) {
      let rows = [...this.db.usage.values()];
      if (this.sql.includes('WHERE agent_id = ?')) {
        const [agentId, cutoffDay] = this.params;
        rows = rows.filter((r) => r.agent_id === agentId && r.day >= cutoffDay);
      } else if (this.sql.includes('WHERE day >= ?')) {
        const [cutoffDay] = this.params;
        rows = rows.filter((r) => r.day >= cutoffDay);
      }
      rows.sort((a, b) => (a.agent_id === b.agent_id ? a.day.localeCompare(b.day) : a.agent_id.localeCompare(b.agent_id)));
      return { results: rows };
    }
    throw new Error(`Unhandled SQL all: ${this.sql}`);
  }
}

function snapshot(machine, collectedAt = '2026-05-19T12:00:00Z') {
  return {
    schema_version: 1,
    machine: { tag: machine, hostname: `${machine}-host`, os: machine === 'win' ? 'Windows' : 'Linux' },
    gateway: { pid: 123, state: 'running' },
    agents: {
      host: { id: 'host', label: 'HOST', sublabel: machine, type: 'infra', color: '#00ff41', machine, details: {} },
      CLU: { id: 'CLU', label: 'CLU', sublabel: '[default]', type: 'agent', color: '#ff8c00', machine, details: { model: 'test', provider: 'test' } },
    },
    edges: [['host', 'CLU', 'sibling', '#444']],
    honcho_peers: [],
    collected_at: collectedAt,
  };
}

async function signedPost(env, machine, bodyObject, timestamp = '2026-05-19T12:00:00Z', secret = 'linux-secret') {
  const body = JSON.stringify(bodyObject);
  const signature = await signSnapshot(secret, timestamp, machine, body);
  return new Request(`https://example.test/v1/snapshots/${machine}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-constellation-machine': machine,
      'x-constellation-timestamp': timestamp,
      'x-constellation-signature': signature,
    },
    body,
  });
}

test('POST /v1/snapshots/:machine rejects invalid signature', async () => {
  const env = { DB: new MockD1(), CONSTELLATION_SECRETS: JSON.stringify({ linux: 'linux-secret' }) };
  const body = JSON.stringify(snapshot('linux'));
  const request = new Request('https://example.test/v1/snapshots/linux', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-constellation-machine': 'linux',
      'x-constellation-timestamp': '2026-05-19T12:00:00Z',
      'x-constellation-signature': 'sha256=bad',
    },
    body,
  });

  const response = await handleRequest(request, env, {}, new Date('2026-05-19T12:00:30Z'));

  assert.equal(response.status, 401);
  assert.equal(env.DB.latest.size, 0);
});

test('POST /v1/snapshots/:machine validates, stores latest snapshot, and records event', async () => {
  const env = { DB: new MockD1(), CONSTELLATION_SECRETS: JSON.stringify({ linux: 'linux-secret' }) };
  const request = await signedPost(env, 'linux', snapshot('linux'));

  const response = await handleRequest(request, env, {}, new Date('2026-05-19T12:00:30Z'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(env.DB.latest.get('linux').hostname, 'linux-host');
  assert.equal(env.DB.events.length, 1);
});

test('GET /agents.json serves server-side merged graph with machine status', async () => {
  const env = { DB: new MockD1(), CONSTELLATION_SECRETS: JSON.stringify({ linux: 'linux-secret', win: 'win-secret' }) };
  await handleRequest(await signedPost(env, 'linux', snapshot('linux', '2026-05-19T12:00:00Z'), '2026-05-19T12:00:00Z', 'linux-secret'), env, {}, new Date('2026-05-19T12:00:30Z'));
  await handleRequest(await signedPost(env, 'win', snapshot('win', '2026-05-19T10:00:00Z'), '2026-05-19T12:00:00Z', 'win-secret'), env, {}, new Date('2026-05-19T12:00:30Z'));

  const response = await handleRequest(new Request('https://example.test/agents.json'), env, {}, new Date('2026-05-19T12:00:30Z'));
  const graph = await response.json();

  assert.equal(response.status, 200);
  assert.equal(graph.schema_version, 1);
  assert.deepEqual(graph.machines.map((m) => [m.tag, m.status]), [['linux', 'online'], ['win', 'offline']]);
  assert.ok(graph.agents.linux_CLU);
  assert.ok(graph.agents.win_CLU);
  assert.ok(graph.edges.some((edge) => edge[2] === 'cross-mesh'));
});

test('GET /v1/health returns ok', async () => {
  const response = await handleRequest(new Request('https://example.test/v1/health'), { DB: new MockD1(), CONSTELLATION_SECRETS: '{}' }, {}, new Date('2026-05-19T12:00:30Z'));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
});

test('mergeSnapshots: repo: ids stay shared (no machine-tag scoping)', () => {
  const macSnap = {
    schema_version: 1,
    machine: { tag: 'mac', hostname: 'mbp', os: 'Darwin' },
    gateway: { state: 'running' },
    collected_at: new Date().toISOString(),
    agents: {
      count: { id: 'count', label: 'Count', type: 'agent', sublabel: '[default]' },
      'repo:CountZer0/hermes-skills': {
        id: 'repo:CountZer0/hermes-skills',
        label: 'CountZer0/hermes-skills',
        type: 'service',
        color: '#9b59b6',
        shape: 'square',
      },
    },
    edges: [['count', 'repo:CountZer0/hermes-skills', 'repo', '#9b59b6']],
  };
  const winSnap = {
    schema_version: 1,
    machine: { tag: 'win', hostname: 'cyber7', os: 'Windows' },
    gateway: { state: 'running' },
    collected_at: new Date().toISOString(),
    agents: {
      tron: { id: 'tron', label: 'TRON', type: 'agent', sublabel: '[default]' },
      'repo:CountZer0/hermes-skills': {
        id: 'repo:CountZer0/hermes-skills',
        label: 'CountZer0/hermes-skills',
        type: 'service',
        color: '#9b59b6',
        shape: 'square',
      },
    },
    edges: [['tron', 'repo:CountZer0/hermes-skills', 'repo', '#9b59b6']],
  };
  const merged = mergeSnapshots([macSnap, winSnap]);

  // The shared repo node must appear exactly once, unscoped.
  assert.ok(merged.agents['repo:CountZer0/hermes-skills'],
    'shared repo node should be merged under its unscoped id');
  assert.equal(Object.keys(merged.agents).filter(id => id.includes('hermes-skills')).length, 1,
    'should not be machine-prefixed copies of the shared repo node');

  // Both agents' edges should point to the shared id; default agents themselves
  // get machine-prefixed.
  const repoEdges = merged.edges.filter(e => e[2] === 'repo');
  assert.equal(repoEdges.length, 2);
  for (const [from, to] of repoEdges) {
    assert.equal(to, 'repo:CountZer0/hermes-skills',
      'repo edge target must remain unscoped');
    assert.ok(from === 'mac_count' || from === 'win_tron',
      `repo edge source must be machine-scoped agent id, got ${from}`);
  }
});

test('GET /v1/layout returns empty overrides initially', async () => {
  const env = { DB: new MockD1() };
  const req = new Request('https://example.test/v1/layout');
  const res = await handleRequest(req, env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { overrides: {} });
});

test('POST /v1/layout is public (no auth required) and persists overrides', async () => {
  const env = { DB: new MockD1() };
  const req = new Request('https://example.test/v1/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ overrides: { x: { x: 1, y: 2 } } }),
  });
  const res = await handleRequest(req, env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.written, 1);
});

test('POST /v1/layout persists overrides, GET returns them', async () => {
  const env = { DB: new MockD1() };
  const postReq = new Request('https://example.test/v1/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      overrides: {
        'mac_buddha': { x: 100, y: 200 },
        'repo:CountZer0/hermes-skills': { x: 300, y: 50 },
      },
    }),
  });
  const postRes = await handleRequest(postReq, env);
  assert.equal(postRes.status, 200);
  const postBody = await postRes.json();
  assert.equal(postBody.ok, true);
  assert.equal(postBody.written, 2);

  const getRes = await handleRequest(new Request('https://example.test/v1/layout'), env);
  const getBody = await getRes.json();
  assert.equal(getBody.overrides['mac_buddha'].x, 100);
  assert.equal(getBody.overrides['mac_buddha'].y, 200);
  assert.equal(getBody.overrides['repo:CountZer0/hermes-skills'].x, 300);
});

test('POST /v1/layout rejects non-finite coords', async () => {
  const env = { DB: new MockD1() };
  const req = new Request('https://example.test/v1/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      overrides: {
        ok:  { x: 1, y: 2 },
        bad: { x: 'NaN', y: 5 },          // wrong type
        inf: { x: Infinity, y: 0 },        // serializes to null, ignored
      },
    }),
  });
  const res = await handleRequest(req, env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.written, 1, 'only the well-formed entry should persist');
});

test('DELETE /v1/layout/<id> removes a single override', async () => {
  const env = { DB: new MockD1() };
  await handleRequest(new Request('https://example.test/v1/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ overrides: { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } } }),
  }), env);
  const delRes = await handleRequest(new Request('https://example.test/v1/layout/a', {
    method: 'DELETE',
  }), env);
  assert.equal(delRes.status, 200);
  const getRes = await handleRequest(new Request('https://example.test/v1/layout'), env);
  const body = await getRes.json();
  assert.equal(body.overrides['a'], undefined);
  assert.equal(body.overrides['b'].x, 3);
});

test('DELETE /v1/layout (bulk) clears all overrides', async () => {
  const env = { DB: new MockD1() };
  await handleRequest(new Request('https://example.test/v1/layout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ overrides: { a: { x: 1, y: 2 }, b: { x: 3, y: 4 } } }),
  }), env);
  const delRes = await handleRequest(new Request('https://example.test/v1/layout', {
    method: 'DELETE',
  }), env);
  assert.equal(delRes.status, 200);
  const body = await (await handleRequest(new Request('https://example.test/v1/layout'), env)).json();
  assert.deepEqual(body, { overrides: {} });
});

// ─── Phase C: Langfuse aggregate usage ─────────────────────────────────────

function dayOffset(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400 * 1000).toISOString().slice(0, 10);
}
function usageFixture(agentId = '__aggregate__', days = 35) {
  const rows = [];
  for (let i = 0; i < days; i += 1) {
    rows.push({
      agent_id: agentId,
      day: dayOffset(i),
      input_tokens: 1000 * (i + 1),
      output_tokens: 500 * (i + 1),
      total_tokens: 1500 * (i + 1),
      cost_usd: 0.5 * (i + 1),
      trace_count: 10,
      model_breakdown: '{}',
      fetched_at: new Date().toISOString(),
    });
  }
  return rows;
}

test('computeRollup: 24h/7d/30d/all sums match fixture', () => {
  const rows = usageFixture('__aggregate__', 35);
  const r24 = computeRollup(rows, 1);
  const r7  = computeRollup(rows, 7);
  const r30 = computeRollup(rows, 30);
  const rAll = computeRollup(rows, null);

  assert.equal(r24.totals.total_tokens, 1500);
  assert.equal(r24.totals.cost_usd, 0.5);
  assert.equal(r7.totals.total_tokens, 42000);
  assert.equal(r30.totals.total_tokens, 697500);
  assert.equal(rAll.totals.total_tokens, 945000);
  assert.equal(rAll.daily.length, 35);
  assert.ok(rAll.daily[0].day < rAll.daily[34].day, 'daily sorted ascending');
});

test('GET /v1/usage?window=24h returns rollup + by_window shape', async () => {
  const env = { DB: new MockD1() };
  for (const r of usageFixture('__aggregate__', 10)) {
    env.DB.usage.set(`${r.agent_id}|${r.day}`, r);
  }
  const res = await handleRequest(
    new Request('https://example.test/v1/usage?window=24h'),
    env, {}, new Date('2026-05-25T12:00:00Z')
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.window, '24h');
  assert.ok(body.as_of, 'as_of present');
  assert.ok(body.totals.total_tokens > 0);
  assert.ok(Array.isArray(body.daily));
  assert.deepEqual(Object.keys(body.by_window).sort(), ['24h', '30d', '7d', 'all']);
  assert.deepEqual(body.by_agent, {});
});

test('GET /v1/usage rejects unknown window', async () => {
  const env = { DB: new MockD1() };
  const res = await handleRequest(
    new Request('https://example.test/v1/usage?window=bogus'),
    env, {}, new Date()
  );
  assert.equal(res.status, 400);
});

test('injectUsage: mergeSnapshots with usageRows produces meta.usage_24h and usage_aggregate', () => {
  const macSnap = {
    schema_version: 1,
    machine: { tag: 'mac', hostname: 'mbp', os: 'Darwin' },
    gateway: { state: 'running' },
    collected_at: new Date().toISOString(),
    agents: { buddha: { id: 'buddha', label: 'buddha', type: 'agent', sublabel: '[default]' } },
    edges: [],
  };
  const usageRows = usageFixture('__aggregate__', 10);
  const merged = mergeSnapshots([macSnap], new Date(), usageRows);
  assert.ok(merged.meta, 'meta block populated');
  assert.ok(merged.meta.usage_24h, 'usage_24h populated');
  assert.equal(merged.meta.usage_24h.total_tokens, 1500);
  assert.equal(merged.meta.usage_aggregate['24h'].total_tokens, 1500);
  assert.equal(merged.meta.usage_aggregate.all.total_tokens, 1500 * (10 * 11 / 2));
  assert.ok(Array.isArray(merged.meta.usage_aggregate.daily));
});

test('mergeSnapshots without usageRows leaves meta absent (backwards compatible)', () => {
  const merged = mergeSnapshots([], new Date());
  assert.equal(merged.meta, undefined);
});

test('refreshLangfuseAggregate: 200 upserts rows aggregated across models per day', async () => {
  const env = {
    DB: new MockD1(),
    LANGFUSE_HOST: 'https://langfuse.test',
    LANGFUSE_PUBLIC_KEY: 'pk',
    LANGFUSE_SECRET_KEY: 'sk',
  };
  const payload = {
    data: [
      { date: '2026-05-24', model: 'gpt-4o',  inputUsage: 100, outputUsage: 50,  totalUsage: 150, totalCost: 0.1, countTraces: 1 },
      { date: '2026-05-24', model: 'claude',  inputUsage: 200, outputUsage: 100, totalUsage: 300, totalCost: 0.2, countTraces: 2 },
      { date: '2026-05-25', model: 'gpt-4o',  inputUsage: 10,  outputUsage: 5,   totalUsage: 15,  totalCost: 0.01, countTraces: 1 },
    ],
  };
  const mockFetch = async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  const result = await refreshLangfuseAggregate(env, mockFetch, new Date('2026-05-25T12:00:00Z'));
  assert.equal(result.ok, true);
  assert.equal(result.days, 2);

  const day24 = env.DB.usage.get('__aggregate__|2026-05-24');
  assert.equal(day24.total_tokens, 450);
  assert.ok(Math.abs(day24.cost_usd - 0.3) < 1e-9, 'cost sums to ~0.30');
  const mb = JSON.parse(day24.model_breakdown);
  assert.equal(mb['gpt-4o'].tokens, 150);
  assert.equal(mb['claude'].tokens, 300);
});

test('refreshLangfuseAggregate: 429 leaves cached rows untouched', async () => {
  const env = {
    DB: new MockD1(),
    LANGFUSE_HOST: 'https://langfuse.test',
    LANGFUSE_PUBLIC_KEY: 'pk',
    LANGFUSE_SECRET_KEY: 'sk',
  };
  env.DB.usage.set('__aggregate__|2026-05-24', {
    agent_id: '__aggregate__', day: '2026-05-24',
    input_tokens: 999, output_tokens: 0, total_tokens: 999,
    cost_usd: 1.0, trace_count: 1, model_breakdown: '{}', fetched_at: 'old',
  });
  const mockFetch = async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '60' } });
  const result = await refreshLangfuseAggregate(env, mockFetch, new Date('2026-05-25T12:00:00Z'));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rate_limited');
  assert.equal(env.DB.usage.get('__aggregate__|2026-05-24').input_tokens, 999, 'cached row preserved');
});

test('refreshLangfuseAggregate: missing env returns gracefully', async () => {
  const result = await refreshLangfuseAggregate({ DB: new MockD1() });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_env');
});

