#!/usr/bin/env python3
"""Offline package-boundary checks. Never builds or launches an application."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("preview_package", Path(__file__).with_name("package-preview.py"))
PACKAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGE)


class PreviewPackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="milagre-preview-package-check-")
        self.root = Path(self.temporary.name).resolve()
        self.root.chmod(0o700)

    def tearDown(self):
        self.temporary.cleanup()

    def manifest(self):
        path = self.root / "rust-chat-runtime.json"
        value = {"schema": 1, "kind": "milagre-rust-chat", "fixture": False, "root": str(self.root), "launch": {"model": "synthetic"}}
        path.write_text(json.dumps(value))
        path.chmod(0o600)
        return path, value

    def test_private_manifest_roundtrips_without_rewriting(self):
        path, value = self.manifest()
        before = path.read_bytes()
        self.assertEqual(PACKAGE.saved_runtime_manifest(path), value)
        self.assertEqual(path.read_bytes(), before)

    def test_manifest_refuses_public_large_symlink_and_hardlink(self):
        path, _ = self.manifest()
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            PACKAGE.saved_runtime_manifest(path)
        path.chmod(0o600)
        path.write_bytes(b" " * (32 * 1024 + 1))
        with self.assertRaises(ValueError):
            PACKAGE.saved_runtime_manifest(path)
        path, _ = self.manifest()
        retained = self.root / "retained.json"
        path.rename(retained)
        path.symlink_to(retained)
        with self.assertRaises(ValueError):
            PACKAGE.saved_runtime_manifest(path)
        path.unlink()
        os.link(retained, path)
        with self.assertRaises(ValueError):
            PACKAGE.saved_runtime_manifest(path)

    def test_resource_copies_are_independent_and_symlinks_refuse(self):
        source = self.root / "source"
        source.write_bytes(b"packaged bytes")
        copied = self.root / "copied"
        PACKAGE.copy_file(source, copied, 0o600)
        self.assertEqual(source.read_bytes(), copied.read_bytes())
        self.assertNotEqual(source.stat().st_ino, copied.stat().st_ino)
        self.assertEqual(copied.stat().st_nlink, 1)
        linked = self.root / "linked"
        linked.symlink_to(source)
        with self.assertRaises(ValueError):
            PACKAGE.copy_file(linked, self.root / "forbidden", 0o600)

    def test_skills_copy_has_exact_bytes_and_refuses_external_links(self):
        repo = self.root / "repo"
        source = repo / "packages/core/src/bundled-skills/test"
        source.mkdir(parents=True)
        (source / "SKILL.md").write_bytes(b"explicit bundled skill\n")
        with mock.patch.object(PACKAGE, "REPO", repo):
            PACKAGE.copy_skills(self.root / "skills")
            self.assertEqual((self.root / "skills/test/SKILL.md").read_bytes(), b"explicit bundled skill\n")
            (source / "outside").symlink_to(self.root)
            with self.assertRaises(ValueError):
                PACKAGE.copy_skills(self.root / "refused-skills")

    def test_existing_preview_is_retained_before_any_build_or_process(self):
        self.manifest()
        home = self.root / "home"
        app = home / "Applications/Milagre Rust Preview.app"
        app.mkdir(parents=True)
        marker = app / "retained"
        marker.write_bytes(b"existing preview stays")
        with mock.patch.object(PACKAGE.Path, "home", return_value=home), mock.patch.object(PACKAGE.platform, "system", return_value="Darwin"), mock.patch("sys.argv", ["package-preview.py", "--data-root", str(self.root), "--install"]), mock.patch.object(PACKAGE.subprocess, "run") as process, contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as error:
                PACKAGE.main()
            self.assertEqual(error.exception.code, 2)
            process.assert_not_called()
        self.assertEqual(marker.read_bytes(), b"existing preview stays")


if __name__ == "__main__":
    unittest.main()
