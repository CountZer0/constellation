#!/usr/bin/env python3
"""
Hermes Agent Constellation — Data Collector
Reads local Hermes configs and outputs agents.json for the constellation visualization.

Usage:
  python3 collect_agents.py                    # writes to stdout
  python3 collect_agents.py -o agents.json     # writes to file
  python3 collect_agents.py --machine mac      # tag output with machine name
  python3 collect_agents.py --default-name "Count Zer0"  # override default agent name
"""

import argparse
import json
import os
import platform
import re
import socket
import sys
from pathlib import Path

# ═══════════════════════════════════════════════════════
# CONFIG
# ═══════════════════════════════════════════════════════
HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
# HERMES_HOME may point to a profile dir (e.g., ~/.hermes/profiles/wintermute)
# Detect and normalize to the actual ~/.hermes root
if HERMES_HOME.name == "profiles" or (HERMES_HOME.parent.name == "profiles"):
    HERMES_HOME = Path.home() / ".hermes"
PROFILES_DIR = HERMES_HOME / "profiles"

COLOR_MAP = {
    "count":      "#00e5ff",
    "hiro":       "#ff2d7b",
    "buddha":     "#ffd700",
    "wintermute": "#b24dff",
    "clu":        "#ff8c00",
    "caac":       "#ff6b6b",
    "ares":       "#e055ff",
}
REPO_COLOR = "#9b59b6"

# Hermes' default profiles sync skills to this repo. Surfaced as a shared
# stash-sync hub when profiles don't declare an explicit target.
DEFAULT_STASH_SYNC_URL = "https://github.com/CountZer0/hermes-skills"

# Constellation itself is the repo the machine-level cron belongs to.
CONSTELLATION_REPO_URL = "https://github.com/CountZer0/constellation"

# Repo kinds that should also surface as shared nodes on the graph (with
# `repo:<owner>/<name>` ids, merged across machines by the Worker).
SHARED_REPO_KINDS = {"stash-sync", "stash-sync-default", "constellation"}
DEFAULT_AGENT_COLORS = ["#00e5ff", "#ff2d7b", "#ffd700", "#b24dff", "#ff8c00", "#e055ff", "#4d8bff"]
_color_idx = 0

def get_color(name):
    global _color_idx
    if name.lower() in COLOR_MAP:
        return COLOR_MAP[name.lower()]
    color = DEFAULT_AGENT_COLORS[_color_idx % len(DEFAULT_AGENT_COLORS)]
    _color_idx += 1
    return color


# ═══════════════════════════════════════════════════════
# PARSERS
# ═══════════════════════════════════════════════════════

def parse_soul(path):
    """Extract identity info from SOUL.md"""
    info = {}
    if not path.exists():
        return info
    text = path.read_text(errors="replace")

    for pattern, key in [
        (r'\*\*Name:\*\*\s*(.+)', "name"),
        (r'\*\*Title:\*\*\s*(.+)', "title"),
        (r'\*\*Role:\*\*\s*(.+)', "role"),
        (r'\*\*(?:Voice|Speech Patterns|Style):\*\*\s*(.+)', "voice"),
        (r'\*\*Essence:\*\*\s*(.+)', "essence"),
        (r'\*\*Vibe:\*\*\s*(.+)', "voice"),
    ]:
        m = re.search(pattern, text, re.IGNORECASE)
        if m and key not in info:
            info[key] = m.group(1).strip()

    return info


def parse_config(path):
    """Extract model/provider from config.yaml"""
    info = {}
    if not path.exists():
        return info
    text = path.read_text(errors="replace")

    in_model = False
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped == "model:":
            in_model = True
            continue
        if in_model:
            if stripped.startswith("default:"):
                info["model"] = stripped.split(":", 1)[1].strip()
            elif stripped.startswith("provider:"):
                info["provider"] = stripped.split(":", 1)[1].strip()
            elif stripped and not stripped.startswith("-") and ":" in stripped and not stripped.startswith(" "):
                in_model = False

    return info


