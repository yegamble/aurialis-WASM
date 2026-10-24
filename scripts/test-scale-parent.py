"""Parent ACK and external-service admission controls; no ps/browser/process launch."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).parent / "qualification"))
import scale_service
from scale_resources import GIB, MIN_FREE, MAX_DATA, admit_sample
SPEC = importlib.util.spec_from_file_location("scale_parent", Path(__file__).parent / "run-album-scale.py")
PARENT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PARENT)


class ParentContracts(unittest.TestCase):
    def test_parent_signal_handler_only_sets_stop_without_interrupting_handle_assignment(self):
        flag = PARENT.StopFlag(); sentinel = object()
        def spawn():
            flag(15, None)
            return sentinel
        handle = spawn()
        self.assertIs(handle, sentinel)
        self.assertEqual(flag.signal, 15)

    def test_changed_fresh_resource_denial_prevents_ack_publication(self):
        emitted = []
        def fresh():
            values = {"dataBytes": 0, "scratchBytes": 0, "nodeRSS": 1, "nativeRSS": 0, "supervisorRSS": 1, "serviceGroupRSS": 1, "browserGroupRSS": 3 * GIB + 1, "ownedRSS": 3 * GIB + 4, "processes": 4, "knownIdentities": 4}
            admit_sample(values, available=MIN_FREE + MAX_DATA, elapsed=0, seconds=60)
        with self.assertRaisesRegex(RuntimeError, "Collective browser"):
            PARENT.acknowledge_work(fresh, emitted.append, {"workerPID": 11, "nodePID": 10})
        self.assertEqual(emitted, [])

    def test_fresh_member_loss_prevents_ack_even_when_previous_sample_passed(self):
        emitted = []
        with self.assertRaisesRegex(RuntimeError, "fresh live"):
            PARENT.acknowledge_work(lambda: {"owned": {"liveMembers": []}}, emitted.append, {"workerPID": 11, "nodePID": 10})
        self.assertEqual(emitted, [])

    def test_complete_fresh_check_precedes_exact_ack(self):
        events = []
        value = {"workerPID": 11, "nodePID": 10}
        def sample():
            events.append("fresh-complete-check")
            return {"owned": {"liveMembers": [{"pid": 11, "pgid": 10}]}}
        PARENT.acknowledge_work(sample, lambda payload: events.append(("ack", dict(payload))), value)
        self.assertEqual(events, ["fresh-complete-check", ("ack", value)])

    def fixture(self, directory):
        base = Path(directory).resolve(); (base / "deploy/cloudflare").mkdir(parents=True)
        config = {"$schema": "../../node_modules/wrangler/config-schema.json", "name": "test", "main": "worker.ts", "compatibility_date": "2026-10-23", "compatibility_flags": ["nodejs_compat"], "workers_dev": True, "preview_urls": False, "assets": {"directory": "./assets", "binding": "ASSETS", "run_worker_first": True, "html_handling": "none", "not_found_handling": "404-page"}, "observability": {"enabled": True, "head_sampling_rate": 0.1}}
        (base / "deploy/cloudflare/wrangler.jsonc").write_text(json.dumps(config))
        cli = base / "node_modules/wrangler/wrangler-dist/cli.js"; cli.parent.mkdir(parents=True); cli.write_text("fixture-only source")
        return base, base / "budget", base / "node"

    def test_service_contract_routes_every_configured_writable_path_inside_root(self):
        with tempfile.TemporaryDirectory() as directory:
            base, root, node = self.fixture(directory)
            with patch.object(Path, "home", return_value=base / "fresh-home"):
                contract = scale_service.service_contract(base, root, node, 3997)
            self.assertEqual(contract["argv"][:3], [str(node), str((base / "node_modules/wrangler/wrangler-dist/cli.js").resolve()), "dev"])
            for key in ("TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "WRANGLER_REGISTRY_PATH", "WRANGLER_LOG_PATH"):
                Path(contract["environment"][key]).relative_to(root)
            self.assertNotIn("HOME", contract["environment"])
            self.assertEqual(contract["config"]["assets"]["directory"], str(base / "deploy/cloudflare/assets"))
            self.assertEqual(contract["environment"]["WRANGLER_SEND_METRICS"], "false")

    def test_existing_legacy_global_directory_or_changed_config_refuses(self):
        with tempfile.TemporaryDirectory() as directory:
            base, root, node = self.fixture(directory)
            (base / ".wrangler").mkdir()
            with patch.object(Path, "home", return_value=base), self.assertRaisesRegex(RuntimeError, "legacy Wrangler"):
                scale_service.service_contract(base, root, node, 3997)
            path = base / "deploy/cloudflare/wrangler.jsonc"; value = json.loads(path.read_text()); value["r2_buckets"] = []; path.write_text(json.dumps(value))
            with patch.object(Path, "home", return_value=base / "fresh-home"), self.assertRaisesRegex(RuntimeError, "requires review"):
                scale_service.service_contract(base, root, node, 3997)

    def test_exact_service_command_config_and_listener_membership_are_required(self):
        with tempfile.TemporaryDirectory() as directory:
            base, root, node = self.fixture(directory)
            with patch.object(Path, "home", return_value=base / "fresh-home"):
                contract = scale_service.service_contract(base, root, node, 3997)
            config = Path(contract["argv"][4]); config.parent.mkdir(parents=True); config.write_text(json.dumps(contract["config"]))
            observer = Mock(); observer.identity = {"pid": 100}; observer.observe.return_value = [{"pid": 100}, {"pid": 101}]
            command = " ".join(contract["argv"])
            with patch.object(scale_service.subprocess, "check_output", side_effect=[command, "p101\n"]):
                self.assertTrue(scale_service.pin_service(observer, contract, {})["observationOnly"])
            with patch.object(scale_service.subprocess, "check_output", return_value=command.replace("/node ", "/wrong-node ")):
                with self.assertRaisesRegex(RuntimeError, "exact pinned"):
                    scale_service.pin_service(observer, contract, {})
            with patch.object(scale_service.subprocess, "check_output", side_effect=[command, "p999\n"]):
                with self.assertRaisesRegex(RuntimeError, "listener does not belong"):
                    scale_service.pin_service(observer, contract, {})
            modified = copy.deepcopy(contract["config"]); modified["assets"]["directory"] = "/foreign"; config.write_text(json.dumps(modified))
            with self.assertRaisesRegex(RuntimeError, "effective config"):
                scale_service.pin_service(observer, contract, {})


if __name__ == "__main__":
    unittest.main()
