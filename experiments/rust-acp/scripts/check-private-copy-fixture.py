#!/usr/bin/env python3
"""Build/stage only this crate's native fixed fake and its exact ignored backend test.

No executable, profile, cwd, environment or script override is accepted. Production
providers and Node are not consulted. This is B06-Mac cooperative path execution.
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
FEATURE = "macos-private-copy-fixture"
TEST = "private_copy::tests::native_private_copy_end_to_end"


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(32768), b""):
            value.update(chunk)
    return value.hexdigest()


def build(arguments):
    result = subprocess.run(
        ["cargo", *arguments, "--offline", "--locked", "--manifest-path", str(CRATE / "Cargo.toml"),
         "--features", FEATURE, "--message-format=json"],
        cwd=REPO, capture_output=True, text=True, check=True,
    )
    return [json.loads(line) for line in result.stdout.splitlines()]


def main():
    artifacts = build(["build", "--bin", "native-acp-copy-fixture"])
    binary = [Path(item["executable"]) for item in artifacts if item.get("reason") == "compiler-artifact"
              and item.get("executable") and item["target"]["name"] == "native-acp-copy-fixture"]
    runners = build(["test", "--lib", "--no-run"])
    runner = [Path(item["executable"]) for item in runners if item.get("reason") == "compiler-artifact"
              and item.get("executable") and item["profile"]["test"]]
    if len(binary) != 1 or len(runner) != 1:
        raise SystemExit("Expected exactly the fixed binary and library test runner")
    with tempfile.TemporaryDirectory(prefix="milagre-acp-copy-stage-", dir="/tmp") as path:
        stage = Path(path).resolve()
        stage.chmod(0o700)
        staged_binary, staged_runner = stage / "native-acp-copy-fixture", stage / "backend-tests"
        for source, destination in [(binary[0], staged_binary), (runner[0], staged_runner)]:
            metadata = source.lstat()
            if not source.is_file() or source.is_symlink() or metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
                raise SystemExit("Unsafe fixed build artifact")
            shutil.copyfile(source, destination)
            destination.chmod(0o700)
        (stage / "ambient-home").mkdir(mode=0o700)
        canary = stage / "ambient-home/canary"
        canary.write_bytes(b"The native child must use its own synthetic HOME.\n")
        before = canary.read_bytes()
        print("PRIVATE_COPY_STAGE_MANIFEST " + json.dumps({
            "checkoutHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip(),
            "sourceAttestation": False,
            "backend": "MacOsPrivateCopyFixture", "immutableDescriptorExecution": False,
            "binarySha256": digest(staged_binary), "runnerSha256": digest(staged_runner), "stage": str(stage),
        }), flush=True)
        result = subprocess.run(
            [str(staged_runner), "--ignored", "--exact", TEST, "--nocapture", "--test-threads=1"],
            cwd=stage,
            env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(stage / "ambient-home"),
                 "LANG": "C", "KIRO_CONFIG_DIR": "/synthetic-forbidden-profile", "AWS_ACCESS_KEY_ID": "synthetic-no-credentials"},
            capture_output=True, text=True, timeout=90,
        )
        print(result.stdout, end="", flush=True)
        print(result.stderr, end="", flush=True)
        if result.returncode:
            raise SystemExit(result.returncode)
        if canary.read_bytes() != before:
            raise SystemExit("Synthetic ambient HOME canary changed")
        if any(marker not in result.stdout for marker in ["PRIVATE_COPY_NATIVE_EVIDENCE ", "PRIVATE_COPY_LIFETIME_EVIDENCE "]):
            raise SystemExit("Native execution evidence missing")
    if stage.exists():
        raise SystemExit("Staging directory remains")
    print("PRIVATE_COPY_STAGE_REMOVED " + str(stage))


if __name__ == "__main__":
    main()
