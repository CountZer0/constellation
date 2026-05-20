import unittest
from datetime import datetime, timezone

from collect_agents import collect


class CollectMetadataTests(unittest.TestCase):
    def test_snapshot_includes_schema_version(self):
        result = collect(machine_tag="linux", default_name="CLU")

        self.assertEqual(result["schema_version"], 1)

    def test_collected_at_is_aware_utc_iso_timestamp(self):
        result = collect(machine_tag="linux", default_name="CLU")

        # Must parse as an aware UTC datetime — naive local time is a bug
        parsed = datetime.fromisoformat(result["collected_at"])
        self.assertIsNotNone(parsed.tzinfo, "collected_at must be timezone-aware")
        self.assertEqual(parsed.utcoffset(), timezone.utc.utcoffset(parsed),
                         "collected_at must be UTC")


if __name__ == "__main__":
    unittest.main()
