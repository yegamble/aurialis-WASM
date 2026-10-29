"""Check the shared production and rollback response-header policy."""
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / ".github/scripts/cloudflare-policy-headers.sh"
POLICY = """HTTP/2 200
cross-origin-opener-policy: same-origin
cross-origin-embedder-policy: require-corp
cache-control: no-store, no-transform
x-frame-options: DENY
strict-transport-security: max-age=63072000; includeSubDomains
permissions-policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
"""
CHECK = 'source "$1"; assert_cloudflare_policy_headers fixture "$2"'


class CloudflarePolicyHeaderTests(unittest.TestCase):
    def check(self, headers):
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as output:
            output.write(headers)
            output.flush()
            return subprocess.run(["bash", "-c", CHECK, "_", str(HELPER), output.name], capture_output=True, check=False)

    def test_accepts_the_canonical_policy(self):
        self.assertEqual(self.check(POLICY).returncode, 0)

    def test_rejects_missing_hsts_and_wrong_coep(self):
        self.assertNotEqual(self.check(POLICY.replace("strict-transport-security:", "legacy-hsts:" )).returncode, 0)
        self.assertNotEqual(self.check(POLICY.replace("require-corp", "unsafe-none")).returncode, 0)


if __name__ == "__main__":
    unittest.main()
