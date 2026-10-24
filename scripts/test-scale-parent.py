"""Parent ACK and external-service admission controls; no ps/browser/process launch."""
import copy
import ast
from types import SimpleNamespace
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
    def cleanup_branch(self, members):
        # Execute the actual parent's cleanup branch without invoking main, OS
        # observation, metadata IO or deletion. This catches stale-variable use.
        source = Path(__file__).parent / "run-album-scale.py"
        tree = ast.parse(source.read_text())
        branch = next(node for node in ast.walk(tree) if isinstance(node, ast.If)
                      and ast.unparse(node.test) == "primary is None and (not cleanup) and (arguments.mode != 'crash')")
        code = compile(ast.fix_missing_locations(ast.Module(body=[branch], type_ignores=[])), str(source), "exec")
        launcher = {"mode": "normal", "project": "album-native-scale", "primary": None, "cleanup": [], "childExit": None, "audioProcessing": False}
        ready = {"token": "token", "status": "pass", "ownershipAcknowledgedBeforeWorker": True, "nodePID": 10, "browserPID": 20, "mode": "normal", "audioProcessing": False}
        fresh = {"owned": {"groups": [10, 20], "liveMembers": members}, "values": {"processes": len(members), "ownedRSS": len(members)}}
        profile = Mock(); profile.cleanup_success.return_value = {"mockOnly": True}
        write = Mock()
        environment = {"primary": None, "cleanup": [], "arguments": SimpleNamespace(mode="normal", project="album-native-scale"),
                       "read_json": lambda path, limit: (launcher if path.name == "launcher.json" else ready, {"path": str(path)}),
                       "control": Path("/no-real-io/control"), "validate_launcher": PARENT.validate_launcher,
                       "completion_proof": [], "token": "token", "child": SimpleNamespace(pid=10, returncode=0, poll=lambda: 0),
                       "owned": SimpleNamespace(leaders={"browser": {"pid": 20}}), "last_sample": fresh,
                       "sample": lambda: fresh, "final_observation": {"liveMembers": []}, "profile_owner": profile,
                       "root": Path("/no-real-io"), "scratch": Path("/no-real-io/native"), "write_metadata": write,
                       "profile_descriptor": {"mockOnly": True}, "profile_cleanup": None}
        exec(code, environment)
        return environment, profile, write, fresh

    def test_new_live_member_after_stale_empty_observation_refuses_cleanup_and_commit(self):
        environment, profile, write, fresh = self.cleanup_branch([{"pid": 21, "pgid": 20}])
        profile.validate.assert_not_called()
        profile.cleanup_success.assert_not_called()
        write.assert_not_called()
        self.assertEqual(environment["cleanup"][0]["phase"], "success-profile-cleanup")
        self.assertIn("empty owned groups", environment["cleanup"][0]["message"])
        self.assertIs(environment["final_observation"], fresh["owned"])

    def test_immediate_empty_observation_is_bound_into_durable_cleanup_commit(self):
        environment, profile, write, fresh = self.cleanup_branch([])
        self.assertEqual(environment["cleanup"], [])
        profile.cleanup_success.assert_called_once()
        receipt = write.call_args.args[1]
        self.assertTrue(receipt["emptyOwnedGroups"])
        self.assertIs(receipt["ownedObservation"], fresh["owned"])
        self.assertIs(receipt["resourceSample"], fresh["values"])

    def test_assigned_node_survives_observer_setup_failure_and_is_reaped_under_configured_clock(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve(); (base / "artifacts").mkdir(); node = base / "fixture-node"; node.write_text("never executed")
            owner = {"pid": __import__("os").getpid(), "ppid": 1, "pgid": 90, "start": "owner", "rssBytes": 1, "state": "S"}
            process = Mock(pid=333); process.poll.return_value = None
            process.terminate.side_effect = lambda: setattr(process.poll, "return_value", 0)
            observer = Mock(identity=owner); observer.observe.return_value = owner
            profile = Mock(); profile.state.return_value = {}; profile.create.return_value = {}
            arguments = ["run-album-scale.py", "--budget-root", str(base / "artifacts/budget"), "--scratch", str(base / "artifacts/budget/normal"), "--node", str(node), "--mode", "normal", "--seconds", "60"]
            with patch.object(PARENT.sys, "argv", arguments), patch.object(PARENT.Path, "cwd", return_value=base), patch.object(PARENT, "qualification_runtime", return_value={"fixture": True}), patch.object(PARENT, "snapshot", return_value={owner["pid"]: owner}), patch.object(PARENT, "command_hash", return_value="a" * 64), patch.object(PARENT, "ObservedProcess", return_value=observer), patch.object(PARENT, "OwnedProfile", return_value=profile), patch.object(PARENT, "OwnedGroups", side_effect=RuntimeError("observer setup rejected")), patch.object(PARENT.subprocess, "check_output", return_value="v26.12.0"), patch.object(PARENT.subprocess, "Popen", return_value=process), patch.object(PARENT.os, "statvfs", return_value=SimpleNamespace(f_bavail=20 * 1024 ** 3, f_frsize=1)), patch.object(PARENT.sys, "stdout", new=SimpleNamespace(buffer=__import__("io").BytesIO())):
                try:
                    self.assertEqual(PARENT.main(), 1)
                finally:
                    PARENT.clock.configure(None)
            process.terminate.assert_called_once()
            process.wait.assert_called()
            receipt = json.loads((base / "artifacts/budget/guard-normal.json").read_text())
            self.assertEqual(receipt["primary"]["message"], "observer setup rejected")
            self.assertEqual(receipt["deadline"]["absoluteSeconds"], 120)
            profile.cleanup_success.assert_not_called()

    def test_actual_sample_allows_bounded_cleanup_after_work_cap_without_allowing_more_work(self):
        tree = ast.parse((Path(__file__).parent / "run-album-scale.py").read_text())
        definition = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == "sample")
        definition.body = [ast.Global(names=node.names) if isinstance(node, ast.Nonlocal) else node for node in definition.body]
        code = compile(ast.fix_missing_locations(ast.Module(body=[definition], type_ignores=[])), "actual-parent-sample", "exec")
        owner = {"pid": 90, "ppid": 1, "pgid": 90, "start": "owner", "rssBytes": 1, "state": "S"}
        parent = Mock(identity=owner); parent.observe.return_value = owner
        environment = {**PARENT.__dict__, "minimum_free": 20 * 1024 ** 3, "samples": 0, "last_sample": None, "stopping": SimpleNamespace(signal=None), "snapshot": lambda: {90: owner}, "owned": None, "native": None, "service": None, "service_ready": False, "owned_service": None, "service_terminal": False, "parent": parent, "child": None, "base": Path("/mock"), "root": Path("/mock"), "scratch": Path("/mock/normal"), "started": 0, "arguments": SimpleNamespace(seconds=60), "work_closed": True, "peaks": dict.fromkeys(("dataBytes", "scratchBytes", "logBytes", "reportBytes", "miscBytes", "ownedRSS", "nativeRSS", "nodeRSS", "browserGroupRSS", "serviceGroupRSS", "supervisorRSS", "processes", "knownIdentities"), 0), "disk_values": lambda root, scratch: dict.fromkeys(("dataBytes", "scratchBytes", "logBytes", "reportBytes", "miscBytes"), 0)}
        exec(code, environment)
        with patch.object(PARENT.time, "monotonic", return_value=64), patch.object(PARENT.os, "statvfs", return_value=SimpleNamespace(f_bavail=20 * 1024 ** 3, f_frsize=1)):
            self.assertEqual(environment["sample"]()["phase"], "cleanup")
            environment["work_closed"] = False
            with self.assertRaisesRegex(RuntimeError, "wall deadline"): environment["sample"]()

    def test_deadline_exhaustion_still_kills_and_attempts_nonblocking_direct_reap(self):
        process = Mock(); process.poll.return_value = None
        with patch.object(PARENT.clock, "remaining", side_effect=RuntimeError("deadline exhausted")):
            PARENT.reap_assigned(process)
        process.kill.assert_called_once(); process.wait.assert_called_once_with(timeout=0)

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
