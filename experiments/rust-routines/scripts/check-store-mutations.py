#!/usr/bin/env python3
"""Require compiled store mutants to diverge from the actual Node oracle.

Only this script's fresh temporary crate/target are changed and removed. Compiler
failures are errors, never successful mutation kills. The source worktree stays intact.
"""
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

SCRIPTS = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("store_parity", SCRIPTS / "check-store-parity.py")
PARITY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PARITY)
CRATE = PARITY.CRATE


def replace_once(path, before, after):
    source = path.read_text()
    assert source.count(before) == 1, f"Mutation seam drift: {path.name}: {before}"
    path.write_text(source.replace(before, after, 1))


def main():
    traces = PARITY.corpus()
    mutants = [
        ("inclusive-lateness", "due-boundaries-no-backlog", "transitions.rs",
         "let late = scheduled < at - 60_000;", "let late = scheduled <= at - 60_000;"),
        ("backlog-next-slot", "due-boundaries-no-backlog", "transitions.rs",
         "next_or_pause(state, i, at)?", "next_or_pause(state, i, integer(&rows(state)[i][\"nextRunAt\"]).unwrap())?"),
        ("duplicate-finish", "completion-and-status-boundaries", "transitions.rs",
         'if state["runs"][&rid][n]["status"] != "running" {\n                    return Ok(Value::Null);\n                }',
         'if false {\n                    return Ok(Value::Null);\n                }'),
        ("restart-streak-per-run", "restart-multiple-runs-and-failure-streak", "transitions.rs",
         "cut == 0,", "true,"),
        ("publication-before-failure", "rollback-rename", "mod.rs", None, None),
        ("prune-running", "old-running-survives-retention", "transitions.rs",
         'if run["status"] == "running" {\n            return true;\n        }', ""),
    ]
    expected = {}
    for _, name, *_ in mutants:
        if name not in expected:
            expected[name] = PARITY.execute(["node", str(SCRIPTS / "store-node-oracle.cjs")], traces[name])
            PARITY.node_control(name, traces[name], expected[name])
    with tempfile.TemporaryDirectory(prefix="milagre-routine-store-mutants-") as temporary:
        base = pathlib.Path(temporary)
        target = base / "target"
        work = base / "crate"
        environment = {**os.environ, "CARGO_TARGET_DIR": str(target), "CARGO_INCREMENTAL": "0"}
        for label, name, filename, before, after in mutants:
            if work.exists():
                shutil.rmtree(work)
            shutil.copytree(CRATE, work, ignore=shutil.ignore_patterns("target", "__pycache__"))
            path = work / "src/store" / filename
            if label == "publication-before-failure":
                replace_once(path, '''        if self.pending_image(stamp)?.is_some() {
            if let Err(error) = fault.check() {
                self.discard(stamp)?;
                return Err(error);
            }
        }
        self.install(stamp)''', '''        let changed = self.pending_image(stamp)?.is_some();
        let result = self.install(stamp)?;
        if changed {
            fault.check()?;
        }
        Ok(result)''')
            else:
                replace_once(path, before, after)
            build = subprocess.run(["cargo", "build", "--offline", "--locked", "--manifest-path",
                                    str(work / "Cargo.toml"), "--example", "store_fixture"],
                                   capture_output=True, timeout=180, env=environment)
            assert build.returncode == 0, f"{label}: compile failure is not a kill: {build.stderr[-5000:].decode(errors='replace')}"
            actual = PARITY.execute([str(target / "debug/examples/store_fixture")], traces[name])
            differences = [i for i, (a, b) in enumerate(zip(actual, expected[name])) if a != b]
            assert differences, f"{label}: compiled mutant survived"
            first = differences[0]
            print(json.dumps({"mutant": label, "compiled": True, "killed": True,
                              "trace": name, "firstDivergence": first, "command": traces[name][first]}), flush=True)
    print(json.dumps({"compiledMutantsKilled": len(mutants), "sourceUntouched": True,
                      "temporaryCrateAndTargetRemoved": not base.exists()}), flush=True)


if __name__ == "__main__":
    main()
