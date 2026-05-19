import assert from 'node:assert/strict';
import test from 'node:test';

import { handleRequest, signSnapshot } from '../src/index.js';

class MockD1 {
  constructor() {
    this.latest = new Map();
    this.events = [];
  }

  prepare(sql) {
    return new MockStatement(this, sql);
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
    throw new Error(`Unhandled SQL run: ${this.sql}`);
  }

  async all() {
    if (this.sql.includes('FROM latest_snapshots')) {
      return { results: [...this.db.latest.values()].sort((a, b) => a.machine_id.localeCompare(b.machine_id)) };
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
