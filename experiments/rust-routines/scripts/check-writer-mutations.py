#!/usr/bin/env python3
"""Compile native writer mutants and kill them with retained-parent process tests.

This gate changes only its fresh temporary crate/target. It never deletes a native
copy found by pathname: each test owns and destroys its exact captured descriptors.
A compiler failure, subprocess timeout or stranded copy is a failed gate, not a kill.
"""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

CRATE = pathlib.Path(__file__).resolve().parent.parent
TEST = "store::copied::crash::"
CRASH = TEST + "killed_publication_barriers_reopen_only_the_retained_canonical_inode"
FAULT = TEST + "native_fault_child_withholds_results_and_retains_uncertain_locks_after_drop"
REPLACE = TEST + "child_close_preserves_replacement_stage_inode"


def replace_once(path, before, after):
    source = path.read_text()
    assert source.count(before) == 1, f"Mutation seam drift: {path.name}: {before}"
    path.write_text(source.replace(before, after, 1))


def copies():
    root = pathlib.Path("/tmp").resolve()
    result = set()
    for path in root.glob("milagre-routine-copy-*"):
        st = path.lstat()
        result.add((str(path), st.st_dev, st.st_ino))
    return result


def build(work, environment):
    built = subprocess.run(["cargo", "test", "--offline", "--locked", "--manifest-path",
                            str(work / "Cargo.toml"), "--lib", "--no-run", "--message-format=json"],
                           capture_output=True, timeout=180, env=environment)
    diagnostics = [json.loads(line).get("message", {}).get("rendered", "") for line in built.stdout.splitlines()]
    assert built.returncode == 0, "compile failure is not a kill: " + "".join(diagnostics)[-6000:] + built.stderr[-1000:].decode(errors="replace")
    executables = [event["executable"] for line in built.stdout.splitlines()
                   if (event := json.loads(line)).get("reason") == "compiler-artifact"
                   and event.get("profile", {}).get("test") and event.get("executable")]
    assert len(executables) == 1, executables
    return executables[0]


def run(executable, test, expect_pass):
    before = copies()
    try:
        result = subprocess.run([executable, "--exact", test, "--nocapture"], capture_output=True, timeout=30)
    finally:
        # A timeout still fails the gate, but must not bypass stranded-copy evidence.
        # Inventory is read-only; discovered paths never become cleanup authority.
        after = copies()
        assert after == before, f"Native test stranded/changed copy inventory; no pathname sweep allowed: {after - before}"
    text = (result.stdout + result.stderr).decode(errors="replace")
    assert "running 1 test" in text, text[-5000:]
    if expect_pass:
        assert result.returncode == 0 and "1 passed; 0 failed" in text, text[-5000:]
    else:
        assert result.returncode == 101 and "0 passed; 1 failed" in text, text[-5000:]
        assert "retained entire crash fixture owner" not in text, text[-5000:]
    return result


def main():
    mutants = [
        ("claims-before-native-publication", CRASH, "writer.rs",
         "        let result = caught(|| {\n            self.persist(data, fault)?;",
         "        if matches!(fault, Fault::Crash) { let _ = self.model.install(stamp)?; }\n        let result = caught(|| {\n            self.persist(data, fault)?;"),
        ("post-rename-error-retryable", FAULT, "writer.rs",
         "if self.pending.as_ref().is_some_and(|p| p.renamed) || matches!(error, Error::Ownership)\n            {\n                self.uncertain = true;\n                return Err(Error::Uncertain);",
         "if self.pending.as_ref().is_some_and(|p| p.renamed) || matches!(error, Error::Ownership)\n            {\n                self.uncertain = true;\n                return Err(Error::Io);"),
        ("advance-model-on-refusal", FAULT, "writer.rs",
         "            self.model.discard(stamp)?;", "            let _ = self.model.install(stamp)?;"),
        ("release-uncertain-locks", FAULT, "writer.rs",
         "                .and_then(|_| data.verify())\n                .is_err()\n            {\n                self.uncertain = true;",
         "                .and_then(|_| data.verify())\n                .is_err()\n            {\n                self.locks = None;\n                self.uncertain = true;"),
        ("delete-replacement-stage", REPLACE, "io.rs",
         "    pin_at(dir, part, file, false)?;\n    let part = name(part)?;",
         "    let _ = file;\n    let part = name(part)?;"),
        ("adopt-crash-stage", CRASH, "writer.rs",
         "            let model = Model::open(body, now)?;",
         '''            let body = if let Some(name) = io::entries(data.dir()?)?.into_iter().find(|name| name.starts_with(".routines-")) {
                let file = io::open_at(data.dir()?, &name, libc::O_RDONLY, 0)?;
                Some(String::from_utf8(io::bytes(&file, LIMIT)?).map_err(|_| Error::Ownership)?)
            } else { body };
            let model = Model::open(body, now)?;'''),
    ]
    with tempfile.TemporaryDirectory(prefix="milagre-routine-writer-mutants-") as temporary:
        base = pathlib.Path(temporary)
        work, target = base / "crate", base / "target"
        # Unit-test compile-time drift checks embed these reviewed source inputs.
        # Copy exact bytes, never compile them or rewrite their accepted hashes.
        for source in ["rust-owner/src/jsjson.rs", "rust-owner/src/isolation.rs",
                       "rust-accounts/src/store.rs", "rust-accounts/src/service.rs",
                       "rust-accounts/src/recovery_tests.rs", "rust-registry/src/writer/storage.rs",
                       "rust-registry/src/writer/mod.rs"]:
            destination = base / source
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(CRATE.parent / source, destination)
        environment = {**os.environ, "CARGO_TARGET_DIR": str(target), "CARGO_INCREMENTAL": "0"}
        shutil.copytree(CRATE, work, ignore=shutil.ignore_patterns("target", "__pycache__"))
        executable = build(work, environment)
        for test in [CRASH, FAULT, REPLACE]:
            run(executable, test, True)
        print(json.dumps({"unmutatedNativeControls": 3, "passed": True}), flush=True)
        for label, test, filename, before, after in mutants:
            shutil.rmtree(work)
            shutil.copytree(CRATE, work, ignore=shutil.ignore_patterns("target", "__pycache__"))
            replace_once(work / "src/store/copied" / filename, before, after)
            executable = build(work, environment)
            result = run(executable, test, False)
            print(json.dumps({"mutant": label, "compiled": True, "killed": True,
                              "test": test, "exitCode": result.returncode,
                              "nativeCopiesCleanedByExactOwners": True}), flush=True)
    print(json.dumps({"compiledNativeMutantsKilled": len(mutants), "sourceUntouched": True,
                      "temporaryCrateAndTargetRemoved": not base.exists()}), flush=True)


if __name__ == "__main__":
    main()
