"""Experimental local Garmin adapter. Machine commands accept JSON on stdin."""
from __future__ import annotations

import argparse
import contextlib
from datetime import date
import getpass
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import sys
import time

from garmin_storage import BridgeError, Receipts, exclusive_operation, prepare_storage, private_directory, protect
from garmin_verify import calendar_contains, workout_matches

REPO = Path(__file__).resolve().parent.parent
MAX_INPUT_BYTES = 1_048_576


def error_status(error: Exception):
    status = getattr(getattr(error, "response", None), "status_code", None)
    if status is None:
        # The pinned client may expose HTTP status only in its exception message.
        # Read the numeric status, never return or log that message.
        match = re.search(r"\bAPI Error (\d{3})\b", str(error))
        status = int(match[1]) if match else None
    return status


def classify(error: Exception) -> str:
    name = type(error).__name__
    status = error_status(error)
    if "Authentication" in name or status in (401, 403):
        return "AUTH_REQUIRED"
    if "TooManyRequests" in name or status == 429:
        return "RATE_LIMITED"
    if status is not None and 400 <= status < 500:
        return "GARMIN_REJECTED"
    return "NETWORK_FAILED"


def validate_send(data):
    if not isinstance(data, dict) or set(data) != {"operationId", "date", "workout"}:
        raise BridgeError("INVALID_REQUEST")
    operation_id = data["operationId"]
    if not isinstance(operation_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]{16,80}", operation_id):
        raise BridgeError("INVALID_REQUEST")
    try:
        if date.fromisoformat(data["date"]).isoformat() != data["date"]:
            raise ValueError()
    except (ValueError, TypeError):
        raise BridgeError("INVALID_REQUEST") from None
    workout = data["workout"]
    if not isinstance(workout, dict) or not isinstance(workout.get("workoutName"), str) or not workout["workoutName"].strip():
        raise BridgeError("INVALID_REQUEST")
    if workout.get("sportType", {}).get("sportTypeId") not in (1, 2, 4) or not workout.get("workoutSegments"):
        raise BridgeError("INVALID_REQUEST")
    return data