def parse_honcho(path):
    """Extract Honcho peer connections.

    Honcho config is authoritative for the constellation memory map. Keep the
    visualizer aligned with the same host-block contract Hermes resolves:
    `peerName` is the human peer, `aiPeer` is the agent peer, and `workspace`
    is the memory namespace.
    """
    peers = []
    if not path.exists():
        return peers
    try:
        data = json.loads(path.read_text(errors="replace"))
        root_user = data.get("peerName", "")
        hosts = data.get("hosts", {})
        for host_key, host_val in hosts.items():
            peer = host_val.get("aiPeer", "")
            if peer:
                peers.append({
                    "peer": peer,
                    "workspace": host_val.get("workspace", ""),
                    "host_key": host_key,
                    "user_peer": host_val.get("peerName") or root_user,
                    "enabled": host_val.get("enabled", data.get("enabled", True)),
                    "recallMode": host_val.get("recallMode", data.get("recallMode", "hybrid")),
                    "writeFrequency": host_val.get("writeFrequency", data.get("writeFrequency", "async")),
                    "sessionStrategy": host_val.get("sessionStrategy", data.get("sessionStrategy", "per-directory")),
                })
    except (json.JSONDecodeError, KeyError):
        pass
    return peers


def parse_gateway_state(path):
    """Extract platform connection states"""
    result = {"pid": None, "gateway_state": "unknown", "platforms": {}}
    if not path.exists():
        return result
    try:
        data = json.loads(path.read_text(errors="replace"))
        result["pid"] = data.get("pid")
        result["gateway_state"] = data.get("gateway_state", "unknown")
        plats = data.get("platforms", {})
        for name, state in plats.items():
            result["platforms"][name] = {
                "state": state.get("state", "unknown") if isinstance(state, dict) else "unknown",
                "error": state.get("error_message") if isinstance(state, dict) else None,
            }
    except (json.JSONDecodeError, KeyError):
        pass
    return result


def is_wsl():
    """Detect if running inside Windows Subsystem for Linux.
    WSL masquerades as Linux — but the actual host OS is Windows."""
    # Primary check: WSLInterop file is a dead giveaway
    if Path("/proc/sys/fs/binfmt_misc/WSLInterop").exists():
        return True
    # WSL2: check /proc/version for Microsoft kernel
    try:
        version = Path("/proc/version").read_text()
        if "microsoft" in version.lower() or "wsl" in version.lower():
            return True
    except Exception:
        pass
    # WSL distro name env var
    if os.environ.get("WSL_DISTRO_NAME"):
        return True
    return False


def detect_machine():
    hostname = socket.gethostname()
    # Try to get a clean hostname
    try:
        clean = socket.gethostname().split(".")[0]
    except Exception:
        clean = hostname
    # WSL runs on Windows — report the real host OS
    os_name = "Windows" if is_wsl() else platform.system()
    return {"hostname": clean, "os": os_name}


def get_toolsets(profile_path, default_toolsets=None):
    config_path = profile_path / "config.yaml"
    if not config_path.exists():
        return default_toolsets or []
    text = config_path.read_text(errors="replace")
    toolsets = []
    in_toolsets = False
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("toolsets:"):
            in_toolsets = True
            continue
        if in_toolsets:
            if stripped.startswith("- "):
                toolsets.append(stripped[2:].strip())
            elif stripped and not stripped.startswith(" "):
                in_toolsets = False
    return toolsets or default_toolsets or []



# ═══════════════════════════════════════════════════════
# REPO DISCOVERY
# ═══════════════════════════════════════════════════════

def canonicalize_repo_url(url):
    """Normalize a git remote URL so the same repo dedupes regardless of style.

    Examples:
        git@github.com:CountZer0/hermes-skills.git
          -> https://github.com/CountZer0/hermes-skills
        https://github.com/CountZer0/hermes-skills.git
          -> https://github.com/CountZer0/hermes-skills
    """
    if not url:
        return ""
    u = url.strip()
    m = re.match(r'^git@([^:]+):(.+?)(?:\.git)?/?$', u)
    if m:
        return f"https://{m.group(1)}/{m.group(2)}"
    m = re.match(r'^(?:https?|git)://(.+?)(?:\.git)?/?$', u)
    if m:
        return f"https://{m.group(1)}"
    return u


def repo_name_from_url(url):
    """Extract 'owner/name' from a canonical URL."""
    m = re.match(r'^https?://([^/]+)/(.+?)/?$', url)
    if not m:
        return url
    parts = m.group(2).split('/')
    if len(parts) >= 2:
        return f"{parts[0]}/{parts[1]}"
    return m.group(2)


