#!/usr/bin/env python3
"""Stage 1 and 2 of the GPUI live wiring, checked against the backend's dedicated Chat runtime.

    python3 scripts/check-gpui-live.py export --backend <backend worktree>
    python3 scripts/check-gpui-live.py stage-runtime --runtime <chat-runtime>
    python3 scripts/check-gpui-live.py run --backend <backend worktree>

`export` writes `git archive <CLIENT_COMMIT> experiments/rust-daemon-client` into the GPUI crate's ignored
target/daemon-client-f946e184/ (the path live/Cargo.toml names) and the backend's fixed Claude stand-in
(`experiments/rust-claude/src/bin/fake_claude.rs` at the same commit) into daemon-check/target/fake-claude-f946e184/,
checking every exported file against the commit's blobs. The app-fixture adapter keeps its own client at 9aa5deb3
(scripts/check-gpui-adapter.py); nothing here touches that export or its pins.

`stage-runtime` copies the agreed `chat-runtime` (SHA-256 RUNTIME_SHA256, built by the backend with uncommitted content
work: no clean-source attestation) into daemon-check/target/owned-runtime-c4a6c25a/, so a vanished temp folder does
not lose it. `run` uses only that copy and checks its hash again.

`run` exports, builds the fake Claude (offline) and the live crate's library test runner (offline, locked), stages
the runner beside a copy of the runtime and the fake in a private mode-0700 directory under daemon-check/target/, and
runs every ignored `owned::` test there, one process each, with a fixed environment whose HOME is the stage's own
(the client refuses any root under $HOME/.milagre, and this worktree is one). Each test creates its dedicated root
inside the stage through the public `OwnedChatGuard::create` with a launch manifest whose program is the fake
Claude: no account, no network, no production profile. The stage, its roots included, is removed afterwards; the
log is daemon-check/target/check-gpui-live.log. Set CARGO_TARGET_DIR to choose the build cache.
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
LIVE = GPUI / "live"
CLIENT_COMMIT = "f946e1848e46e89b9013157e1960deac1ab9b363"
CLIENT_TREE = "cf8a21e5b66fa08bca723a7ae1a9685c8c597b8e"
CLIENT_PATH = "experiments/rust-daemon-client"
EXPORT = GPUI / "target/daemon-client-f946e184"
FAKE_PATH = "experiments/rust-claude/src/bin/fake_claude.rs"
FAKE_BLOB = "7508b11e3e7245fcadd4d596f995f2f4289d800f"
FAKE_CRATE = CRATE / "target/fake-claude-f946e184"
# The agreed dedicated runtimes, newest first: 30bdfd09 (backend's signed runtime for client f946e184: typed Git
# reads and local PR diffs), 6054d7d6 (backend's signed runtime for client 1b180e46: Chat metadata
# patch for rename, Done and Reopen), 862f4cd2 (backend's signed "Milagre Rust Preview" runtime for client
# 3410109b: owner-death exit, CHAT_ROOT_BUSY, bootstrap project_id/agent_name), 846ee97a (backend 4c5f541a, adds PTY and Git on the runtime side; no
# client facade for them) and c4a6c25a (content and late cleanup). `--sha256` picks another agreed one.
AGREED = {
    "30bdfd09631b4a223b6f560a690fa71034714cee684a4d5b6201f00c77f2e389": "backend signed runtime for client f946e184",
    "6054d7d6759262ec4d463380589261d954e1f8be79e75bb5d1a5d0be2142d70a": "backend signed runtime for client 1b180e46",
    "862f4cd2f7a7d243da524852320554e09fd8d11835523a3a6a4fdfa956d70502": "backend signed runtime for client 3410109b",
    "846ee97abc1d8ab38d2ea53c3e510fba726c305e1b58f7256fe07cd9805113f2": "backend 4c5f541a combined runtime",
    "c4a6c25ac01c44312b33b1db7963d16f99ddba0f3e9feba907fa5b60ceda2ea5": "content + late cleanup checkpoint",
}
RUNTIME_SHA256 = next(iter(AGREED))


def runtime_path(sha):
    return CRATE / f"target/owned-runtime-{sha[:8]}/chat-runtime"


RUNTIME = runtime_path(RUNTIME_SHA256)
RUNNER = "milagre_gpui_live"
TESTS = "tests::owned::"
LOG = CRATE / "target/check-gpui-live.log"
FAKE_MANIFEST = """[package]
name = "runtime-fake-claude"
version = "0.0.0"
edition = "2021"
publish = false

