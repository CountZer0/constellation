import unittest

from validate_snapshot import validate_snapshot


VALID_SNAPSHOT = {
    "schema_version": 1,
    "machine": {"tag": "linux", "hostname": "ubuntu-4gb-hil-1", "os": "Linux"},
    "gateway": {"pid": 123, "state": "running"},
    "agents": {
        "host": {
            "id": "host",
            "label": "HOST",
            "sublabel": "linux",
            "type": "infra",
            "color": "#00ff41",
            "machine": "linux",
            "details": {},
        },
        "CLU": {
            "id": "CLU",
            "label": "CLU",
            "sublabel": "[default]",
            "type": "agent",
            "color": "#ff8c00",
            "machine": "linux",
            "details": {"model": "openai/gpt-5.5", "provider": "openrouter"},
        },
    },
    "edges": [["host", "CLU", "sibling", "#444"]],
    "honcho_peers": [],
    "collected_at": "2026-05-19T10:46:18+00:00",
}


class SnapshotValidationTests(unittest.TestCase):
    def test_accepts_valid_snapshot(self):
        self.assertEqual(validate_snapshot(VALID_SNAPSHOT), [])

    def test_requires_schema_version_one(self):
        data = {**VALID_SNAPSHOT, "schema_version": 2}

        self.assertIn("schema_version must be 1", validate_snapshot(data))

    def test_requires_machine_identity_fields(self):
        data = {**VALID_SNAPSHOT, "machine": {"tag": "linux"}}

        errors = validate_snapshot(data)

        self.assertIn("machine.hostname is required", errors)
        self.assertIn("machine.os is required", errors)

    def test_requires_collected_at_parseable_iso_timestamp(self):
        data = {**VALID_SNAPSHOT, "collected_at": "not-a-date"}

        self.assertIn("collected_at must be an ISO timestamp", validate_snapshot(data))

    def test_requires_agents_and_edges_shapes(self):
        data = {**VALID_SNAPSHOT, "agents": [], "edges": {}}

        errors = validate_snapshot(data)

        self.assertIn("agents must be an object", errors)
        self.assertIn("edges must be an array", errors)

    def test_rejects_agent_missing_required_fields(self):
        data = {**VALID_SNAPSHOT, "agents": {"CLU": {"id": "CLU"}}}

        errors = validate_snapshot(data)

        self.assertIn("agents.CLU.label is required", errors)
        self.assertIn("agents.CLU.type is required", errors)

    def test_rejects_invalid_edge_shape(self):
        data = {**VALID_SNAPSHOT, "edges": [["host", "CLU"]]}

        self.assertIn("edges[0] must be [from, to, type, color]", validate_snapshot(data))


if __name__ == "__main__":
    unittest.main()
