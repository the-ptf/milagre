#!/usr/bin/env python3
"""Test this bridge with a pinned ContentOwner snapshot, without editing its worktree."""
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

crate = Path(__file__).resolve().parents[1]
repo = crate.parents[1]
revision = sys.argv[1] if len(sys.argv) > 1 else "afba0d21"
subprocess.run(["cargo", "build", "--manifest-path", str(crate / "Cargo.toml"), "--bin", "fake-claude"], check=True)
archive = subprocess.check_output(["git", "archive", revision, "experiments/rust-tools", "experiments/rust-content-store", "experiments/rust-owner"], cwd=repo)
with tempfile.TemporaryDirectory(prefix="claude-content-owner-") as scratch:
    root = Path(scratch).resolve()
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        for member in source.getmembers():
            if member.issym() or member.islnk() or not (root / member.name).resolve().is_relative_to(root):
                raise ValueError("Unsafe snapshot entry")
        source.extractall(root)
    copied = root / "experiments/rust-claude"
    shutil.copytree(crate, copied, ignore=shutil.ignore_patterns("target", ".git"))
    env = dict(os.environ, MILAGRE_FAKE_CLAUDE=str(crate / "target/debug/fake-claude"), CARGO_TARGET_DIR=str(crate / "integration/content-owner/target"))
    manifest = copied / "integration/content-owner/Cargo.toml"
    subprocess.run(["cargo", "test", "--manifest-path", str(manifest)], env=env, check=True)
    shutil.copyfile(manifest.with_name("Cargo.lock"), crate / "integration/content-owner/Cargo.lock")