# Exported unchanged from the backend at the client commit; only this manifest is ours.
[workspace]

[[bin]]
name = "runtime-fake-claude"
path = "src/fake_claude.rs"

[dependencies]
serde_json = { version = "1", features = ["preserve_order", "raw_value"] }
libc = "0.2"
"""


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
    if git(backend, "rev-parse", f"{CLIENT_COMMIT}:{FAKE_PATH}") != FAKE_BLOB:
        raise SystemExit("fake_claude.rs at the pinned commit is not the agreed one")
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
    (FAKE_CRATE / "src").mkdir(parents=True, exist_ok=True)
    fake = FAKE_CRATE / "src/fake_claude.rs"
    fake.write_bytes(subprocess.run(["git", "-C", str(backend), "show", f"{CLIENT_COMMIT}:{FAKE_PATH}"], capture_output=True, check=True).stdout)
    if subprocess.check_output(["git", "hash-object", str(fake)], text=True).strip() != FAKE_BLOB:
        raise SystemExit("Exported fake_claude.rs differs from the commit")
    (FAKE_CRATE / "Cargo.toml").write_text(FAKE_MANIFEST)
    return {"clientCommit": CLIENT_COMMIT, "clientTree": CLIENT_TREE, "files": len(blobs), "fakeClaudeBlob": FAKE_BLOB}


def stage_runtime(source):
    source = Path(source)
    if digest(source) != RUNTIME_SHA256:
        raise SystemExit(f"{source} is not the agreed runtime {RUNTIME_SHA256}")
    RUNTIME.parent.mkdir(parents=True, exist_ok=True)
    RUNTIME.parent.chmod(0o700)
    if source.resolve() != RUNTIME.resolve():
        shutil.copyfile(source, RUNTIME)
    RUNTIME.chmod(0o700)
    if digest(RUNTIME) != RUNTIME_SHA256:
        raise SystemExit("The staged runtime copy differs")
    print(json.dumps({"runtime": str(RUNTIME), "sha256": RUNTIME_SHA256}))


def cargo_artifact(command, name):
    built = subprocess.run(command, capture_output=True, text=True)
    if built.returncode:
        sys.stderr.write(built.stderr[-8000:])
        raise SystemExit(f"Build failed: {' '.join(command)}")
    found = []
    for line in built.stdout.splitlines():
        frame = json.loads(line)
        if frame.get("reason") == "compiler-artifact" and frame.get("executable") and frame["target"]["name"] == name:
            found.append(Path(frame["executable"]))
    if len(found) != 1:
        raise SystemExit(f"Expected one {name} executable, got {found}")
    return found[0]


def run(backend):
    exported = export(backend)
    if not RUNTIME.is_file() or digest(RUNTIME) != RUNTIME_SHA256:
        raise SystemExit(f"Stage the agreed runtime first: scripts/check-gpui-live.py stage-runtime --runtime <chat-runtime>")
    fake = cargo_artifact(
        ["cargo", "build", "--offline", "--manifest-path", str(FAKE_CRATE / "Cargo.toml"), "--message-format=json"],
        "runtime-fake-claude",
    )
    runner = cargo_artifact(
        ["cargo", "test", "--offline", "--locked", "--manifest-path", str(LIVE / "Cargo.toml"), "--lib", "--no-run", "--message-format=json"],
        RUNNER,
    )
    heads = {
        "gpuiHead": subprocess.check_output(["git", "-C", str(GPUI), "rev-parse", "HEAD"], text=True).strip(),
        "backendHead": git(backend, "rev-parse", "HEAD"),
    }
    LOG.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix="gpui-live-stage-", dir=CRATE / "target")).resolve()
    try:
        stage.chmod(0o700)
        staged = {"gpui-live-tests": runner, "chat-runtime": RUNTIME, "runtime-fake-claude": fake}
        for name, source in staged.items():
            shutil.copyfile(source, stage / name)
            (stage / name).chmod(0o700)
        for directory in ["home", "tmp"]:
            (stage / directory).mkdir(mode=0o700)
        manifest = {
            **heads,
            **exported,
            "sourceAttestation": False,
            "sourceNote": "The runtime carries uncommitted backend content work; hashes identify staged binaries only",
            "stage": str(stage),
            "sha256": {name: digest(stage / name) for name in staged},
        }
        if manifest["sha256"]["chat-runtime"] != RUNTIME_SHA256:
            raise SystemExit("Runtime changed while staging")
        env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(stage / "home"), "TMPDIR": str(stage / "tmp"), "LANG": "en_US.UTF-8"}
        binary = stage / "gpui-live-tests"
        listed = subprocess.run([str(binary), "--ignored", "--list", TESTS], cwd=stage, env=env, capture_output=True, text=True, check=True)
        tests = re.findall(r"^(tests::owned::\S+): test$", listed.stdout, re.MULTILINE)
        if not tests:
            raise SystemExit("No owned-runtime tests listed")
        outcomes, output = {}, []
        for test in tests:
            result = subprocess.run(
                [str(binary), "--ignored", "--exact", test, "--nocapture", "--test-threads=1"],
                cwd=stage, env=env, capture_output=True, text=True, timeout=600,
            )
            outcomes[test] = "pass" if result.returncode == 0 and "1 passed" in result.stdout else f"FAIL (exit {result.returncode})"
            output.append(f"===== {test}: {outcomes[test]}\n{result.stdout}{result.stderr}")
        # A runtime whose client died mid-test may still be draining: give it time, never a signal.
        for _ in range(100):
            alive = subprocess.run(["pgrep", "-f", str(stage)], capture_output=True, text=True).stdout.split()
            if not alive:
                break
            import time
            time.sleep(0.2)
        roots = sorted(str(p.relative_to(stage)) for p in stage.glob("case-*/root"))
        LOG.write_text("GPUI_LIVE_MANIFEST " + json.dumps({"manifest": manifest, "tests": outcomes, "processesLeft": alive}) + "\n" + "".join(output))
    finally:
        # Only processes started from this stage could hold it; none may be left before it goes.
        if not subprocess.run(["pgrep", "-f", str(stage)], capture_output=True).stdout:
            shutil.rmtree(stage)
    if stage.exists():
        raise SystemExit(f"Stage {stage} kept: a process started from it is still running")
    summary = {"manifest": manifest, "tests": outcomes, "processesLeft": alive, "dedicatedRoots": roots, "stageRemoved": True}
    LOG.write_text("GPUI_LIVE_MANIFEST " + json.dumps(summary) + "\n" + "".join(output))
    print(json.dumps(summary, indent=2))
    print(f"Log: {LOG}")
    if alive or any(v != "pass" for v in outcomes.values()):
        raise SystemExit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["export", "stage-runtime", "run"])
    parser.add_argument("--backend", type=Path, help="the backend worktree holding the client commit")
    parser.add_argument("--sha256", help="which agreed runtime (default: the newest)")
    parser.add_argument("--runtime", type=Path, help="stage-runtime: the chat-runtime to copy; must hash to the agreed SHA-256")
    args = parser.parse_args()
    if args.sha256:
        if args.sha256 not in AGREED:
            raise SystemExit("--sha256 must be one of the agreed runtimes")
        global RUNTIME_SHA256, RUNTIME
        RUNTIME_SHA256, RUNTIME = args.sha256, runtime_path(args.sha256)
    if args.command == "stage-runtime":
        if not args.runtime:
            raise SystemExit("--runtime is required")
        stage_runtime(args.runtime)
        return
    if not args.backend:
        raise SystemExit("--backend is required")
    backend = args.backend.resolve()
    if args.command == "export":
        print(json.dumps(export(backend)))
    else:
        run(backend)


if __name__ == "__main__":
    sys.exit(main())
