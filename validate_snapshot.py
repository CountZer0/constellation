#!/usr/bin/env python3
"""Validate Constellation machine snapshot payloads."""

import argparse
import json
import sys
from datetime import datetime, timezone


VALID_NODE_TYPES = {"infra", "agent", "service"}


def _is_object(value):
    return isinstance(value, dict)


def _is_array(value):
    return isinstance(value, list)


def _parse_iso_timestamp(value):
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def validate_snapshot(data):
    """Return a list of validation errors. Empty list means valid."""
    errors = []

    if not _is_object(data):
        return ["snapshot must be an object"]

    if data.get("schema_version") != 1:
        errors.append("schema_version must be 1")

    machine = data.get("machine")
    if not _is_object(machine):
        errors.append("machine must be an object")
        machine = {}

    for field in ("tag", "hostname", "os"):
        value = machine.get(field)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"machine.{field} is required")

    if _parse_iso_timestamp(data.get("collected_at")) is None:
        errors.append("collected_at must be an ISO timestamp")

    gateway = data.get("gateway")
    if gateway is not None and not _is_object(gateway):
        errors.append("gateway must be an object")

    agents = data.get("agents")
    if not _is_object(agents):
        errors.append("agents must be an object")
        agents = {}

    for agent_id, agent in agents.items():
        if not _is_object(agent):
            errors.append(f"agents.{agent_id} must be an object")
            continue
        for field in ("id", "label", "type"):
            if not isinstance(agent.get(field), str) or not agent.get(field).strip():
                errors.append(f"agents.{agent_id}.{field} is required")
        if agent.get("type") and agent.get("type") not in VALID_NODE_TYPES:
            errors.append(f"agents.{agent_id}.type must be one of {sorted(VALID_NODE_TYPES)}")
        details = agent.get("details")
        if details is not None and not _is_object(details):
            errors.append(f"agents.{agent_id}.details must be an object")

    edges = data.get("edges")
    if not _is_array(edges):
        errors.append("edges must be an array")
        edges = []

    for idx, edge in enumerate(edges):
        if not _is_array(edge) or len(edge) != 4:
            errors.append(f"edges[{idx}] must be [from, to, type, color]")
            continue
        if not all(isinstance(part, str) and part for part in edge):
            errors.append(f"edges[{idx}] values must be non-empty strings")

    honcho_peers = data.get("honcho_peers")
    if honcho_peers is not None and not _is_array(honcho_peers):
        errors.append("honcho_peers must be an array")

    return errors


def main(argv=None):
    parser = argparse.ArgumentParser(description="Validate a Constellation machine snapshot JSON file")
    parser.add_argument("snapshot", help="Path to <machine>_agents.json")
    args = parser.parse_args(argv)

    try:
        with open(args.snapshot, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"invalid: {e}", file=sys.stderr)
        return 1

    errors = validate_snapshot(data)
    if errors:
        for error in errors:
            print(f"invalid: {error}", file=sys.stderr)
        return 1

    print("valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
