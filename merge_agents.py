#!/usr/bin/env python3
"""
Merge machine-specific agent JSON files into a single agents.json
for the constellation visualization.

Usage:
  python3 merge_agents.py mac_agents.json win_agents.json linux_agents.json -o agents.json
"""

import argparse
import copy
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Services that are NOT scoped per-machine (shared external services)
SHARED_SERVICES = {"telegram", "discord", "slack", "whatsapp", "signal", "mattermost", "matrix", "webhook"}
SCHEMA_VERSION = 1
STALE_AFTER_SECONDS = 10 * 60
OFFLINE_AFTER_SECONDS = 60 * 60


def _parse_timestamp(value):
    """Parse ISO-ish timestamps from collectors. Return aware UTC datetime or None."""
    if not value:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _iso(dt):
    return dt.astimezone(timezone.utc).isoformat()


def _machine_status(collected_at, now):
    seen = _parse_timestamp(collected_at)
    if seen is None:
        return "unknown", None
    age = max(0, int((now - seen).total_seconds()))
    if age >= OFFLINE_AFTER_SECONDS:
        return "offline", age
    if age >= STALE_AFTER_SECONDS:
        return "stale", age
    return "online", age


def _annotate_node(agent, status, age_seconds, last_seen_at):
    node = copy.deepcopy(agent)
    details = node.setdefault("details", {})
    details["machine_status"] = status
    details["machine_age_seconds"] = age_seconds
    details["machine_last_seen_at"] = last_seen_at
    return node


def merge(data_list, now=None):
    """Merge multiple machine data files into one constellation dataset.

    Phase 1 metadata contract:
    - top-level schema_version and generated_at
    - each machine includes last_seen_at, age_seconds, and status
    - stale/offline machines remain visible
    - all machine-owned nodes include status details for frontend styling
    """
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    now = now.astimezone(timezone.utc)

    merged = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": _iso(now),
        "machines": [],
        "agents": {},
        "edges": [],
        "gateway": {},
    }

    machine_defaults = {}

    for original in data_list:
        data = copy.deepcopy(original)
        machine = data.get("machine", {})
        machine_tag = machine.get("tag", machine.get("hostname", "unknown"))
        collected_at = data.get("collected_at")
        status, age_seconds = _machine_status(collected_at, now)

        merged["machines"].append({
            "tag": machine_tag,
            "hostname": machine.get("hostname", ""),
            "os": machine.get("os", ""),
            "last_seen_at": collected_at,
            "age_seconds": age_seconds,
            "status": status,
        })

        gw = copy.deepcopy(data.get("gateway", {}))
        gw["last_seen_at"] = collected_at
        gw["age_seconds"] = age_seconds
        gw["status"] = status
        merged["gateway"][machine_tag] = gw

        # Merge agents — scope ALL non-service nodes per machine
        for agent_id, agent in data.get("agents", {}).items():
            if agent_id in SHARED_SERVICES:
                # Services are shared — use bare ID, latest writer wins for now.
                service = _annotate_node(agent, status, age_seconds, collected_at)
                merged["agents"][agent_id] = service
                continue

            # Scope infra and agent nodes per machine
            scoped_id = f"{machine_tag}_{agent_id}"
            scoped_agent = _annotate_node(agent, status, age_seconds, collected_at)
            scoped_agent["machine"] = machine_tag
            scoped_agent["id"] = scoped_id
            merged["agents"][scoped_id] = scoped_agent

            if agent.get("sublabel") == "[default]":
                machine_defaults[machine_tag] = scoped_id

        # Merge edges — scope non-service node references
        for edge in data.get("edges", []):
            if len(edge) < 4:
                continue
            from_id, to_id = edge[0], edge[1]

            if from_id not in SHARED_SERVICES:
                from_id = f"{machine_tag}_{from_id}"
            if to_id not in SHARED_SERVICES:
                to_id = f"{machine_tag}_{to_id}"

            merged["edges"].append([from_id, to_id, edge[2], edge[3]])

    # Cross-mesh edges between default agents
    defaults = list(machine_defaults.values())
    if len(defaults) > 1:
        for i in range(len(defaults)):
            for j in range(i + 1, len(defaults)):
                merged["edges"].append([defaults[i], defaults[j], "cross-mesh", "#ff8c00"])

    return merged


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Merge machine agent JSON files")
    parser.add_argument("inputs", nargs="+", help="Input JSON files")
    parser.add_argument("-o", "--output", help="Output file (default: stdout)")
    args = parser.parse_args()

    data_list = []
    for path in args.inputs:
        try:
            with open(path) as f:
                data_list.append(json.load(f))
        except (FileNotFoundError, json.JSONDecodeError) as e:
            print(f"Warning: skipping {path}: {e}", file=sys.stderr)

    if not data_list:
        print("No input data", file=sys.stderr)
        sys.exit(1)

    merged = merge(data_list)
    output = json.dumps(merged, indent=2)

    if args.output:
        Path(args.output).write_text(output)
        print(f"Written to {args.output}", file=sys.stderr)
    else:
        print(output)