def parse_git_remotes(git_dir):
    """Read .git/config, return [{name, url}, ...]. Stdlib-only via configparser."""
    import configparser
    cfg = git_dir / "config"
    if not cfg.exists():
        return []
    cp = configparser.ConfigParser(strict=False)
    try:
        cp.read(str(cfg))
    except Exception:
        return []
    remotes = []
    for section in cp.sections():
        m = re.match(r'^remote\s+"?([^"]+)"?$', section)
        if not m:
            continue
        url = cp.get(section, 'url', fallback=None)
        if url:
            remotes.append({"name": m.group(1), "url": url.strip()})
    return remotes


def git_branch(git_dir):
    head_file = git_dir / "HEAD"
    if not head_file.exists():
        return None
    try:
        head = head_file.read_text(errors="replace").strip()
    except Exception:
        return None
    m = re.match(r'^ref: refs/heads/(.+)$', head)
    return m.group(1) if m else None


def git_last_synced(git_dir):
    """Best-effort last-sync timestamp from FETCH_HEAD, the branch ref, or HEAD."""
    import datetime as _dt
    candidates = [git_dir / "FETCH_HEAD"]
    branch = git_branch(git_dir)
    if branch:
        candidates.append(git_dir / "refs" / "heads" / branch)
    candidates.append(git_dir / "HEAD")
    for c in candidates:
        try:
            if c.exists():
                ts = c.stat().st_mtime
                return _dt.datetime.fromtimestamp(ts, tz=_dt.timezone.utc).isoformat()
        except Exception:
            continue
    return None


def discover_filesystem_repos(scan_root, max_depth=3):
    """Find .git directories under scan_root (BFS), return list of repo dicts.

    Each repo: {url, url_raw, name, branch, last_synced_at, source: 'filesystem',
                path, remote}. Repos are deduped by canonical url.
    """
    if not scan_root.exists() or not scan_root.is_dir():
        return []
    repos = []
    seen = set()
    queue = [(scan_root, 0)]
    while queue:
        path, depth = queue.pop(0)
        if depth > max_depth:
            continue
        git_dir = path / ".git"
        if git_dir.is_dir():
            for remote in parse_git_remotes(git_dir):
                canonical = canonicalize_repo_url(remote["url"])
                if not canonical or canonical in seen:
                    continue
                seen.add(canonical)
                try:
                    rel = str(path.relative_to(scan_root))
                except ValueError:
                    rel = str(path)
                if rel == ".":
                    rel = scan_root.name
                repos.append({
                    "url": canonical,
                    "url_raw": remote["url"],
                    "name": repo_name_from_url(canonical),
                    "branch": git_branch(git_dir),
                    "last_synced_at": git_last_synced(git_dir),
                    "source": "filesystem",
                    "path": rel,
                    "remote": remote["name"],
                })
            # Don't descend into a repo
            continue
        try:
            for child in sorted(path.iterdir()):
                if child.is_dir() and not child.name.startswith("."):
                    queue.append((child, depth + 1))
        except (PermissionError, OSError):
            continue
    return repos


def classify_repo_kind(repo, profile_name=None, is_default_agent=False):
    """Guess what role this repo plays for an agent."""
    canonical = repo.get("url", "")
    path = (repo.get("path") or "").lower()
    if canonical == DEFAULT_STASH_SYNC_URL or canonical.endswith("/hermes-skills"):
        return "stash-sync"
    if canonical == CONSTELLATION_REPO_URL:
        return "constellation"
    if "skills" in path:
        return "skill"
    if "toolsets" in path or "toolset" in path:
        return "toolset"
    if "profiles" in path:
        return "profile"
    return "other"


