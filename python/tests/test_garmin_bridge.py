import copy
import io
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from garmin_bridge import classify, execute, get_client, load_config, main, send_workout, validate_send, web_login
from garmin_storage import BridgeError, Receipts, prepare_storage, private_directory
from garmin_verify import calendar_contains, workout_matches


def payload(sport=1):
    step = {"type": "ExecutableStepDTO", "stepOrder": 2, "stepType": {"stepTypeId": 3},
            "endCondition": {"conditionTypeId": 2}, "endConditionValue": 120,
            "targetType": {"workoutTargetTypeId": 6}, "targetValueOne": 2.777777, "targetValueTwo": 2.5,
            "description": "Steady"}
    group = {"type": "RepeatGroupDTO", "stepOrder": 1, "stepType": {"stepTypeId": 6},
             "numberOfIterations": 2, "workoutSteps": [step]}
    return {"operationId": "12345678-1234-4234-8234-123456789abc", "date": "2026-10-10",
            "workout": {"workoutName": "Test", "sportType": {"sportTypeId": sport},
                        "workoutSegments": [{"sportType": {"sportTypeId": sport}, "workoutSteps": [group]}]}}


class GarminBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.receipts = Receipts(self.directory / "receipts.sqlite")
        self.data = payload()
        self.api = Mock(profile_id=123)
        self.api.upload_workout.return_value = {"workoutId": 42}
        self.api.get_workout_by_id.return_value = copy.deepcopy(self.data["workout"])
        self.api.get_scheduled_workouts.side_effect = [[], [], [], {"calendarItems": [{"workoutId": 42, "date": "2026-10-10"}]}]

    def tearDown(self):
        self.receipts.close()
        self.temp.cleanup()

    def send(self):
        return send_workout(self.data, self.api, self.receipts, sleep=lambda _: None)

    def test_upload_verify_schedule_verify(self):
        self.assertEqual(self.send()["code"], "SCHEDULED")
        self.api.upload_workout.assert_called_once_with(self.data["workout"])
        self.api.schedule_workout.assert_called_once_with(42, "2026-10-10")

    def test_repeat_request_and_new_operation_id_do_not_duplicate(self):
        self.send()
        self.api.get_scheduled_workouts.side_effect = None
        self.api.get_scheduled_workouts.return_value = [{"workoutId": 42, "date": "2026-10-10"}]
        self.data["operationId"] = "87654321-1234-4234-8234-123456789abc"
        self.send()
        self.assertEqual(self.api.upload_workout.call_count, 1)
        self.assertEqual(self.api.schedule_workout.call_count, 1)

    def test_upload_timeout_blocks_reupload(self):
        self.api.upload_workout.side_effect = TimeoutError("password=secret")
        for _ in range(2):
            with self.assertRaises(BridgeError) as error:
                self.send()
            self.assertEqual(error.exception.code, "UPLOAD_UNCERTAIN")
        self.api.upload_workout.assert_called_once()

    def test_explicit_upload_rejection_is_reported(self):
        rejected = RuntimeError("raw secret")
        rejected.response = Mock(status_code=400)
        self.api.upload_workout.side_effect = rejected
        with self.assertRaises(BridgeError) as error:
            self.send()
        self.assertEqual(str(error.exception), "GARMIN_REJECTED")
        self.api.schedule_workout.assert_not_called()

    def test_workout_mismatch_never_schedules(self):
        self.api.get_workout_by_id.return_value["workoutSegments"][0]["workoutSteps"][0]["numberOfIterations"] = 8
        with self.assertRaises(BridgeError) as error:
            self.send()
        self.assertEqual(error.exception.code, "WORKOUT_MISMATCH")
        self.assertEqual(error.exception.workout_id, 42)
        self.api.schedule_workout.assert_not_called()

    def test_schedule_rejection_can_resume_without_upload(self):
        rejected = RuntimeError()
        rejected.response = Mock(status_code=400)
        self.api.schedule_workout.side_effect = rejected
        with self.assertRaises(BridgeError):
            self.send()
        self.api.schedule_workout.side_effect = None
        self.api.get_scheduled_workouts.side_effect = [[], [], [], [{"workoutId": 42, "date": "2026-10-10"}]]
        self.send()
        self.api.upload_workout.assert_called_once()
        self.assertEqual(self.api.schedule_workout.call_count, 2)

    def test_schedule_timeout_only_rechecks_calendar(self):
        self.api.schedule_workout.side_effect = TimeoutError()
        with self.assertRaises(BridgeError) as error:
            self.send()
        self.assertEqual(error.exception.code, "SCHEDULE_UNCERTAIN")
        self.api.get_scheduled_workouts.side_effect = None
        self.api.get_scheduled_workouts.return_value = []
        with self.assertRaises(BridgeError):
            self.send()
        self.api.schedule_workout.assert_called_once()
        self.api.upload_workout.assert_called_once()

    def test_delayed_calendar_and_retry(self):
        self.api.get_scheduled_workouts.side_effect = [[], [], [], [], [], []]
        with self.assertRaises(BridgeError) as error:
            self.send()
        self.assertEqual(error.exception.code, "CALENDAR_UNVERIFIED")
        self.api.get_scheduled_workouts.side_effect = [[], [{"workoutId": 42, "date": "2026-10-10"}]]
        self.assertTrue(self.send()["ok"])
        self.api.upload_workout.assert_called_once()
        self.api.schedule_workout.assert_called_once()

    def test_account_switch_does_not_reuse_receipt(self):
        self.send()
        self.api.profile_id = 456
        self.api.get_scheduled_workouts.side_effect = [[], [], [], [{"workoutId": 42, "date": "2026-10-10"}]]
        self.assertTrue(self.send()["ok"])
        self.assertEqual(self.api.upload_workout.call_count, 2)

    def test_changed_workout_cannot_reuse_operation(self):
        self.send()
        self.data["workout"]["workoutName"] = "Changed"
        with self.assertRaises(BridgeError) as error:
            self.send()
        self.assertEqual(error.exception.code, "OPERATION_CONFLICT")

    def test_validation_bad_date_and_unexpected_fields(self):
        self.data["date"] = "2026-02-30"
        with self.assertRaises(BridgeError):
            validate_send(self.data)
        self.data = payload()
        self.data["password"] = "must not be accepted"
        with self.assertRaises(BridgeError):
            validate_send(self.data)

    def test_readback_sport_targets_distance_and_rest(self):
        for sport in (1, 2, 4):
            expected = payload(sport)["workout"]
            actual = copy.deepcopy(expected)
            actual["workoutId"] = 42
            self.assertTrue(workout_matches(expected, actual))
            for field in ("targetValueOne", "endConditionValue", "stepType"):
                changed = copy.deepcopy(actual)
                changed["workoutSegments"][0]["workoutSteps"][0]["workoutSteps"][0][field] = 999
                self.assertFalse(workout_matches(expected, changed))

    def test_calendar_requires_id_and_date_together(self):
        self.assertFalse(calendar_contains([{"workoutId": 42, "date": "2026-10-11"}], 42, "2026-10-10"))
        self.assertFalse(calendar_contains([{"workoutId": 99, "date": "2026-10-10"}], 42, "2026-10-10"))
        self.assertTrue(calendar_contains({"items": [{"workout": {"workoutId": 42}, "date": "2026-10-10"}]}, 42, "2026-10-10"))

    def test_noninteractive_login_supplies_no_password_or_mfa(self):
        factory = Mock(return_value=self.api)
        get_client(self.directory, factory=factory)
        self.assertIsNone(factory.call_args.kwargs["password"])
        self.assertIsNone(factory.call_args.kwargs["prompt_mfa"])
        self.assertEqual(factory.call_args.kwargs["retry_attempts"], 0)

    def test_terminal_login_prompts_and_uses_mfa_callback(self):
        factory = Mock(return_value=self.api)
        token = self.directory / "garmin_tokens.json"
        token.write_text("old account")
        def login(_directory):
            self.assertFalse(token.exists())
            token.write_text("new account")
        self.api.login.side_effect = login
        with patch("garmin_bridge.prepare_storage"), patch("garmin_bridge.protect"), patch("garmin_storage.protect"), patch("garmin_bridge.getpass.getpass", side_effect=["secret", "123456"]):
            result = execute("login", self.directory, "test@example.invalid", factory=factory)
            self.assertEqual(result["code"], "READY")
            self.assertEqual(factory.call_args.kwargs["prompt_mfa"](), "123456")
            self.assertNotIn("secret", json.dumps(result))

    def test_logout_preserves_receipts_and_unrelated_files(self):
        (self.directory / "garmin_tokens.json").write_text("{}")
        (self.directory / "other.txt").write_text("keep")
        with patch("garmin_bridge.prepare_storage"), patch("garmin_bridge.protect"), patch("garmin_storage.protect"):
            execute("logout", self.directory)
        self.assertFalse((self.directory / "garmin_tokens.json").exists())
        self.assertTrue((self.directory / "receipts.sqlite").exists())
        self.assertTrue((self.directory / "other.txt").exists())

    def test_web_login_mfa_preserves_old_session_until_success(self):
        token = self.directory / "garmin_tokens.json"
        token.write_text("old session")
        events = []
        factory = Mock()
        def create(**kwargs):
            def login(directory):
                self.assertEqual(token.read_text(), "old session")
                self.assertEqual(kwargs["prompt_mfa"](), "123456")
                (Path(directory) / "garmin_tokens.json").write_text("new session")
            return Mock(login=login)
        factory.side_effect = create
        with patch("garmin_bridge.prepare_storage"), patch("garmin_bridge.protect"), patch("garmin_storage.protect"):
            result = web_login(self.directory, {"email": "test@example.invalid", "password": "secret"}, factory, lambda _: '{"code":"123456"}\n', events.append)
        self.assertEqual(events, [{"ok": False, "code": "MFA_REQUIRED"}])
        self.assertEqual(result, {"ok": True, "code": "READY"})
        self.assertEqual(token.read_text(), "new session")
        self.assertNotIn("secret", json.dumps(events + [result]))
        self.assertEqual(list(self.directory.glob("login-*")), [])

    def test_web_login_failure_preserves_previous_session(self):
        token = self.directory / "garmin_tokens.json"
        token.write_text("old session")
        factory = Mock(return_value=Mock(login=Mock(side_effect=RuntimeError("password=secret"))))
        with patch("garmin_bridge.prepare_storage"), patch("garmin_bridge.protect"), patch("garmin_storage.protect"):
            with self.assertRaises(BridgeError) as error:
                web_login(self.directory, {"email": "test@example.invalid", "password": "secret"}, factory)
        self.assertNotIn("secret", str(error.exception))
        self.assertEqual(token.read_text(), "old session")
        self.assertEqual(list(self.directory.glob("login-*")), [])

    def test_web_login_rejects_commands_and_oversized_credentials(self):
        for data in ({"email": "e", "password": "p", "command": "send"}, {"email": "e", "password": "x" * 1025}):
            with self.assertRaises(BridgeError):
                web_login(self.directory, data)

    def test_real_web_login_pipe_mfa_handshake(self):
        # Exercise the real CLI/stdin/stdout contract, not injected read/emit
        # callbacks. Only the remote Garmin client is replaced; no network.
        script = '''
import sys
from pathlib import Path
import garmin_bridge as bridge
directory = Path(sys.argv[1])
bridge.load_config = lambda: (None, directory)
class Client:
    def __init__(self, **kwargs):
        self.prompt = kwargs["prompt_mfa"]
    def login(self, directory):
        assert self.prompt() == "123456"
        (Path(directory) / "garmin_tokens.json").write_text("dummy session")
original = bridge.get_client
bridge.get_client = lambda directory, email=None, password=None, factory=None, prompt_mfa=None: original(directory, email, password, Client, prompt_mfa)
sys.argv = ["bridge", "web-login"]
sys.exit(bridge.main())
'''
        process = subprocess.Popen([sys.executable, "-u", "-c", script, str(self.directory)], cwd=Path(__file__).resolve().parents[1], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            try:
                process.stdin.write('{"email":"test@example.invalid","password":"dummy"}\n')
                process.stdin.flush()
                line = pool.submit(process.stdout.readline).result(timeout=15)
                self.assertEqual(json.loads(line), {"ok": False, "code": "MFA_REQUIRED"})
                process.stdin.write('{"code":"123456"}\n')
                process.stdin.flush()
                result = pool.submit(process.stdout.readline).result(timeout=15)
                self.assertEqual(json.loads(result), {"ok": True, "code": "READY"})
                process.wait(timeout=15)
                self.assertEqual(process.returncode, 0)
            finally:
                if process.poll() is None:
                    process.kill()
                process.communicate(timeout=5)

    def test_private_path_must_be_absolute_and_outside_repository(self):
        repo = Path(__file__).resolve().parents[2]
        for invalid in ("relative", str(repo), str(repo / "tokens"), str(Path.home()), str(Path.home().anchor)):
            with self.assertRaises(BridgeError):
                private_directory(invalid, repo)
        self.assertEqual(private_directory(str(self.directory), repo), self.directory.resolve())

    def test_cli_never_returns_raw_exception(self):
        stdout = io.StringIO()
        with patch("sys.argv", ["bridge", "status"]), patch("sys.version_info", (3, 12)), patch("garmin_bridge.load_config", side_effect=RuntimeError("token=secret")), patch("sys.stdout", stdout):
            self.assertEqual(main(), 1)
        self.assertEqual(json.loads(stdout.getvalue()), {"ok": False, "code": "BRIDGE_FAILED"})

    def test_client_http_messages_map_to_safe_codes(self):
        for status, code in ((401, "AUTH_REQUIRED"), (429, "RATE_LIMITED"), (400, "GARMIN_REJECTED"), (500, "NETWORK_FAILED")):
            self.assertEqual(classify(RuntimeError(f"API Error {status} - token=secret")), code)

    def test_expired_session_is_noninteractive_and_redacted(self):
        class GarminConnectAuthenticationError(Exception):
            pass
        self.api.login.side_effect = GarminConnectAuthenticationError("token=secret")
        factory = Mock(return_value=self.api)
        with self.assertRaises(BridgeError) as error:
            get_client(self.directory, factory=factory)
        self.assertEqual(str(error.exception), "AUTH_REQUIRED")
        self.assertIsNone(factory.call_args.kwargs["password"])

    def test_config_allowlist_and_environment_precedence(self):
        dotenv = Mock()
        dotenv.dotenv_values.return_value = {"GARMIN_EMAIL": "from-file", "GARMIN_SESSION_DIR": str(self.directory), "UNRELATED_SETTING": "ignored"}
        with patch.dict(sys.modules, {"dotenv": dotenv}), patch.dict(os.environ, {"GARMIN_EMAIL": "from-environment"}):
            email, path = load_config()
        self.assertEqual(email, "from-environment")
        self.assertEqual(path, self.directory.resolve())
        self.assertFalse(dotenv.dotenv_values.call_args.kwargs["interpolate"])

    @unittest.skipUnless(os.name == "nt", "Windows ACL integration check")
    def test_real_windows_storage_permissions(self):
        # Disposable storage only: no Garmin account, credentials, or existing tokens.
        run = subprocess.run
        def checked_run(*args, **kwargs):
            try:
                return run(*args, **kwargs)
            except subprocess.CalledProcessError as error:
                self.fail(f"Disposable Windows ACL test failed: {error.stderr.decode(errors='replace')}")
        with patch("garmin_storage.subprocess.run", side_effect=checked_run):
            prepare_storage(self.directory)
            token = self.directory / "garmin_tokens.json"
            token.write_text("{}")
            prepare_storage(self.directory)
            self.assertEqual(token.read_text(), "{}")
            script = """
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $env:LLM_GARMIN_PRIVATE_PATH
$acl = $item.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
@{Protected=$acl.AreAccessRulesProtected; Sids=@($rules | ForEach-Object {$_.IdentityReference.Value}); User=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; FullControl=@($rules | ForEach-Object {$_.FileSystemRights.ToString()})} | ConvertTo-Json -Compress
"""
            for path in (self.directory, token):
                result = run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], env={**os.environ, "LLM_GARMIN_PRIVATE_PATH": str(path)}, capture_output=True, text=True, check=True, timeout=10)
                access = json.loads(result.stdout)
                self.assertTrue(access["Protected"])
                self.assertCountEqual(access["Sids"], [access["User"], "S-1-5-18"])
                self.assertEqual(access["FullControl"], ["FullControl", "FullControl"])


if __name__ == "__main__":
    unittest.main()
