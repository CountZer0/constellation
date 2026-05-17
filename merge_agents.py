#!/usr/bin/env python3
"""
Merge machine-specific agent JSON files into a single agents.json
for the constellation visualization.

Usage:
  python3 merge_agents.py mac_agents.json win_agents.json -o agents.json
"""

import argparse
import json
import sys
from pathlib import Path

# Services that are NOT scoped per-machine (shared external services)
SHARED_SERVICES = {"telegram", "discord", "slack", "whatsapp", "signal", "mattermost", "matrix", "webhook"}


def merge(data_list):
    """Merge multiple machine data files into one constellation dataset."""
    merged = {
        "machines": [],
        "agents": {},
        "edges": [],
        "gateway": {},
    }

    machine_defaults = {}

    for data in data_list:
        machine = data.get("machine", {})
        machine_tag = machine.get("tag", machine.get("hostname", "unknown"))
        merged["machines"].append({
            "tag": machine_tag,
            "hostname": machine.get("hostname", ""),
            "os": machine.get("os", ""),
        })

        gw = data.get("gateway", {})
        merged["gateway"][machine_tag] = gw

        # Merge agents — scope ALL non-service nodes per machine
        for agent_id, agent in data.get("agents", {}).items():
            if agent_id in SHARED_SERVICES:
                # Services are shared — use bare ID, last writer wins (fine for now)
                merged["agents"][agent_id] = agent
                continue

            # Scope infra and agent nodes per machine
            scoped_id = f"{machine_tag}_{agent_id}"
            agent["machine"] = machine_tag
            agent["id"] = scoped_id  # Update ID to match the scoped key
            merged["agents"][scoped_id] = agent

            if agent.get("sublabel") == "[default]":
                machine_defaults[machine_tag] = scoped_id

        # Merge edges — scope non-service node references
        for edge in data.get("edges", []):
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