def scan_crontab_for_repos():
    """Best-effort crontab parse. Returns [{url, url_raw, name, source: 'cron',
    cron, profile}]. Profile is None for machine-level entries."""
    import subprocess
    repos = []
    try:
        result = subprocess.run(
            ["crontab", "-l"],
            capture_output=True, text=True, timeout=3,
        )
    except (FileNotFoundError, subprocess.SubprocessError, OSError):
        return repos
    if result.returncode != 0:
        return repos
    cron_text = result.stdout or ""

    url_patterns = [
        r'(https?://github\.com/[^\s"\'\\;|&]+?)(?=[\s"\';|&]|$)',
        r'(git@github\.com:[^\s"\'\\;|&]+?)(?=[\s"\';|&]|$)',
    ]
    for line in cron_text.split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        urls_in_line = []
        for pat in url_patterns:
            urls_in_line.extend(re.findall(pat, stripped))
        if "constellation-post.sh" in stripped or "constellation-update.sh" in stripped:
            urls_in_line.append(CONSTELLATION_REPO_URL)
        if not urls_in_line:
            continue

        schedule = None
        if stripped.startswith("@"):
            schedule = stripped.split()[0]
        else:
            tokens = stripped.split(None, 5)
            if len(tokens) >= 5:
                schedule = " ".join(tokens[:5])

        profile_match = re.search(r'\.hermes/profiles/([a-zA-Z0-9_-]+)', stripped)
        profile = profile_match.group(1) if profile_match else None

        for url in urls_in_line:
            canonical = canonicalize_repo_url(url)
            if not canonical:
                continue
            repos.append({
                "url": canonical,
                "url_raw": url,
                "name": repo_name_from_url(canonical),
                "source": "cron",
                "cron": schedule,
                "profile": profile,
            })
    return repos


def merge_repo_lists(filesystem_repos, cron_repos, profile_name=None, is_default_agent=False):
    """Merge filesystem and cron-derived repo lists, dedupe by canonical url.
    Filesystem records win on conflicting fields; cron-only metadata (the
    `cron` schedule, the matched cron line) is preserved as an annotation."""
    by_url = {}
    for r in filesystem_repos:
        key = r["url"]
        if key in by_url:
            continue
        entry = dict(r)
        entry["kind"] = classify_repo_kind(entry, profile_name, is_default_agent)
        entry["sources"] = ["filesystem"]
        by_url[key] = entry
    for r in cron_repos:
        key = r["url"]
        if key in by_url:
            existing = by_url[key]
            srcs = set(existing.get("sources", [existing.get("source", "")]))
            srcs.add("cron")
            existing["sources"] = sorted(s for s in srcs if s)
            if r.get("cron") and not existing.get("cron"):
                existing["cron"] = r["cron"]
        else:
            entry = dict(r)
            entry["kind"] = classify_repo_kind(entry, profile_name, is_default_agent)
            entry["sources"] = ["cron"]
            by_url[key] = entry
    return list(by_url.values())


def repo_shared_id(url):
    """Build the SHARED_SERVICES-style id for a repo node, e.g. repo:owner/name."""
    name = repo_name_from_url(url)
    return f"repo:{name}"


def repo_node(url, kind):
    """Return the shared agents-dict entry for a repo node."""
    name = repo_name_from_url(url)
    return {
        "id": repo_shared_id(url),
        "label": name,
        "sublabel": kind,
        "type": "service",
        "color": REPO_COLOR,
        "shape": "square",
        "details": {
            "url": url,
            "kind": kind,
        },
    }


# ═══════════════════════════════════════════════════════
# MAIN COLLECTION
# ═══════════════════════════════════════════════════════

