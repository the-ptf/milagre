#!/usr/bin/env python3
"""Build/stage the dedicated runtime separately, without touching app-fixture pins.

No executable, profile, socket or account override is accepted. The public-launch
read test uses a synthetic explicit account selection and launches no provider.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

CRATE = Path(__file__).resolve().parents[1]
REPO = CRATE.parents[1]
RUNTIME = REPO / "experiments/rust-runtime"
TARGET = CRATE / "target/owned-chat-backend"
TESTS = [
    "launcher::owned_chat_launch::tests::owned_chat_reads_restart_and_reconnect",
    "launcher::owned_chat_launch::tests::owned_chat_fixed_provider_actions_persist_across_restart",
    "launcher::owned_chat_launch::tests::owned_chat_terminal_actions_use_one_owner_with_explicit_reader_connection",
]


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def main():
    subprocess.run([
        "cargo", "build", "--offline", "--locked", "--manifest-path", str(RUNTIME / "Cargo.toml"),
        "--target-dir", str(TARGET), "--features", "chat-runtime-fixture",
        "--bin", "chat-runtime", "--bin", "runtime-fake-claude",
    ], cwd=REPO, check=True)
    built = subprocess.run([
        "cargo", "test", "--offline", "--locked", "--manifest-path", str(CRATE / "Cargo.toml"),
        "--features", "owned-chat", "--no-run", "--message-format=json",
    ], cwd=REPO, capture_output=True, text=True, check=True)
    runners = []
    for line in built.stdout.splitlines():
        item = json.loads(line)
        if item.get("reason") == "compiler-artifact" and item.get("executable") and item["target"]["name"] == "milagre_daemon_client" and item["profile"]["test"]:
            runners.append(Path(item["executable"]))
    if len(runners) != 1:
        raise SystemExit("Expected one client test runner")
    with tempfile.TemporaryDirectory(prefix="milagre-owned-chat-stage-", dir="/tmp") as name:
        stage = Path(name).resolve()
        stage.chmod(0o700)
        binaries = {
            "client-contract-tests": runners[0],
            "chat-runtime": TARGET / "debug/chat-runtime",
            "runtime-fake-claude": TARGET / "debug/runtime-fake-claude",
        }
        for name, source in binaries.items():
            shutil.copyfile(source, stage / name)
            (stage / name).chmod(0o700)
        for name in ["home", "tmp"]:
            (stage / name).mkdir(mode=0o700)
        canary = stage / "home/production-profile-canary"
        canary.write_text("Do not discover or modify this synthetic ambient profile.\n")
        before = canary.read_bytes()
        print("OWNED_CHAT_STAGE_MANIFEST " + json.dumps({
            "checkoutHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip(),
            "sourceAttestation": False,
            "stage": str(stage),
            "sha256": {name: digest(stage / name) for name in binaries},
            "backendTarget": str(TARGET),
        }), flush=True)
        combined = ""
        for test in TESTS:
            result = subprocess.run([
                str(stage / "client-contract-tests"), "--ignored", "--exact", test,
                "--nocapture", "--test-threads=1",
            ], cwd=stage, env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(stage / "home"), "TMPDIR": str(stage / "tmp"), "LANG": "en_US.UTF-8"}, capture_output=True, text=True, timeout=120)
            print(result.stdout, end="", flush=True)
            print(result.stderr, end="", flush=True)
            if result.returncode:
                raise SystemExit(result.returncode)
            combined += result.stdout
        if canary.read_bytes() != before:
            raise SystemExit("Synthetic ambient profile changed")
        if "OWNED_CHAT_READS_EVIDENCE " not in combined or "OWNED_CHAT_ACTIONS_EVIDENCE " not in combined or "OWNED_CHAT_TERMINALS_EVIDENCE " not in combined or combined.count("OWNED_CHAT_CLEANUP ") != 5:
            raise SystemExit("Dedicated runtime evidence missing")
    if stage.exists():
        raise SystemExit("Dedicated staging storage remains")
    print(f"Dedicated stage removed: {stage}", flush=True)


if __name__ == "__main__":
    main()
