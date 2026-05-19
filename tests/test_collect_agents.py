import unittest

from collect_agents import collect


class CollectMetadataTests(unittest.TestCase):
    def test_snapshot_includes_schema_version(self):
        result = collect(machine_tag="linux", default_name="CLU")

        self.assertEqual(result["schema_version"], 1)


if __name__ == "__main__":
    unittest.main()
