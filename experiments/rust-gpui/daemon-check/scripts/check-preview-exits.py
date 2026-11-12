#!/usr/bin/env python3
"""Exit paths of the built "Milagre GPUI Preview.app", observed, on dedicated roots with the backend's fixed Claude
stand-in (no account, no model call).

    python3 scripts/check-preview-exits.py --app <Milagre GPUI Preview.app> --fake <runtime-fake-claude> [--skills DIR]

For each path the app is opened in the background (`open -g -n`, MILAGRE_GPUI_NO_ACTIVATE=1) on its own new root,
the runtime's pid, wire profile and socket are read from the app's log, the path is taken, and then it is checked by
observation: the app process gone, the runtime process gone (reaped, not orphaned), the profile and socket removed,
the root's data kept, and the root opening again cleanly. One extra case checks that a second launch on a running root
is refused. Roots live under a private /tmp folder that is removed at the end. Prints a table and writes JSON to
daemon-check/target/check-preview-exits.json.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time

CRATE = Path(__file__).resolve().parents[1]
REPO = CRATE.parents[2]
OUT = CRATE / "target/check-preview-exits.json"
LINE = re.compile(r"live: (created|opened) (\S+) \(pid (\d+), profile (\S+), socket (\S+), launch (\S+),")


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    out = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(out) and not out.startswith("Z")


def app_pids(executable):
    out = subprocess.run(["pgrep", "-f", "-x", f"{executable}.*"], capture_output=True, text=True).stdout.split()
    return [int(p) for p in out]


def prepare(case, fake, skills):
    case.mkdir(mode=0o700)
    for name in ["claude-home", "claude-config"]:
        (case / name).mkdir(mode=0o700)
    (case / "script.json").write_text(json.dumps([{"wait_eof": True}]))
    wrapper = case / "fake-claude"
    wrapper.write_text(f'#!/bin/sh\nFAKE_CLAUDE_SCRIPT={case}/script.json exec {fake} "$@"\n')
    wrapper.chmod(0o700)
    manifest = case / "launch.json"
    launch = {"program": str(wrapper), "home": str(case / "claude-home"), "configDirectory": str(case / "claude-config"),
              "skillsDirectory": str(skills), "model": "sonnet", "path": "/usr/bin:/bin",
              "accountId": "11111111-1111-4111-8111-111111111111", "accountLabel": "Exit check fixed child", "userName": "gpui-exit-check"}
    fd = os.open(manifest, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.write(fd, json.dumps(launch).encode())
    os.close(fd)
    return case / "root", manifest


def launch(app, log, args):
    env = dict(os.environ, MILAGRE_GPUI_NO_ACTIVATE="1")
    subprocess.run(["open", "-g", "-n", "-a", str(app), "--stderr", str(log), "--stdout", str(log), "--env", "MILAGRE_GPUI_NO_ACTIVATE=1", "--args", *args], check=True, env=env)


def wait_line(log, timeout=30):
    until = time.time() + timeout
    while time.time() < until:
        text = log.read_text() if log.exists() else ""
        match = LINE.search(text)
        if match:
            return match, text
        if "milagre-gpui-live:" in text:
            return None, text
        time.sleep(0.2)
    return None, log.read_text() if log.exists() else ""


def wait_gone(pids, timeout=45):
    until = time.time() + timeout
    while time.time() < until and any(alive(p) for p in pids):
        time.sleep(0.2)
    return not any(alive(p) for p in pids)


def run_case(name, slug, action, app, executable, fake, skills, base):
    case = base / slug
    root, manifest = prepare(case, fake, skills)
    log = case / "app.log"
    before = set(app_pids(executable))
    launch(app, log, ["--root", str(root), "--create", str(manifest)])
    match, text = wait_line(log)
    if not match:
        return {"path": name, "error": f"did not start: {text[-800:]}"}
    runtime, profile, socket, storage = int(match.group(3)), Path(match.group(4)), Path(match.group(5)), Path(match.group(6))
    time.sleep(1.5)
    pids = [p for p in app_pids(executable) if p not in before]
    if len(pids) != 1:
        return {"path": name, "error": f"expected one new app process, got {pids}"}
    pid = pids[0]
    action(pid)
    app_gone = wait_gone([pid])
    runtime_gone = wait_gone([runtime], timeout=20)
    result = {
        "path": name,
        "appExited": app_gone,
        "childReaped": runtime_gone,
        "profileRemoved": not profile.exists(),
        "socketRemoved": not socket.exists(),
        "launchStorageRemoved": not storage.exists(),
        "dataKept": (root / "rust-chat-runtime.json").is_file() and (root / "project").is_dir(),
        "shutdownLogged": "live: shutdown" in log.read_text(),
        "shutdownLine": next((l for l in log.read_text().splitlines() if l.startswith("live: shutdown")), None),
    }
    if not runtime_gone:
        # Only this check's own runtime, by its exact pid: nothing else is touched.
        os.kill(runtime, signal.SIGTERM)
        wait_gone([runtime], timeout=10)
    # Reopen: a new launch on the same root opens and stops cleanly (no prompts: it quits at once).
    relog = case / "reopen.log"
    report = case / "reopen.json"
    launch(app, relog, ["--root", str(root), "--smoke-report", str(report)])
    rematch, retext = wait_line(relog)
    time.sleep(0.5)
    wait_gone([p for p in app_pids(executable) if p not in before], timeout=30)
    result["reopened"] = bool(rematch and rematch.group(1) == "opened" and "Complete(" in relog.read_text())
    if not result["reopened"]:
        result["reopenLog"] = retext[-600:]
    return result


def second_writer(app, executable, fake, skills, base):
    case = base / "second-launch"
    root, manifest = prepare(case, fake, skills)
    log, log2 = case / "first.log", case / "second.log"
    before = set(app_pids(executable))
    launch(app, log, ["--root", str(root), "--create", str(manifest)])
    match, _ = wait_line(log)
    time.sleep(1.0)
    launch(app, log2, ["--root", str(root)])
    _, text2 = wait_line(log2)
    refused = "milagre-gpui-live:" in text2 and "opened" not in text2
    for pid in [p for p in app_pids(executable) if p not in before]:
        subprocess.run(["osascript", "-e", 'tell application id "com.milagre.gpui-preview" to quit'], capture_output=True)
        wait_gone([pid])
    return {"path": "second launch on a running root", "refused": refused, "message": text2.strip().splitlines()[-1] if text2.strip() else ""}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", required=True, type=Path)
    parser.add_argument("--fake", required=True, type=Path)
    parser.add_argument("--skills", type=Path, default=REPO / "packages/core/src/bundled-skills")
    args = parser.parse_args()
    app = args.app.resolve()
    executable = app / "Contents/MacOS/milagre-gpui-preview"
    fake, skills = args.fake.resolve(), args.skills.resolve()
    quit_event = lambda pid: subprocess.run(["osascript", "-e", 'tell application id "com.milagre.gpui-preview" to quit'], capture_output=True)
    terminate = lambda pid: subprocess.run(["osascript", "-l", "JavaScript", "-e", f'ObjC.import("AppKit"); $.NSRunningApplication.runningApplicationWithProcessIdentifier({pid}).terminate'], capture_output=True)
    cases = [
        # ⌘Q, the menu's Quit and closing the last window all call `cx.quit()` (shell/keys.rs, app.rs): this sends Quit
        # through the same code by a no-prompt --smoke-report run instead of keystrokes into a background window.
        ("cx.quit (Cmd-Q, menu Quit, last window)", None),
        ("AppleEvent quit (osascript)", quit_event),
        ("NSRunningApplication.terminate", terminate),
        ("SIGTERM", lambda pid: os.kill(pid, signal.SIGTERM)),
        ("SIGKILL", lambda pid: os.kill(pid, signal.SIGKILL)),
    ]
    base = Path(tempfile.mkdtemp(prefix="gpui-preview-exits-", dir="/private/tmp"))
    base.chmod(0o700)
    results = []
    try:
        for index, (name, action) in enumerate(cases):
            slug = f"case-{index}"
            if action is None:
                case = base / slug
                root, manifest = prepare(case, fake, skills)
                log = case / "app.log"
                before = set(app_pids(executable))
                launch(app, log, ["--root", str(root), "--create", str(manifest), "--smoke-report", str(case / "smoke.json")])
                match, text = wait_line(log)
                if not match:
                    results.append({"path": name, "error": text[-800:]})
                    continue
                runtime, profile, socket, storage = int(match.group(3)), Path(match.group(4)), Path(match.group(5)), Path(match.group(6))
                pids = [p for p in app_pids(executable) if p not in before]
                wait_gone(pids)
                results.append({"path": name, "appExited": wait_gone(pids), "childReaped": wait_gone([runtime], 20), "profileRemoved": not profile.exists(),
                                "socketRemoved": not socket.exists(), "launchStorageRemoved": not storage.exists(), "dataKept": (root / "rust-chat-runtime.json").is_file(),
                                "shutdownLine": next((l for l in log.read_text().splitlines() if l.startswith("live: shutdown")), None)})
                continue
            results.append(run_case(name, slug, action, app, executable, fake, skills, base))
            results[-1]["path"] = name
        results.append(second_writer(app, executable, fake, skills, base))
    finally:
        leftover = [p for p in app_pids(executable)]
        runtimes = subprocess.run(["pgrep", "-f", str(base)], capture_output=True, text=True).stdout.split()
        # A root is only removed once nothing started from it runs (a runtime whose root vanished cannot stop).
        if not runtimes:
            shutil.rmtree(base, ignore_errors=True)
        else:
            print(f"kept {base}: still running {runtimes}")
    OUT.write_text(json.dumps(results, indent=2))
    print(f"{'path':42} {'child reaped':13} {'socket removed':15} {'storage removed':16} {'data kept':10} reopened/refused")
    for r in results:
        print(f"{r['path']:42} {str(r.get('childReaped', '-')):13} {str(r.get('socketRemoved', '-')):15} {str(r.get('launchStorageRemoved', '-')):16} {str(r.get('dataKept', '-')):10} {r.get('reopened', r.get('refused', '-'))}")
    print(f"apps left running: {leftover}; JSON: {OUT}")


if __name__ == "__main__":
    main()
