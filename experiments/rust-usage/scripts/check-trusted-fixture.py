#!/usr/bin/env python3
"""Offline disposable dependency export. Never adopts a profile or fetches git/Cargo data."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile

REVISION = "33a183a66f2c99ed5c8f5b7f9ccf481afd4b6765"
ARCHIVE_SHA256 = "c91196b45273ceba99999a5efb1c1f6a4cba70226e2396cfa05d100165eaafcb"
TREES = {
    "rust-registry": "83b2330d8da076d720de410feb8443d33170f64d",
    "rust-accounts": "9aa49548bf3b832afa983415f4dc661b95bf6aec",
    "rust-owner": "56d987b52fdd099c99bcdbbfc14d442d3b2d816a",
}
USAGE = Path(__file__).resolve().parents[1]
REPO = USAGE.parents[1]


def output(*args):
    return subprocess.check_output(args, cwd=REPO)


def run(args, cwd):
    print(" ".join(map(str, args)), flush=True)
    result = subprocess.run(list(map(str, args)), cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if result.returncode:
        print(result.stdout, flush=True)
        raise SystemExit(result.returncode)
    for line in result.stdout.splitlines():
        if "test result:" in line or "Node command traces" in line:
            print(line, flush=True)


def main():
    for name, expected in TREES.items():
        actual = output("git", "rev-parse", f"{REVISION}:experiments/{name}").decode().strip()
        if actual != expected:
            raise SystemExit(f"{name} tree mismatch: {actual}")
    archive = output("git", "archive", "--format=tar", REVISION, *[f"experiments/{name}" for name in TREES])
    actual = hashlib.sha256(archive).hexdigest()
    if actual != ARCHIVE_SHA256:
        raise SystemExit(f"Dependency archive mismatch: {actual}")
    print(f"Dependency revision {REVISION}\nArchive SHA256 {actual}", flush=True)
    with tempfile.TemporaryDirectory(prefix="usage-adapter-check-", dir="/tmp") as directory:
        workspace = Path(directory)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            for member in tar.getmembers():
                path = PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts or not (member.isfile() or member.isdir()):
                    raise SystemExit(f"Unsafe archive member: {member.name}")
            tar.extractall(workspace)
        copy = workspace / "experiments/rust-usage"
        shutil.copytree(USAGE, copy, ignore=shutil.ignore_patterns("target", "__pycache__", ".DS_Store"))
        # The Node VM only reads these source files; it throws on filesystem/provider access.
        core = workspace / "packages/core/src"
        core.mkdir(parents=True)
        for name in ("runtime.cjs", "usage.cjs", "usage-cache.cjs"):
            shutil.copyfile(REPO / "packages/core/src" / name, core / name)
        fixture = copy / "fixtures/trusted-accounts/node-commands.json"
        expected = json.loads(fixture.read_text())
        run(["node", copy / "scripts/generate-account-traces.cjs", "--trusted-fixture"], workspace)
        if json.loads(fixture.read_text()) != expected:
            raise SystemExit("Node adapter traces changed")
        base = copy / "Cargo.toml"
        adapter = copy / "fixtures/trusted-accounts/Cargo.toml"
        target = workspace / "target"
        for manifest, features in ((base, []), (base, ["--features", "fixture-admission"]), (adapter, []), (adapter, ["--features", "fixture-adapter"])):
            run(["cargo", "test", "--offline", "--locked", "--manifest-path", manifest, "--target-dir", target, *features], workspace)
        for manifest in (base, adapter):
            run(["cargo", "clippy", "--offline", "--locked", "--manifest-path", manifest, "--target-dir", target, "--all-features", "--all-targets", "--", "-D", "warnings"], workspace)
            run(["cargo", "fmt", "--manifest-path", manifest, "--check"], workspace)
    print("Disposable export removed; all checks passed.", flush=True)


if __name__ == "__main__":
    main()