def collect(machine_tag=None, default_name=None):
    machine = detect_machine()
    if machine_tag:
        machine["tag"] = machine_tag
        # Override OS based on explicit machine tag.
        # On WSL, detect_machine() returns "Windows" — but if the caller
        # passes --machine linux, this is the Linux-side collection and
        # should report "Linux" as its node OS identity.
        os_map = {"win": "Windows", "mac": "Darwin", "linux": "Linux"}
        if machine_tag in os_map:
            machine["os"] = os_map[machine_tag]

    # Parse shared configs
    honcho = parse_honcho(HERMES_HOME / "honcho.json")
    gateway = parse_gateway_state(HERMES_HOME / "gateway_state.json")
    gw_pid = gateway.get("pid")
    gw_state = gateway.get("gateway_state", "unknown")
    platforms = gateway.get("platforms", {})

    # Determine default agent name
    default_id = default_name or machine.get("tag", "default")

    # ── Collect crontab once (shared by default + sub-profiles) ──
    cron_repos = scan_crontab_for_repos()

    # ── Collect sub-profiles ──
    agents = {}
    if PROFILES_DIR.exists():
        for p in sorted(PROFILES_DIR.iterdir()):
            if p.is_dir() and not p.name.startswith("."):
                soul = parse_soul(p / "SOUL.md")
                cfg = parse_config(p / "config.yaml")
                toolsets = get_toolsets(p, ["browser", "skills", "terminal", "file", "web"])

                display_name = soul.get("name", p.name.title())
                role = soul.get("title") or soul.get("role") or soul.get("essence", "")
                if role and len(role) > 100:
                    role = role[:97] + "..."
                voice = soul.get("voice", "")
                if voice and len(voice) > 60:
                    voice = voice[:57] + "..."

                profile_fs_repos = discover_filesystem_repos(p)
                profile_cron_repos = [r for r in cron_repos if r.get("profile") == p.name]
                profile_repos = merge_repo_lists(
                    profile_fs_repos, profile_cron_repos,
                    profile_name=p.name, is_default_agent=False,
                )

                agents[p.name] = {
                    "id": p.name,
                    "label": display_name,
                    "sublabel": "profile",
                    "type": "agent",
                    "color": get_color(p.name),
                    "machine": machine.get("tag", machine["hostname"]),
                    "details": {
                        "model": cfg.get("model", "unknown"),
                        "provider": cfg.get("provider", "unknown"),
                        "voice": voice,
                        "role": role,
                        "home": f"~/.hermes/profiles/{p.name}",
                        "toolsets": toolsets,
                        "platforms": [],
                        "repos": profile_repos,
                    }
                }

    # ── Collect default agent (top-level SOUL.md + config.yaml) ──
    default_soul = parse_soul(HERMES_HOME / "SOUL.md")
    default_cfg = parse_config(HERMES_HOME / "config.yaml")
    default_toolsets = get_toolsets(HERMES_HOME, ["hermes-cli", "browser", "skills", "fs", "read", "write", "rl"])

    display_name = default_name or default_soul.get("name", "Count Zer0")
    voice = default_soul.get("voice", "")
    if voice and len(voice) > 60:
        voice = voice[:57] + "..."
    role = default_soul.get("title") or default_soul.get("role", "Operator / Orchestrator")

    # ── Discover repos for the default agent ──
    # Scan ~/.hermes top-level (not profiles/ subdirs — those belong to sub-profiles).
    default_fs_repos = []
    seen_paths = set()
    if HERMES_HOME.exists():
        for child in sorted(HERMES_HOME.iterdir()):
            if not child.is_dir():
                continue
            if child.name in ("profiles",) or child.name.startswith("."):
                continue
            for r in discover_filesystem_repos(child):
                if r["url"] in seen_paths:
                    continue
                seen_paths.add(r["url"])
                default_fs_repos.append(r)
        # Also check HERMES_HOME itself in case ~/.hermes/.git exists
        root_git = HERMES_HOME / ".git"
        if root_git.is_dir():
            for remote in parse_git_remotes(root_git):
                canonical = canonicalize_repo_url(remote["url"])
                if canonical and canonical not in seen_paths:
                    seen_paths.add(canonical)
                    default_fs_repos.append({
                        "url": canonical,
                        "url_raw": remote["url"],
                        "name": repo_name_from_url(canonical),
                        "branch": git_branch(root_git),
                        "last_synced_at": git_last_synced(root_git),
                        "source": "filesystem",
                        "path": str(HERMES_HOME),
                        "remote": remote["name"],
                    })

    default_cron_repos = [r for r in cron_repos if r.get("profile") is None]
    default_repos = merge_repo_lists(
        default_fs_repos, default_cron_repos,
        profile_name=default_id, is_default_agent=True,
    )

    # If no hermes-skills repo was found anywhere for the default agent,
    # surface the inferred default stash-sync target so the central hub
    # still appears in the visualization.
    if not any(r["url"] == DEFAULT_STASH_SYNC_URL or r.get("kind") == "stash-sync"
               for r in default_repos):
        default_repos.append({
            "url": DEFAULT_STASH_SYNC_URL,
            "url_raw": DEFAULT_STASH_SYNC_URL,
            "name": repo_name_from_url(DEFAULT_STASH_SYNC_URL),
            "kind": "stash-sync-default",
            "source": "inferred",
            "sources": ["inferred"],
        })

    agents[default_id] = {
        "id": default_id,
        "label": display_name,
        "sublabel": "[default]",
        "type": "agent",
        "color": get_color(default_id),
        "machine": machine.get("tag", machine["hostname"]),
        "details": {
            "model": default_cfg.get("model", "unknown"),
            "provider": default_cfg.get("provider", "unknown"),
            "voice": voice,
            "role": role,
            "home": "~/.hermes",
            "toolsets": default_toolsets,
            "platforms": [p for p, s in platforms.items()
                          if isinstance(s, dict) and s.get("state") == "connected"],
            "repos": default_repos,
        }
    }

    # ── Infrastructure nodes ──
    infra = {
        "host": {
            "id": "host",
            "label": "HOST",
            "sublabel": machine.get("tag", machine["hostname"]),
            "type": "infra",
            "color": "#00ff41",
            "machine": machine.get("tag", machine["hostname"]),
            "details": {
                "machine": machine["hostname"],
                "os": machine.get("os", "unknown"),
                "home": "~/.hermes",
            }
        },
        "gateway": {
            "id": "gateway",
            "label": "Hermes Gateway",
            "sublabel": f"PID {gw_pid}" if gw_pid else machine.get("os", ""),
            "type": "infra",
            "color": "#00ff41",
            "machine": machine.get("tag", machine["hostname"]),
            "details": {
                "pid": gw_pid,
                "gateway_state": gw_state,
                "home": "~/.hermes",
            }
        }
    }

    # ── Service nodes ──
    services = {}
    for plat_name, plat_info in platforms.items():
        state = plat_info.get("state", "unknown") if isinstance(plat_info, dict) else "unknown"
        services[plat_name] = {
            "id": plat_name,
            "label": plat_name.title(),
            "sublabel": state,
            "type": "service",
            "color": "#4d8bff" if state == "connected" else "#666",
            "machine": machine.get("tag", machine["hostname"]),
            "details": {"state": state}
        }

    # ── Build edges ──
    edges = []
    agent_names = list(agents.keys())

    # Gateway host link
    edges.append(["host", "gateway", "gateway-host", "#00ff41"])

    # Default agent to gateway
    if default_id in agents:
        edges.append(["gateway", default_id, "gateway-host", "#00ff41"])

    # Honcho peer links
    honcho_peers = {p["peer"] for p in honcho}
    if len(agent_names) > 1 and default_id in agents:
        for name in agent_names:
            if name != default_id:
                edges.append([default_id, name, "honcho", "#ffd700"])

    # Sibling links to host
    for name in agent_names:
        edges.append([name, "host", "sibling", "#444"])

    # Platform links from default agent
    if default_id in agents:
        for plat_name in services:
            edges.append([default_id, plat_name, "platform", "#4d8bff"])

    # Cross-mesh hints (honcho peers not on this machine)
    for peer_info in honcho:
        peer_name = peer_info.get("peer", "")
        if peer_name and peer_name not in agents and default_id in agents:
            edges.append([default_id, peer_name, "cross-mesh", "#ff8c00"])

    # ── Shared repo nodes + edges (stash-sync hubs, constellation) ──
    # Repos with SHARED_REPO_KINDS surface as repo:<owner>/<name> nodes that
    # the Worker merges across machines via its SHARED_SERVICES set.
    for agent_id, agent in list(agents.items()):
        if agent.get("type") != "agent":
            continue
        for repo in (agent.get("details", {}).get("repos") or []):
            kind = repo.get("kind")
            if kind not in SHARED_REPO_KINDS:
                continue
            shared_id = repo_shared_id(repo["url"])
            if shared_id not in agents:
                agents[shared_id] = repo_node(repo["url"], kind)
            edges.append([agent_id, shared_id, "repo", REPO_COLOR])

    return {
        "schema_version": 1,
        "machine": machine,
        "gateway": {"pid": gw_pid, "state": gw_state},
        "agents": {**infra, **agents, **services},
        "edges": edges,
        "honcho_peers": honcho,
        "collected_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Collect Hermes agent data for constellation visualization")
    parser.add_argument("-o", "--output", help="Output file path (default: stdout)")
    parser.add_argument("--machine", help="Machine tag (e.g., 'mac', 'win')")
    parser.add_argument("--default-name", help="Override default agent display name")
    args = parser.parse_args()

    data = collect(machine_tag=args.machine, default_name=args.default_name)
    output = json.dumps(data, indent=2)

    if args.output:
        Path(args.output).write_text(output)
        print(f"Written to {args.output}", file=sys.stderr)
    else:
        print(output)
