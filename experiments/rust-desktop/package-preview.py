#!/usr/bin/env python3
"""Build/stage the separate normal Rust Preview. Never launches an app or provider."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import stat
import subprocess
import tempfile


SOURCE = Path(__file__).resolve().parent
REPO = SOURCE.parent.parent
NAME = "Milagre Rust Preview.app"


def private_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700 or path.resolve() != path:
        raise ValueError("Expected an owned canonical 0700 directory: " + str(path))


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def saved_runtime_manifest(path):
    def identity(info):
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 32 * 1024:
            raise ValueError("Dedicated saved manifest must be an owned single-link 0600 regular file, at most 32 KiB")
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    expected = identity(path.lstat())
    descriptor = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(descriptor, "rb") as stream:
        if identity(os.fstat(stream.fileno())) != expected:
            raise ValueError("Dedicated saved manifest changed while opening")
        content = stream.read(32 * 1024 + 1)
        if len(content) > 32 * 1024 or identity(os.fstat(stream.fileno())) != expected or identity(path.lstat()) != expected:
            raise ValueError("Dedicated saved manifest changed while reading")
    return json.loads(content)


def copy_file(source, destination, mode):
    info = source.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("Only regular source files may enter the preview: " + str(source))
    shutil.copyfile(str(source), str(destination))
    destination.chmod(mode)
    if destination.stat().st_nlink != 1:
        raise ValueError("Preview copies must have one hard link")


def copy_skills(destination):
    source = REPO / "packages/core/src/bundled-skills"
    destination.mkdir(mode=0o700)
    for parent, directories, files in os.walk(str(source), followlinks=False):
        current = Path(parent)
        relative = current.relative_to(source)
        if current.is_symlink():
            raise ValueError("Bundled skills cannot contain symbolic links")
        for name in directories:
            child = current / name
            if child.is_symlink():
                raise ValueError("Bundled skills cannot contain symbolic links")
            (destination / relative / name).mkdir(mode=0o700)
        for name in files:
            copy_file(current / name, destination / relative / name, 0o600)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", required=True, type=Path, help="Existing marked dedicated runtime root; never created or rewritten here")
    parser.add_argument("--node-modules", type=Path, help="Explicit build dependencies when this Worktree has no node_modules")
    parser.add_argument("--release", action="store_true", help="Build optimized normal binaries; default is a development preview")
    parser.add_argument("--install", action="store_true", help="Install only if ~/Applications/Milagre Rust Preview.app does not exist; never replace")
    options = parser.parse_args()
    if platform.system() != "Darwin":
        parser.error("The native preview package currently supports macOS only")
    root = options.data_root
    if not root.is_absolute() or ".." in root.parts or "." in root.parts:
        parser.error("data-root must be an explicit absolute normalized path")
    private_directory(root)
    manifest = root / "rust-chat-runtime.json"
    saved = saved_runtime_manifest(manifest)
    if not isinstance(saved, dict) or set(saved) != {"schema", "kind", "root", "fixture", "launch"} or saved.get("kind") != "milagre-rust-chat" or saved.get("schema") != 1 or saved.get("fixture") is not False or saved.get("root") != str(root):
        parser.error("data-root must name an existing normal dedicated Chat runtime, not a fixture")
    destination = Path.home() / "Applications" / NAME
    if options.install and os.path.lexists(str(destination)):
        parser.error("Existing preview retained. Replacement requires root's separate approval after passing checks.")

    stage = Path(tempfile.mkdtemp(prefix="milagre-rust-preview-package-", dir=str(Path("/tmp").resolve())))
    stage.chmod(0o700)
    app = stage / NAME
    macos = app / "Contents/MacOS"
    resources = app / "Contents/Resources"
    for directory in (app, app / "Contents", macos, resources):
        directory.mkdir(mode=0o700)
    report = {"kind": "normal-rust-preview-package", "stage": str(stage), "installed": False, "architecture": platform.machine(), "profile": "release" if options.release else "debug", "commands": [], "passed": False}
    linked = False
    node_modules = REPO / "node_modules"
    try:
        if not os.path.lexists(str(node_modules)) and options.node_modules:
            dependency_path = options.node_modules.resolve(strict=True)
            if not dependency_path.is_dir():
                parser.error("node-modules must name the explicit build dependency directory")
            os.symlink(str(dependency_path), str(node_modules))
            linked = True

        def run(command):
            report["commands"].append([str(part) for part in command])
            with (stage / "build.log").open("ab") as log:
                subprocess.run([str(part) for part in command], cwd=str(REPO), stdout=log, stderr=subprocess.STDOUT, check=True)

        run(["node", SOURCE / "build-renderer.mjs"])
        shell_target = SOURCE / "target/preview-package"
        runtime_source = REPO / "experiments/rust-runtime"
        runtime_target = runtime_source / "target/preview-package"
        for crate, target, feature, binary in [
            (SOURCE, shell_target, "chat-desktop", "milagre-rust-chat"),
            (runtime_source, runtime_target, "chat-runtime", "chat-runtime"),
        ]:
            command = ["cargo", "build", "--manifest-path", crate / "Cargo.toml", "--locked", "--offline", "--no-default-features", "--features", feature, "--bin", binary, "--target-dir", target]
            if options.release:
                command.append("--release")
            run(command)
            copy_file(target / report["profile"] / binary, macos / binary, 0o700)
        copy_file(SOURCE / "icon.icns", resources / "icon.icns", 0o600)
        copy_skills(resources / "bundled-skills")
        config = {"schema": 1, "kind": "milagre-rust-preview", "dataRoot": str(root)}
        (resources / "preview-launch.json").write_text(json.dumps(config, indent=2) + "\n")
        (resources / "preview-launch.json").chmod(0o600)
        plist = {"CFBundleExecutable": "milagre-rust-chat", "CFBundleIdentifier": "com.milagre.rust-preview", "CFBundleName": "Milagre Rust Preview", "CFBundleDisplayName": "Milagre Rust Preview", "CFBundlePackageType": "APPL", "CFBundleVersion": "1", "CFBundleShortVersionString": "0.1.0", "CFBundleIconFile": "icon.icns", "NSHighResolutionCapable": True}
        with (app / "Contents/Info.plist").open("wb") as stream:
            plistlib.dump(plist, stream)
        (app / "Contents/Info.plist").chmod(0o600)
        report["gitHead"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=str(REPO), text=True).strip()
        report["sourceDirty"] = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=str(REPO)))
        report["features"] = {"shell": ["chat-desktop"], "runtime": ["chat-runtime"]}
        report["skillsDirectoryInSavedManifest"] = saved.get("launch", {}).get("skillsDirectory")
        report["bundledSkillsAtInstall"] = str(destination / "Contents/Resources/bundled-skills")
        run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", app])
        run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app])
        report["binaries"] = [{"name": name, "sha256": digest(macos / name), "architecture": subprocess.check_output(["/usr/bin/lipo", "-archs", str(macos / name)], text=True).strip()} for name in ("milagre-rust-chat", "chat-runtime")]
        report["passed"] = True
        if options.install:
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            if os.path.lexists(str(destination)):
                raise ValueError("Existing preview retained; installation target appeared during build")
            # rename refuses to replace a nonempty application directory. No old
            # app is removed, and persistent data is never an install target.
            os.rename(str(app), str(destination))
            report["installed"] = True
            report["app"] = str(destination)
            run(["/usr/bin/codesign", "--verify", "--deep", "--strict", destination])
        else:
            report["app"] = str(app)
    except BaseException as error:
        report["error"] = str(error)
        report["passed"] = False
        raise
    finally:
        if linked and node_modules.is_symlink() and os.readlink(str(node_modules)) == str(options.node_modules.resolve()):
            node_modules.unlink()
        report_path = stage / "package-report.json"
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        report_path.chmod(0o600)
        print(json.dumps({"passed": report["passed"], "installed": report["installed"], "app": report.get("app"), "report": str(report_path)}))


if __name__ == "__main__":
    main()
