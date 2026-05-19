import hmac
import io
import tempfile
import unittest
from contextlib import redirect_stdout

from signing import body_sha256_hex, build_signing_input, main, sign_snapshot, verify_signature


class SigningContractTests(unittest.TestCase):
    def test_body_hash_is_sha256_hex_of_exact_bytes(self):
        body = b'{"schema_version":1}'

        self.assertEqual(
            body_sha256_hex(body),
            "a9d5f6d002d956b8af5787a05e0ca000d45c03977ffa54ee8fbed719fed5fd23",
        )

    def test_signing_input_is_timestamp_machine_and_body_hash(self):
        body = b'{"schema_version":1}'
        timestamp = "2026-05-19T10:46:18Z"

        result = build_signing_input(timestamp, "linux", body)

        self.assertEqual(
            result,
            "2026-05-19T10:46:18Z\nlinux\na9d5f6d002d956b8af5787a05e0ca000d45c03977ffa54ee8fbed719fed5fd23",
        )

    def test_signature_is_hmac_sha256_prefixed_with_sha256(self):
        body = b'{"schema_version":1}'
        timestamp = "2026-05-19T10:46:18Z"

        signature = sign_snapshot("secret", timestamp, "linux", body)

        self.assertTrue(signature.startswith("sha256="))
        self.assertTrue(verify_signature("secret", timestamp, "linux", body, signature))
        self.assertFalse(verify_signature("wrong", timestamp, "linux", body, signature))

    def test_signature_verification_uses_constant_time_compare(self):
        self.assertIs(verify_signature.__globals__["compare_digest"], hmac.compare_digest)

    def test_cli_signs_body_file(self):
        with tempfile.NamedTemporaryFile() as f:
            f.write(b'{"schema_version":1}')
            f.flush()
            out = io.StringIO()

            with redirect_stdout(out):
                code = main([
                    "--secret", "secret",
                    "--timestamp", "2026-05-19T10:46:18Z",
                    "--machine", "linux",
                    "--body", f.name,
                ])

        self.assertEqual(code, 0)
        self.assertTrue(out.getvalue().strip().startswith("sha256="))


if __name__ == "__main__":
    unittest.main()
