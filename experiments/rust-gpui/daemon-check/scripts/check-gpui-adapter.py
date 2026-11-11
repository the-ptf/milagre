#!/usr/bin/env python3
"""Export the frozen daemon client, then run the GPUI adapter's real-fixture tests against the owned app-fixture.

    python3 scripts/check-gpui-adapter.py export --backend <backend worktree>
    python3 scripts/check-gpui-adapter.py run --backend <backend worktree> [--fixture <app-fixture>]

`export` writes `git archive <CLIENT_COMMIT> experiments/rust-daemon-client` of the backend worktree into the GPUI
crate's ignored target/ directory (the path daemon-check/Cargo.toml names) and checks every exported file against
the commit's blobs: the client is used exactly as committed, never edited.

`run` exports, checks the fixture's SHA-256 (default `<backend>/experiments/rust-runtime/target/debug/app-fixture`;
`--fixture` may only name a file with the same hash), builds this crate's library test runner offline and locked,
stages the runner beside a copy of that exact fixture in a private mode-0700 /tmp directory, runs the ignored
real-fixture tests there with a fixed environment, records both hashes and the HEADs, and removes the stage. It
never builds the fixture, never takes an executable, profile or socket override, and never touches ~/.milagre.
The full log goes to daemon-check/target/check-gpui-adapter.log.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

CRATE = Path(__file__).resolve().parents[1]
GPUI = CRATE.parent
CLIENT_COMMIT = "9aa5deb343946458e85f17d8bc959141343a8d28"
CLIENT_TREE = "2e265578e11a0b204ef58e13d9c4024b418b4f7d"
CLIENT_PATH = "experiments/rust-daemon-client"
EXPORT = GPUI / "target/daemon-client-9aa5deb3"
FIXTURE_SHA256 = "51e90342bf427d7160ff658f7e5c73e50ed7d9b4dad8148b80cc7688bc36a15d"
FIXTURE_IN_BACKEND = "experiments/rust-runtime/target/debug/app-fixture"
RUNNER = "milagre_gpui_daemon_check"
TESTS = "real::"
LOG = CRATE / "target/check-gpui-adapter.log"


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def git(backend, *args):
    return subprocess.check_output(["git", "-C", str(backend), *args], text=True).strip()


def export(backend):
    if git(backend, "rev-parse", f"{CLIENT_COMMIT}^{{commit}}") != CLIENT_COMMIT:
        raise SystemExit("Backend worktree does not have the client commit")
    if git(backend, "rev-parse", f"{CLIENT_COMMIT}:{CLIENT_PATH}") != CLIENT_TREE:
        raise SystemExit("Client tree at the pinned commit is not the agreed one")
    if EXPORT.exists():
        shutil.rmtree(EXPORT)
    EXPORT.mkdir(parents=True)
    archive = subprocess.run(["git", "-C", str(backend), "archive", CLIENT_COMMIT, CLIENT_PATH], capture_output=True, check=True)
    subprocess.run(["tar", "-x", "-C", str(EXPORT)], input=archive.stdout, check=True)
    blobs = {}
    for line in git(backend, "ls-tree", "-r", CLIENT_COMMIT, CLIENT_PATH).splitlines():
        meta, name = line.split("\t", 1)
        blobs[name] = meta.split()[2]
    exported = {str(p.relative_to(EXPORT)) for p in EXPORT.rglob("*") if p.is_file()}
    if exported != set(blobs):
        raise SystemExit("Exported file set differs from the commit")
    for name, blob in blobs.items():
        if subprocess.check_output(["git", "hash-object", str(EXPORT / name)], text=True).strip() != blob:
            raise SystemExit(f"Exported {name} differs from the commit")
    return {"clientCommit": CLIENT_COMMIT, "clientTree": CLIENT_TREE, "files": len(blobs)}


def run(backend, fixture):
    exported = export(backend)
    fixture = Path(fixture) if fixture else backend / FIXTURE_IN_BACKEND
    metadata = fixture.lstat()
    if not fixture.is_file() or fixture.is_symlink() or metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
        raise SystemExit("The fixture must be the backend's own built app-fixture (regular, owned, not group/other writable)")
    fixture_hash = digest(fixture)
    if fixture_hash != FIXTURE_SHA256:
        raise SystemExit(f"app-fixture SHA-256 {fixture_hash} is not the agreed {FIXTURE_SHA256}")
    built = subprocess.run(
        ["cargo", "test", "--offline", "--locked", "--manifest-path", str(CRATE / "Cargo.toml"), "--lib", "--no-run", "--message-format=json"],
        cwd=CRATE, capture_output=True, text=True, check=True,
    )
    runners = []
    for line in built.stdout.splitlines():
        frame = json.loads(line)
        if frame.get("reason") == "compiler-artifact" and frame.get("executable") and frame["target"]["name"] == RUNNER and frame["profile"]["test"]:
            runners.append(Path(frame["executable"]))
    if len(runners) != 1:
        raise SystemExit(f"Expected exactly one adapter test runner, got {runners}")
    heads = {
        "gpuiHead": subprocess.check_output(["git", "-C", str(GPUI), "rev-parse", "HEAD"], text=True).strip(),
        "backendHead": git(backend, "rev-parse", "HEAD"),
    }
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="milagre-gpui-adapter-stage-", dir="/tmp") as name:
        stage = Path(name).resolve()
        stage.chmod(0o700)
        binary = stage / "gpui-adapter-tests"
        staged_fixture = stage / "app-fixture"
        shutil.copyfile(runners[0], binary)
        shutil.copyfile(fixture, staged_fixture)
        binary.chmod(0o700)
        staged_fixture.chmod(0o700)
        for directory in [stage / "home", stage / "tmp"]:
            directory.mkdir(mode=0o700)
        manifest = {
            **heads,
            **exported,
            "sourceAttestation": False,
            "sourceNote": "Hashes identify staged binaries; HEADs do not attest the fixture's source revision",
            "stage": str(stage),
            "daemonSha256": digest(staged_fixture),
            "runnerSha256": digest(binary),
        }
        if manifest["daemonSha256"] != FIXTURE_SHA256 or digest(fixture) != FIXTURE_SHA256:
            raise SystemExit("app-fixture changed while staging")
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(stage / "home"), "TMPDIR": str(stage / "tmp"), "LANG": "en_US.UTF-8"}
        listed = subprocess.run([str(binary), "--ignored", "--list", TESTS], cwd=stage, env=env, capture_output=True, text=True, check=True)
        tests = re.findall(r"^(real::\S+): test$", listed.stdout, re.MULTILINE)
        if not tests:
            raise SystemExit("No real-fixture tests listed")
        # One process per test: each launches and stops its own fixture child.
        outcomes, output = {}, []
        for test in tests:
            result = subprocess.run(
                [str(binary), "--ignored", "--exact", test, "--nocapture", "--test-threads=1"],
                cwd=stage, env=env, capture_output=True, text=True, timeout=300,
            )
            outcomes[test] = "pass" if result.returncode == 0 and "1 passed" in result.stdout else f"FAIL (exit {result.returncode})"
            output.append(f"===== {test}: {outcomes[test]}\n{result.stdout}{result.stderr}")
        residue = sorted(p.name for p in stage.iterdir() if p.name not in {"gpui-adapter-tests", "app-fixture", "home", "tmp"})
        home_residue = sorted(str(p.relative_to(stage)) for p in (stage / "home").rglob("*"))
    if stage.exists():
        raise SystemExit("Staging directory was not removed")
    summary = {"manifest": manifest, "tests": outcomes, "stageResidue": residue, "stageHomeResidue": home_residue, "stageRemoved": True}
    LOG.write_text("GPUI_ADAPTER_MANIFEST " + json.dumps(summary) + "\n" + "".join(output))
    print(json.dumps(summary, indent=2))
    print(f"Log: {LOG}")
    if any(v != "pass" for v in outcomes.values()):
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["export", "run"])
    parser.add_argument("--backend", required=True, type=Path, help="the backend worktree holding the client commit and app-fixture")
    parser.add_argument("--fixture", help="the app-fixture to stage; must hash to the agreed SHA-256")
    args = parser.parse_args()
    backend = args.backend.resolve()
    if args.command == "export":
        print(json.dumps(export(backend)))
    else:
        run(backend, args.fixture)


if __name__ == "__main__":
    sys.exit(main())
