"""Tests for the Phase A repo discovery additions to collect_agents.py."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import collect_agents
from collect_agents import (
    canonicalize_repo_url,
    classify_repo_kind,
    discover_filesystem_repos,
    merge_repo_lists,
    repo_name_from_url,
    repo_shared_id,
    scan_crontab_for_repos,
)


def _make_fake_git_repo(path, url, branch="main"):
    """Create a minimal .git directory inside `path` describing a single remote."""
    git = path / ".git"
    git.mkdir(parents=True, exist_ok=True)
    (git / "config").write_text(
        f'[remote "origin"]\n\turl = {url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
    )
    (git / "HEAD").write_text(f"ref: refs/heads/{branch}\n")
    refs = git / "refs" / "heads"
    refs.mkdir(parents=True, exist_ok=True)
    (refs / branch).write_text("abc123\n")
    return git


class CanonicalizeTests(unittest.TestCase):
    def test_ssh_form_normalizes_to_https(self):
        self.assertEqual(
            canonicalize_repo_url("git@github.com:CountZer0/hermes-skills.git"),
            "https://github.com/CountZer0/hermes-skills",
        )

    def test_https_with_dot_git_strips_suffix(self):
        self.assertEqual(
            canonicalize_repo_url("https://github.com/CountZer0/hermes-skills.git"),
            "https://github.com/CountZer0/hermes-skills",
        )

    def test_https_without_dot_git_unchanged(self):
        self.assertEqual(
            canonicalize_repo_url("https://github.com/CountZer0/hermes-skills"),
            "https://github.com/CountZer0/hermes-skills",
        )

    def test_empty_input_returns_empty(self):
        self.assertEqual(canonicalize_repo_url(""), "")
        self.assertEqual(canonicalize_repo_url(None), "")

    def test_repo_name_extracts_owner_and_name(self):
        self.assertEqual(
            repo_name_from_url("https://github.com/CountZer0/constellation"),
            "CountZer0/constellation",
        )


class ClassifyTests(unittest.TestCase):
    def test_hermes_skills_is_stash_sync(self):
        self.assertEqual(
            classify_repo_kind({"url": "https://github.com/CountZer0/hermes-skills", "path": "wintermute"}),
            "stash-sync",
        )

    def test_constellation_url_is_constellation(self):
        self.assertEqual(
            classify_repo_kind({"url": "https://github.com/CountZer0/constellation", "path": ""}),
            "constellation",
        )

    def test_path_containing_skills_classified_as_skill(self):
        self.assertEqual(
            classify_repo_kind({"url": "https://github.com/foo/bar", "path": "profiles/buddha/skills/foo"}),
            "skill",
        )

    def test_unknown_falls_back_to_other(self):
        self.assertEqual(
            classify_repo_kind({"url": "https://github.com/foo/bar", "path": "elsewhere"}),
            "other",
        )


class FilesystemDiscoveryTests(unittest.TestCase):
    def test_discovers_git_repo_with_remote(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "buddha").mkdir()
            _make_fake_git_repo(root / "buddha", "https://github.com/CountZer0/hermes-skills.git")
            repos = discover_filesystem_repos(root)
            self.assertEqual(len(repos), 1)
            r = repos[0]
            self.assertEqual(r["url"], "https://github.com/CountZer0/hermes-skills")
            self.assertEqual(r["url_raw"], "https://github.com/CountZer0/hermes-skills.git")
            self.assertEqual(r["name"], "CountZer0/hermes-skills")
            self.assertEqual(r["branch"], "main")
            self.assertEqual(r["source"], "filesystem")
            self.assertEqual(r["remote"], "origin")
            self.assertIsNotNone(r["last_synced_at"])

    def test_does_not_descend_into_repo_subdirs(self):
        """Nested .git/ inside an already-discovered repo must not double-count."""
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            outer = root / "outer"
            outer.mkdir()
            _make_fake_git_repo(outer, "https://github.com/owner/outer.git")
            inner = outer / "vendor" / "thing"
            inner.mkdir(parents=True)
            _make_fake_git_repo(inner, "https://github.com/owner/inner.git")
            repos = discover_filesystem_repos(root)
            self.assertEqual({r["url"] for r in repos}, {"https://github.com/owner/outer"})

    def test_dedupes_repeated_remote_urls(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "a").mkdir()
            (root / "b").mkdir()
            _make_fake_git_repo(root / "a", "https://github.com/owner/repo.git")
            _make_fake_git_repo(root / "b", "git@github.com:owner/repo.git")
            repos = discover_filesystem_repos(root)
            self.assertEqual(len(repos), 1)

    def test_missing_root_returns_empty(self):
        self.assertEqual(discover_filesystem_repos(Path("/nope/nope/nope")), [])


class MergeTests(unittest.TestCase):
    def test_filesystem_and_cron_merge_on_canonical_url(self):
        fs = [{
            "url": "https://github.com/CountZer0/hermes-skills",
            "url_raw": "https://github.com/CountZer0/hermes-skills.git",
            "name": "CountZer0/hermes-skills",
            "branch": "main", "last_synced_at": "2026-01-01T00:00:00+00:00",
            "source": "filesystem", "path": "buddha", "remote": "origin",
        }]
        cron = [{
            "url": "https://github.com/CountZer0/hermes-skills",
            "source": "cron", "cron": "0 * * * *", "profile": "buddha",
        }]
        merged = merge_repo_lists(fs, cron, profile_name="buddha")
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["kind"], "stash-sync")
        self.assertIn("filesystem", merged[0]["sources"])
        self.assertIn("cron", merged[0]["sources"])
        self.assertEqual(merged[0]["cron"], "0 * * * *")


class CrontabScanTests(unittest.TestCase):
    def _patch_subprocess(self, output, returncode=0):
        cm = mock.MagicMock()
        cm.stdout = output
        cm.returncode = returncode
        return mock.patch.object(subprocess, "run", return_value=cm)

    def test_extracts_repo_url_from_cron_line(self):
        cron_output = (
            "# header\n"
            "0 * * * * cd ~/work && git pull https://github.com/owner/repo.git\n"
        )
        with self._patch_subprocess(cron_output):
            repos = scan_crontab_for_repos()
        self.assertEqual(len(repos), 1)
        self.assertEqual(repos[0]["url"], "https://github.com/owner/repo")
        self.assertEqual(repos[0]["cron"], "0 * * * *")
        self.assertIsNone(repos[0]["profile"])

    def test_constellation_post_sh_infers_repo(self):
        cron_output = "0 * * * * /bin/bash ~/.hermes/constellation/constellation-post.sh\n"
        with self._patch_subprocess(cron_output):
            repos = scan_crontab_for_repos()
        self.assertEqual(len(repos), 1)
        self.assertEqual(repos[0]["url"], "https://github.com/CountZer0/constellation")

    def test_profile_inferred_from_path_in_cron_line(self):
        cron_output = "0 * * * * /home/u/.hermes/profiles/buddha/run.sh # git@github.com:o/r.git\n"
        with self._patch_subprocess(cron_output):
            repos = scan_crontab_for_repos()
        self.assertEqual(repos[0]["profile"], "buddha")

    def test_crontab_missing_returns_empty(self):
        with mock.patch.object(subprocess, "run", side_effect=FileNotFoundError):
            self.assertEqual(scan_crontab_for_repos(), [])


class CollectIntegrationTests(unittest.TestCase):
    def _build_hermes(self, td, with_skills_git=True):
        hermes = Path(td) / ".hermes"
        profiles = hermes / "profiles"
        buddha = profiles / "buddha"
        buddha.mkdir(parents=True)
        (buddha / "SOUL.md").write_text("**Name:** Buddha\n**Title:** Meditator\n")
        (buddha / "config.yaml").write_text(
            "model:\n  default: claude-opus-4-7\n  provider: openrouter\n"
        )
        if with_skills_git:
            _make_fake_git_repo(buddha, "https://github.com/CountZer0/hermes-skills.git")
        return hermes

    def _reload_with_hermes(self, hermes_path):
        os.environ["HERMES_HOME"] = str(hermes_path)
        import importlib
        importlib.reload(collect_agents)
        return collect_agents

    def test_collect_emits_per_agent_repos_and_shared_repo_node(self):
        with tempfile.TemporaryDirectory() as td:
            hermes = self._build_hermes(td)
            mod = self._reload_with_hermes(hermes)
            with mock.patch.object(mod, "scan_crontab_for_repos", return_value=[]):
                snap = mod.collect(machine_tag="mac", default_name="Count")

            buddha = snap["agents"]["buddha"]
            self.assertIn("repos", buddha["details"])
            urls = [r["url"] for r in buddha["details"]["repos"]]
            self.assertIn("https://github.com/CountZer0/hermes-skills", urls)
            self.assertEqual(buddha["details"]["repos"][0]["kind"], "stash-sync")

            # Shared node
            shared_id = "repo:CountZer0/hermes-skills"
            self.assertIn(shared_id, snap["agents"])
            shared = snap["agents"][shared_id]
            self.assertEqual(shared["type"], "service")
            self.assertEqual(shared["color"], "#9b59b6")
            self.assertEqual(shared["shape"], "square")

            # Edges
            repo_edges = [e for e in snap["edges"] if e[2] == "repo"]
            self.assertTrue(any(e[0] == "buddha" and e[1] == shared_id for e in repo_edges))

    def test_default_agent_gets_inferred_stash_sync_when_no_explicit_repo(self):
        with tempfile.TemporaryDirectory() as td:
            hermes = self._build_hermes(td, with_skills_git=False)
            mod = self._reload_with_hermes(hermes)
            with mock.patch.object(mod, "scan_crontab_for_repos", return_value=[]):
                snap = mod.collect(machine_tag="mac", default_name="Count")
            default = snap["agents"]["Count"]
            kinds = [r.get("kind") for r in default["details"]["repos"]]
            self.assertIn("stash-sync-default", kinds)

    def test_machine_level_cron_attaches_to_default_agent_only(self):
        with tempfile.TemporaryDirectory() as td:
            hermes = self._build_hermes(td, with_skills_git=False)
            mod = self._reload_with_hermes(hermes)
            cron_entries = [{
                "url": "https://github.com/CountZer0/constellation",
                "url_raw": "https://github.com/CountZer0/constellation",
                "name": "CountZer0/constellation",
                "source": "cron", "cron": "0 * * * *", "profile": None,
            }]
            with mock.patch.object(mod, "scan_crontab_for_repos", return_value=cron_entries):
                snap = mod.collect(machine_tag="mac", default_name="Count")
            default_urls = [r["url"] for r in snap["agents"]["Count"]["details"]["repos"]]
            self.assertIn("https://github.com/CountZer0/constellation", default_urls)
            # buddha must NOT get the machine-level cron entry
            buddha_urls = [r["url"] for r in snap["agents"]["buddha"]["details"]["repos"]]
            self.assertNotIn("https://github.com/CountZer0/constellation", buddha_urls)


class SharedIdTests(unittest.TestCase):
    def test_shared_id_format(self):
        self.assertEqual(
            repo_shared_id("https://github.com/CountZer0/hermes-skills"),
            "repo:CountZer0/hermes-skills",
        )


if __name__ == "__main__":
    unittest.main()
