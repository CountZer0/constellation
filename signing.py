#!/usr/bin/env python3
"""HMAC signing helpers for Constellation telemetry snapshots."""

import argparse
import hashlib
import hmac
from hmac import compare_digest


def body_sha256_hex(body):
    """Return SHA-256 hex digest of exact request body bytes."""
    if isinstance(body, str):
        body = body.encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def build_signing_input(timestamp, machine_id, body):
    """Build the canonical signing input.

    Format:
      <timestamp>\n<machine_id>\n<body_sha256_hex>
    """
    return f"{timestamp}\n{machine_id}\n{body_sha256_hex(body)}"


def sign_snapshot(secret, timestamp, machine_id, body):
    """Return sha256=<hex hmac> for the canonical snapshot signing input."""
    if isinstance(secret, str):
        secret = secret.encode("utf-8")
    signing_input = build_signing_input(timestamp, machine_id, body).encode("utf-8")
    digest = hmac.new(secret, signing_input, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


def verify_signature(secret, timestamp, machine_id, body, signature):
    """Verify a Constellation snapshot signature using constant-time comparison."""
    expected = sign_snapshot(secret, timestamp, machine_id, body)
    return compare_digest(expected, signature or "")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Sign a Constellation snapshot body")
    parser.add_argument("--secret", required=True, help="HMAC secret")
    parser.add_argument("--timestamp", required=True, help="Request timestamp")
    parser.add_argument("--machine", required=True, help="Machine ID/tag")
    parser.add_argument("--body", required=True, help="Path to JSON request body")
    args = parser.parse_args(argv)

    with open(args.body, "rb") as f:
        body = f.read()
    print(sign_snapshot(args.secret, args.timestamp, args.machine, body))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
