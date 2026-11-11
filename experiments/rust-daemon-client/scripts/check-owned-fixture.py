#!/usr/bin/env python3
"""Stage only the repository's built app-fixture and this crate's test runner.

No executable/profile/socket argument or environment override is supported. The
runtime owner must build app-fixture first; this script does not build it or fetch.
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
DAEMON = REPO / "experiments/rust-runtime/target/debug/app-fixture"
TEST = "launcher::tests::owned_fixture_end_to_end"


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def main():
    metadata = DAEMON.lstat()
    if not DAEMON.is_file() or DAEMON.is_symlink() or metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
        raise SystemExit("Build the owned fixed rust-runtime app-fixture first")
    built = subprocess.run(
        ["cargo", "test", "--offline", "--locked", "--manifest-path", str(CRATE / "Cargo.toml"), "--no-run", "--message-format=json"],
        cwd=REPO, capture_output=True, text=True, check=True,
    )
    runners = []
    for line in built.stdout.splitlines():
        frame = json.loads(line)
        if frame.get("reason") == "compiler-artifact" and frame.get("executable") and frame["target"]["name"] == "milagre_daemon_client" and frame["profile"]["test"]:
            runners.append(Path(frame["executable"]))
    if len(runners) != 1:
        raise SystemExit(f"Expected exactly one client library test runner, got {runners}")
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    with tempfile.TemporaryDirectory(prefix="milagre-daemon-client-stage-", dir="/tmp") as name:
        stage = Path(name).resolve()
        stage.chmod(0o700)
        binary = stage / "client-contract-tests"
        fixture = stage / "app-fixture"
        shutil.copyfile(runners[0], binary)
        shutil.copyfile(DAEMON, fixture)
        binary.chmod(0o700)
        fixture.chmod(0o700)
        for directory in [stage / "home", stage / "tmp"]:
            directory.mkdir(mode=0o700)
        canary = stage / "home/ambient-profile-canary"
        canary.write_text("Fixture launcher must use its own fresh HOME.\n")
        before = canary.read_bytes()
        manifest = {
            "checkoutHead": revision,
            "sourceAttestation": False,
            "sourceNote": "Hashes identify staged binaries; checkout HEAD does not attest their source revision",
            "stage": str(stage),
            "daemonSha256": digest(fixture),
            "runnerSha256": digest(binary),
            "sourceDaemon": str(DAEMON),
        }
        if manifest["daemonSha256"] != digest(DAEMON):
            raise SystemExit("app-fixture changed while staging")
        print("FIXTURE_STAGE_MANIFEST " + json.dumps(manifest), flush=True)
        result = subprocess.run(
            [str(binary), "--ignored", "--exact", TEST, "--nocapture", "--test-threads=1"],
            cwd=stage,
            env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(stage / "home"), "TMPDIR": str(stage / "tmp"), "LANG": "en_US.UTF-8"},
            capture_output=True, text=True, timeout=120,
        )
        print(result.stdout, end="", flush=True)
        if result.stderr:
            print(result.stderr, end="", flush=True)
        if canary.read_bytes() != before:
            raise SystemExit("Synthetic parent HOME canary changed")
        if result.returncode:
            raise SystemExit(result.returncode)
        if any(marker not in result.stdout for marker in ["OWNED_FIXTURE_EVIDENCE ", "OWNED_FIXTURE_DROP_EVIDENCE ", "OWNED_FIXTURE_CANCEL_EVIDENCE "]):
            raise SystemExit("Real fixture evidence missing")
    if stage.exists():
        raise SystemExit("Staging directory was not removed")
    print(f"Staged binaries removed: {stage}", flush=True)


if __name__ == "__main__":
    main()