def send_workout(data, api, receipts: Receipts, sleep=time.sleep):
    """Writes occur once; an unknown write outcome must be reconciled manually."""
    validate_send(data)
    account = str(api.profile_id or "")
    if not account:
        raise BridgeError("AUTH_REQUIRED")
    operation_id, scheduled_date, workout = data["operationId"], data["date"], data["workout"]
    fingerprint = hashlib.sha256(json.dumps([account, scheduled_date, workout], sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    receipts.check_operation(account, operation_id, fingerprint)
    receipt = receipts.get(fingerprint)
    stage = receipt["stage"] if receipt else "new"
    workout_id = receipt["workout_id"] if receipt else None

    def save(next_stage):
        receipts.save(fingerprint, operation_id, account, next_stage, workout_id)

    def verified_calendar(attempts=3):
        year, month = map(int, scheduled_date.split("-")[:2])
        for attempt in range(attempts):
            if attempt:
                sleep(2)
            try:
                if calendar_contains(api.get_scheduled_workouts(year, month), workout_id, scheduled_date):
                    return True
            except Exception as error:
                if classify(error) in ("AUTH_REQUIRED", "RATE_LIMITED"):
                    raise BridgeError(classify(error), workout_id) from None
                if attempt == attempts - 1:
                    raise BridgeError("CALENDAR_UNVERIFIED", workout_id) from None
        return False

    if stage in ("uploading", "upload_uncertain"):
        raise BridgeError("UPLOAD_UNCERTAIN")
    if stage in ("new", "rejected"):
        save("uploading")  # Commit before calling Garmin, including before process timeouts.
        try:
            uploaded = api.upload_workout(workout)
            candidate = uploaded.get("workoutId") if isinstance(uploaded, dict) else None
            if isinstance(candidate, bool) or not str(candidate).isdigit() or int(candidate) <= 0:
                raise ValueError("Missing workout ID")
            workout_id = int(candidate)
        except Exception as error:
            status = error_status(error)
            rejected = status is not None and 400 <= status < 500
            save("rejected" if rejected else "upload_uncertain")
            raise BridgeError(classify(error) if rejected else "UPLOAD_UNCERTAIN") from None
        save("uploaded")
        stage = "uploaded"

    try:
        actual = api.get_workout_by_id(workout_id)
    except Exception as error:
        raise BridgeError(classify(error), workout_id) from None
    if not workout_matches(workout, actual):
        raise BridgeError("WORKOUT_MISMATCH", workout_id)
    if stage in ("scheduled", "scheduling", "complete"):
        if not verified_calendar():
            raise BridgeError("SCHEDULE_UNCERTAIN" if stage == "scheduling" else "CALENDAR_UNVERIFIED", workout_id)
    else:
        save("verified")
        # An existing matching entry means no additional calendar write is needed.
        if not verified_calendar(attempts=1):
            save("scheduling")
            try:
                api.schedule_workout(workout_id, scheduled_date)
            except Exception as error:
                status = error_status(error)
                rejected = status is not None and 400 <= status < 500
                if rejected:
                    save("verified")
                raise BridgeError(classify(error) if rejected else "SCHEDULE_UNCERTAIN", workout_id) from None
            save("scheduled")
            if not verified_calendar():
                raise BridgeError("CALENDAR_UNVERIFIED", workout_id)
    save("complete")
    return {"ok": True, "code": "SCHEDULED", "workoutId": workout_id, "date": scheduled_date}


def load_config():
    try:
        from dotenv import dotenv_values
    except ImportError:
        raise BridgeError("SETUP_REQUIRED") from None
    # Only two allowlisted settings. No dotenv variable interpolation or secret injection.
    values = dotenv_values(REPO / ".env", interpolate=False)
    email = os.environ.get("GARMIN_EMAIL", values.get("GARMIN_EMAIL"))
    configured = os.environ.get("GARMIN_SESSION_DIR", values.get("GARMIN_SESSION_DIR"))
    return email, private_directory(configured, REPO)


def get_client(directory: Path, email=None, password=None, factory=None, prompt_mfa=None):
    if factory is None:
        try:
            from garminconnect import Garmin
        except ImportError:
            raise BridgeError("SETUP_REQUIRED") from None
        factory = Garmin
    # Noninteractive commands have no credentials and no MFA callback.
    api = factory(email=email, password=password, prompt_mfa=(prompt_mfa or (lambda: getpass.getpass("Garmin MFA code: "))) if password is not None else None, retry_attempts=0)
    try:
        api.login(str(directory))
    except BridgeError:
        raise
    except Exception as error:
        if password is None and not (directory / "garmin_tokens.json").exists():
            raise BridgeError("AUTH_REQUIRED") from None
        raise BridgeError(classify(error)) from None
    return api


def execute(command, directory, email=None, data=None, factory=None):
    prepare_storage(directory)
    with exclusive_operation(directory):
        if command == "logout":
            # Do not remove receipts or any unrelated user files.
            token = directory / "garmin_tokens.json"
            if token.exists():
                protect(token)
                token.unlink()
            return {"ok": True, "code": "LOGGED_OUT"}
        if command == "login":
            email = email or input("Garmin email: ").strip()
            password = getpass.getpass("Garmin password: ")
            # Explicit login must authenticate the requested account, not silently
            # resume an older account because the library prefers cached tokens.
            token = directory / "garmin_tokens.json"
            if token.exists():
                protect(token)
                token.unlink()
            api = get_client(directory, email, password, factory)
            if not (directory / "garmin_tokens.json").is_file():
                raise BridgeError("SESSION_NOT_SAVED")
            protect(directory / "garmin_tokens.json")
            return {"ok": True, "code": "READY"}
        api = get_client(directory, factory=factory)
        if (directory / "garmin_tokens.json").exists():
            protect(directory / "garmin_tokens.json")
        if command == "status":
            return {"ok": True, "code": "READY"}
        receipts = Receipts(directory / "receipts.sqlite")
        try:
            protect(directory / "receipts.sqlite")
            return send_workout(data, api, receipts)
        finally:
            receipts.close()


def web_login(directory, data, factory=None, read_line=None, emit=None):
    """Credentials travel over stdin only; MFA keeps this locked process alive."""
    import tempfile
    if not isinstance(data, dict) or set(data) != {"email", "password"}:
        raise BridgeError("INVALID_REQUEST")
    if any(not isinstance(data[key], str) or not 0 < len(data[key]) <= 1024 for key in data):
        raise BridgeError("INVALID_REQUEST")
    read_line = read_line or sys.stdin.readline
    def output(value):
        sys.__stdout__.write(json.dumps(value) + "\n")
        sys.__stdout__.flush()
    emit = emit or output
    def mfa():
        emit({"ok": False, "code": "MFA_REQUIRED"})
        try:
            value = json.loads(read_line(4096))
        except (ValueError, TypeError):
            raise BridgeError("CANCELLED") from None
        if not isinstance(value, dict) or set(value) != {"code"} or not isinstance(value["code"], str) or not value["code"].isdigit() or not 4 <= len(value["code"]) <= 10:
            raise BridgeError("INVALID_REQUEST")
        return value["code"]
    prepare_storage(directory)
    with exclusive_operation(directory):
        # Failed login leaves the existing account/session intact.
        with tempfile.TemporaryDirectory(prefix="login-", dir=directory) as staging:
            staged = Path(staging)
            protect(staged)
            get_client(staged, data["email"], data["password"], factory, mfa)
            token = staged / "garmin_tokens.json"
            if not token.is_file():
                raise BridgeError("SESSION_NOT_SAVED")
            protect(token)
            os.replace(token, directory / "garmin_tokens.json")
            protect(directory / "garmin_tokens.json")
    return {"ok": True, "code": "READY"}


def main():
    parser = argparse.ArgumentParser(description="Experimental Garmin Connect bridge")
    parser.add_argument("command", choices=("login", "web-login", "status", "send", "logout"))
    args = parser.parse_args()
    logging.disable(logging.CRITICAL)  # Third-party exception/debug logs may include secrets.
    os.umask(0o077)
    try:
        if sys.version_info < (3, 12):
            raise BridgeError("PYTHON_VERSION")
        email, directory = load_config()
        data = None
        if args.command == "send":
            raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
            if len(raw) > MAX_INPUT_BYTES:
                raise BridgeError("INVALID_REQUEST")
            try:
                data = validate_send(json.loads(raw))
            except (ValueError, TypeError):
                raise BridgeError("INVALID_REQUEST") from None
        if args.command == "web-login":
            try:
                data = json.loads(sys.stdin.readline(4096))
            except ValueError:
                raise BridgeError("INVALID_REQUEST") from None
            with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                result = web_login(directory, data)
        elif args.command == "login":
            result = execute(args.command, directory, email, data)
        else:
            # Prevent library print() output from leaking into the machine protocol.
            with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                result = execute(args.command, directory, email, data)
    except BridgeError as error:
        result = {"ok": False, "code": error.code}
        if error.workout_id is not None:
            result["workoutId"] = error.workout_id
    except (KeyboardInterrupt, EOFError):
        result = {"ok": False, "code": "CANCELLED"}
    except Exception:
        result = {"ok": False, "code": "BRIDGE_FAILED"}
    print(json.dumps(result, allow_nan=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
