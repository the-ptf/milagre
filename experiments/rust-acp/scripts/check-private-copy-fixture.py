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
import stat
import subprocess
import tempfile

CRATE = Path(__file__).resolve().parents[1]
REPO = CRATE.parents[1]
FEATURE = "macos-private-copy-fixture"
TESTS = [
    ("private_copy::core::tests::retained_unstamped_worker_expires_and_closes_control", "PRIVATE_COPY_UNSTAMPED_DEADLINE_EVIDENCE "),
    ("private_copy::tests::public_observer_progress_and_independent_cancel", "PRIVATE_COPY_PUBLIC_PROGRESS_EVIDENCE "),
    ("private_copy::core::tests::native_private_copy_end_to_end", "PRIVATE_COPY_LIFETIME_EVIDENCE "),
    ("private_copy::core::tests::coordinated_native_commit_progress_and_cancel", "PRIVATE_COPY_COORDINATED_EVIDENCE "),
    ("private_copy::core::tests::partial_preparation_retains_full_worker_slot", "PRIVATE_COPY_PARTIAL_PREPARATION_EVIDENCE "),
]
CONTEXT = CRATE / "fixtures/synthetic-host/Cargo.toml"


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(32768), b""):
            value.update(chunk)
    return value.hexdigest()


def build(arguments, manifest=None):
    result = subprocess.run(
        ["cargo", *arguments, "--offline", "--locked", "--manifest-path", str(manifest or CRATE / "Cargo.toml"),
         *([] if manifest else ["--features", FEATURE]), "--message-format=json"],
        cwd=REPO, capture_output=True, text=True, check=True,
    )
    return [json.loads(line) for line in result.stdout.splitlines()]


def retained_cleanup(stdout):
    records = [json.loads(line.split("PRIVATE_COPY_RETAINED_MANIFEST ", 1)[1]) for line in stdout.splitlines()
               if "PRIVATE_COPY_RETAINED_MANIFEST " in line]
    for record in records:
        root = Path(record["root"])
        if root.parent != Path("/tmp").resolve() or not root.name.startswith("milagre-acp-private-copy-"):
            raise SystemExit("Unexpected retained fixture root")
        directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            meta = os.fstat(directory)
            if (meta.st_dev, meta.st_ino, meta.st_uid, stat.S_IMODE(meta.st_mode)) != (record["device"], record["inode"], os.getuid(), 0o700):
                raise SystemExit("Retained fixture root identity changed")
            entries = record["entries"]
            expected = {"native-acp-copy-fixture", "held-original"}
            if {entry["name"] for entry in entries} != expected or set(os.listdir(directory)) != expected:
                raise SystemExit("Unexpected retained fixture entries")
            for entry in entries:
                meta = os.stat(entry["name"], dir_fd=directory, follow_symlinks=False)
                if (meta.st_dev, meta.st_ino, meta.st_mode) != (entry["device"], entry["inode"], entry["mode"]) or not stat.S_ISREG(meta.st_mode) or meta.st_uid != os.getuid():
                    raise SystemExit("Retained fixture entry identity changed")
            for entry in entries:
                os.unlink(entry["name"], dir_fd=directory)
            current = root.lstat()
            if (current.st_dev, current.st_ino) != (record["device"], record["inode"]):
                raise SystemExit("Retained fixture root moved")
            root.rmdir()
        finally:
            os.close(directory)
        print("PRIVATE_COPY_RETAINED_REMOVED_AFTER_TEST_EXIT " + str(root), flush=True)


def run_staged(runner, stage, environment, test, evidence):
    result = subprocess.run(
        [str(runner), "--ignored", "--exact", test, "--nocapture", "--test-threads=1"],
        cwd=stage, env=environment, capture_output=True, text=True, timeout=90,
    )
    print(result.stdout, end="", flush=True)
    print(result.stderr, end="", flush=True)
    # Only this fixed test emits the private identity manifest, and only its parent
    # removes the two known entries after the intentionally retaining process exits.
    retained_cleanup(result.stdout)
    if result.returncode:
        raise SystemExit(result.returncode)
    if evidence not in result.stdout:
        raise SystemExit("Native execution evidence missing")


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
        environment = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(stage / "ambient-home"),
                       "LANG": "C", "KIRO_CONFIG_DIR": "/synthetic-forbidden-profile", "AWS_ACCESS_KEY_ID": "synthetic-no-credentials"}
        for test, evidence in TESTS:
            run_staged(staged_runner, stage, environment, test, evidence)
        # A distinct package compiles the private source once, with no ACP dependency.
        context_artifacts = build(["test", "--test", "native_core_context", "--no-run"], CONTEXT)
        context = [Path(item["executable"]) for item in context_artifacts if item.get("reason") == "compiler-artifact"
                   and item.get("executable") and item["profile"]["test"]]
        if len(context) != 1:
            raise SystemExit("Expected one standalone native-core test runner")
        metadata = json.loads(subprocess.check_output(
            ["cargo", "metadata", "--offline", "--locked", "--format-version=1", "--manifest-path", str(CONTEXT)], text=True))
        if any(package["name"] == "milagre-acp" for package in metadata["packages"]):
            raise SystemExit("Standalone context must not compile a second ACP backend")
        staged_context = stage / "context-tests"
        shutil.copyfile(context[0], staged_context)
        staged_context.chmod(0o700)
        print("PRIVATE_COPY_CONTEXT_MANIFEST " + json.dumps({"runnerSha256": digest(staged_context), "acpDependency": False}), flush=True)
        run_staged(staged_context, stage, environment, "independent_runtime_progress_wait_and_cancel", "PRIVATE_COPY_STANDALONE_EVIDENCE ")
        if canary.read_bytes() != before:
            raise SystemExit("Synthetic ambient HOME canary changed")
    if stage.exists():
        raise SystemExit("Staging directory remains")
    print("PRIVATE_COPY_STAGE_REMOVED " + str(stage))


if __name__ == "__main__":
    main()
