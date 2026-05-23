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
