import unittest
from datetime import datetime, timedelta, timezone

from merge_agents import merge


def snapshot(tag, hostname, collected_at, default_id="CLU"):
    return {
        "schema_version": 1,
        "machine": {"hostname": hostname, "os": "Linux", "tag": tag},
        "gateway": {"pid": 123, "state": "running"},
        "agents": {
            "host": {
                "id": "host",
                "label": "HOST",
                "sublabel": tag,
                "type": "infra",
                "color": "#00ff41",
                "machine": tag,
                "details": {"machine": hostname, "os": "Linux"},
            },
            default_id: {
                "id": default_id,
                "label": default_id,
                "sublabel": "[default]",
                "type": "agent",
                "color": "#ff8c00",
                "machine": tag,
                "details": {"model": "test", "provider": "test"},
            },
        },
        "edges": [[default_id, "host", "sub-profile", "#444"]],
        "collected_at": collected_at,
    }


class MergeMetadataTests(unittest.TestCase):
    def test_merged_graph_has_schema_version_and_generated_at(self):
        now = datetime(2026, 5, 19, 12, 0, tzinfo=timezone.utc)

        result = merge([snapshot("linux", "ubuntu-4gb-hil-1", now.isoformat())], now=now)

        self.assertEqual(result["schema_version"], 1)
        self.assertEqual(result["generated_at"], now.isoformat())

    def test_machine_entries_include_last_seen_and_online_status(self):
        now = datetime(2026, 5, 19, 12, 0, tzinfo=timezone.utc)
        collected_at = (now - timedelta(minutes=5)).isoformat()

        result = merge([snapshot("linux", "ubuntu-4gb-hil-1", collected_at)], now=now)

        self.assertEqual(result["machines"][0]["last_seen_at"], collected_at)
        self.assertEqual(result["machines"][0]["status"], "online")
        self.assertEqual(result["machines"][0]["age_seconds"], 300)

    def test_stale_and_offline_machines_remain_visible_with_status(self):
        now = datetime(2026, 5, 19, 12, 0, tzinfo=timezone.utc)
        stale = snapshot("mac", "Countzer0s-MacBook-Pro", (now - timedelta(minutes=30)).isoformat(), "Count Zer0")
        offline = snapshot("win", "Cyberspace-Seven", (now - timedelta(hours=2)).isoformat(), "CLU")

        result = merge([stale, offline], now=now)

        statuses = {m["tag"]: m["status"] for m in result["machines"]}
        self.assertEqual(statuses["mac"], "stale")
        self.assertEqual(statuses["win"], "offline")
        self.assertIn("mac_Count Zer0", result["agents"])
        self.assertIn("win_CLU", result["agents"])

    def test_nodes_are_annotated_with_machine_status(self):
        now = datetime(2026, 5, 19, 12, 0, tzinfo=timezone.utc)
        old = snapshot("win", "Cyberspace-Seven", (now - timedelta(hours=2)).isoformat())

        result = merge([old], now=now)

        self.assertEqual(result["agents"]["win_host"]["details"]["machine_status"], "offline")
        self.assertEqual(result["agents"]["win_CLU"]["details"]["machine_status"], "offline")


if __name__ == "__main__":
    unittest.main()
