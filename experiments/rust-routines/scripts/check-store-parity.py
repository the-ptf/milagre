#!/usr/bin/env python3
"""Compare bounded schedule-store traces with the actual production Node store."""
import argparse
import copy
import datetime
import json
import pathlib
import subprocess

CRATE = pathlib.Path(__file__).resolve().parents[1]
REPO = CRATE.parents[1]
START = 1767607200000  # Monday 2026-01-05 10:00 UTC.
DAY = 86400000
LIMIT = 4 * 1024 * 1024


def heartbeat(**values):
    result = dict(chatId="c1", name="check", prompt="look", every="15m",
                  timezone="UTC", createdBy={"kind": "user"})
    result.update(values)
    return result


def schedule(**values):
    result = {"name": "schedule", "prompt": "look",
              "trigger": {"kind": "schedule", "cron": "*/15 * * * *", "timezone": "UTC"},
              "target": {"kind": "new-chat", "projectPath": "/synthetic/project", "workspace": "project"},
              "createdBy": {"kind": "user"}}
    result.update(values)
    return result


def command(op, *args, **fields):
    return dict(op=op, args=list(args), **fields)


def opened(now=START, seed=None):
    return {"op": "open", "now": now, "seed": seed}


def instant(text):
    return int(datetime.datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)


def seed_template():
    # Seed construction only: expected observations still come from a fresh real Node store.
    rows = execute(["node", str(CRATE / "scripts/store-node-oracle.cjs")],
                   [opened(), command("create", schedule()), command("upsertHeartbeat", heartbeat())])
    value = json.loads(rows[-1]["file"])
    for routine, name in zip(value["routines"], ["seed-schedule", "seed-heartbeat"]):
        old = routine["id"]
        routine["id"] = name
        if old in value["runs"]:
            value["runs"][name] = value["runs"].pop(old)
    return value


def corpus():
    traces = {}
    traces["crud-upsert-and-removal"] = [
        opened(), command("create", schedule()), command("upsertHeartbeat", heartbeat()),
        command("list"), command("get", "id1"), command("get", "missing"),
        command("update", "id2", {"maxRuns": 2, "expiresAt": None}),
        command("update", "id2", {"name": " "}),
        command("update", "id2", {"unknown": True, "another": False}),
        command("update", "id2", {"enabled": False, "fallback": {"provider": "p", "model": "m"}}),
        command("upsertHeartbeat", {**heartbeat(), "every": "30m", "prompt": "replaced"}),
        command("update", "id2", {"enabled": False}),
        command("startRun", "id2", START), command("finishRun", "id3", {"status": "quiet"}),
        command("startRun", "id2", START + 1), command("finishRun", "id4", {"status": "failed", "error": "failure"}),
        command("finishRun", "id4", {"status": "acted"}), command("complete", "id2", "manual", now=START + 10),
        command("remove", "id1"), command("remove", "id1"), command("wasRemoved", "id1"),
        command("reload"), command("get", "id2"), command("runs", "id2"),
    ]
    traces["due-boundaries-no-backlog"] = [
        opened(), command("upsertHeartbeat", heartbeat()),
        command("claimDue", START + 900000, now=START + 900000),
        command("claimDue", START + 900000), command("finishRun", "id2", {"status": "acted"}),
        command("claimDue", START + 1860000, now=START + 1860000),
        command("claimDue", START + 2760001, now=START + 2760001),
        command("finishRun", "id3", {"status": "skipped-busy"}),
        command("claimDue", START + DAY, now=START + DAY), command("claimDue", START + DAY),
        command("runs", "id1"), command("reload"), command("recoverInterrupted"),
    ]
    traces["restart-multiple-runs-and-failure-streak"] = [
        opened(), command("create", schedule()), command("upsertHeartbeat", heartbeat()),
        command("startRun", "id1", START), command("startRun", "id1", START),
        command("startRun", "id2", START), command("reload", now=START + 3600000),
        command("recoverInterrupted"), command("recoverInterrupted"),
        command("startRun", "id1", START + 3600000), command("finishRun", "id6", {"status": "failed"}),
        command("startRun", "id1", START + 3600000), command("finishRun", "id7", {"status": "failed"}),
        command("update", "id1", {"enabled": True}, now=START + 7200000),
        command("startRun", "id1", START + 7200000), command("finishRun", "id8", {"status": "ended"}),
    ]
    for failure in ["write", "rename"]:
        traces[f"rollback-{failure}"] = [
            opened(), command("upsertHeartbeat", heartbeat(), fail=failure),
            command("upsertHeartbeat", heartbeat()),
            command("update", "id2", {"prompt": "changed"}, fail=failure),
            command("update", "id2", {"prompt": "changed"}),
            command("claimDue", START + 900000, now=START + 900000, fail=failure),
            command("claimDue", START + 900000),
            command("finishRun", "id4", {"status": "acted"}, fail=failure),
            command("finishRun", "id4", {"status": "acted"}),
            command("remove", "id2", fail=failure), command("remove", "id2"), command("reload"),
        ]
    traces["expiry-purge-tombstone-and-effects"] = [
        opened(), command("create", schedule(expiresAt=START + 100)),
        command("startRun", "id1", START), command("attachChat", "id2", {"chatId": "linked-chat"}),
        command("setRunTitle", "id2", "Run title"), command("getRun", "id2"),
        command("expireDue", START + 99, now=START + 99),
        command("expireDue", START + 100, now=START + 100),
        command("finishRun", "id2", {"status": "acted"}), command("complete", "id1", "ignored", now=START + 200),
        command("reload", now=START + 31 * DAY), command("wasRemoved", "id1"),
        command("create", schedule(name="post-purge")), command("reload"),
    ]
    traces["epoch-zero-and-backward-clock"] = [
        opened(now=0), command("upsertHeartbeat", heartbeat()), command("complete", "id1", "zero"),
        command("get", "id1"), command("complete", "id1", "second", now=1),
        command("complete", "id1", "third", now=-1), command("list"), command("reload", now=0),
    ]
    texts = ["x" * 80, "x" * 81, "😀" * 40, "😀" * 41, "\ufeff", "\u0085", " title\u00a0", "surrogate\ud800"]
    traces["validation-unicode-and-order"] = [opened()]
    for text in texts:
        traces["validation-unicode-and-order"].append(command("create", schedule(name=text)))
    for change in [{"prompt": "😀" * 2000}, {"prompt": "😀" * 2001}, {"maxRuns": 0}, {"maxRuns": 1001},
                   {"maxRuns": 1.5}, {"maxRuns": 1}, {"enabled": False}, {"fallback": None}]:
        traces["validation-unicode-and-order"].append(command("create", schedule(**change)))
    traces["validation-unicode-and-order"] += [command("update", "missing", {"unknown": 0}),
        command("update", "id1", {"zzz": 0, "aaa": 0}), command("update", "id1", {"aaa": 0, "zzz": 0}),
        command("create", schedule(trigger={"kind": "schedule", "cron": "0 * * * *", "timezone": "\U0010fffe\U0010fffe"})),
        command("upsertHeartbeat", heartbeat(expiresIn="\U0010fffe\U0010fffe"))]
    keep = [opened(), command("create", schedule())]
    next_id = 2
    for index in range(160):
        status = ["acted", "skipped-busy", "quiet"][index % 3]
        keep += [command("startRun", "id1", START + index, now=START + index),
                 command("attachChat", f"id{next_id}", {"chatId": f"kept-{index}"}),
                 command("finishRun", f"id{next_id}", {"status": status})]
        next_id += 1
    keep += [command("startRun", "id1", START + 200), command("reload"), command("hasRun", "id2"), command("hasPending", "id1")]
    traces["retention-and-running-history"] = keep
    # An old running entry must survive enough newer quiet Runs to overflow its bucket.
    hold = [opened(), command("create", schedule()), command("startRun", "id1", START)]
    for index in range(55):
        hold += [command("startRun", "id1", START + index + 1, now=START + index + 1),
                 command("finishRun", f"id{index + 3}", {"status": "quiet"})]
    hold += [command("hasRun", "id2"), command("getRun", "id2"),
             command("finishRun", "id2", {"status": "acted"}), command("reload")]
    traces["old-running-survives-retention"] = hold

    for kind, create in [("heartbeat", command("upsertHeartbeat", heartbeat())),
                         ("schedule", command("create", schedule()))]:
        failures = [opened(), create, command("pause", "id1", "original pause")]
        for run in range(2, 5):
            failures += [command("startRun", "id1", START + run, now=START + run),
                         command("finishRun", f"id{run}", {"status": "failed", "error": f"failure-{run}"})]
        failures += [command("get", "id1"), command("reload"),
                     command("update", "id1", {"enabled": True}, now=START + 100)]
        traces[f"three-failures-{kind}"] = failures
    traces["completion-and-status-boundaries"] = [
        opened(), command("create", schedule(maxRuns=2)),
        command("startRun", "id1", START), command("startRun", "id1", START + 1),
        command("complete", "id1", "manual stop", now=START + 2),
        command("finishRun", "id2", {"status": "quiet"}),
        command("finishRun", "id3", {"status": "ended"}),
        command("finishRun", "id3", {"status": "acted"}),
        command("finishRun", "missing", {"status": "missed"}),
        command("finishRun", "missing", {"status": "acted"}),
        command("complete", "id1", "later reason", now=START + 5),
        command("complete", "missing", "no result"), command("reload"),
    ]
    traces["claim-at-independent-of-clock"] = [
        opened(), command("upsertHeartbeat", heartbeat()),
        command("claimDue", START + 900000, now=START - 100),
        command("update", "id1", {"maxRuns": 1}),
        command("claimDue", START + 1800000),
        command("finishRun", "id2", {"status": "skipped-busy"}),
        command("finishRun", "id3", {"status": "acted"}), command("reload"),
    ]
    dates = [
        ("spring-gap", "2026-03-08T06:59:00Z", "30 2 * * *", "America/New_York"),
        ("fall-repeat", "2026-11-01T05:29:00Z", "30 1 * * *", "America/New_York"),
        ("leap-century", "2096-03-01T00:00:00Z", "0 0 29 2 *", "UTC"),
        ("upper-output", "9990-12-29T23:59:00Z", "0 0 29 2 *", "UTC"),
    ]
    for name, text, cron, zone in dates:
        at = instant(text)
        spec = schedule(trigger={"kind": "schedule", "cron": cron, "timezone": zone})
        # Claim calls remain inside the accepted input bound; far-future nextRunAt is a stored output.
        traces[f"calendar-{name}"] = [opened(now=at), command("create", spec), command("reload")]
        if name != "upper-output":
            traces[f"calendar-{name}"] += [command("claimDue", at + 60000, now=at + 60000),
                                          command("claimDue", at + 3660000, now=at + 3660000)]

    template = seed_template()
    impossible = copy.deepcopy(template)
    impossible["routines"][0]["trigger"]["cron"] = "0 0 31 2 *"
    for routine in impossible["routines"]:
        routine["nextRunAt"] = START
    for op in ["claimDue", "recoverInterrupted"]:
        trace = [opened(seed=json.dumps(impossible)),
                 command(op, *([START] if op == "claimDue" else [])), command("reload")]
        traces[f"impossible-next-to-healthy-{op}"] = trace
    expired = copy.deepcopy(template)
    expired["routines"][0].update(completedAt=START - 31 * DAY, enabled=False)
    expired["runs"]["seed-schedule"] = [{"id": "old-run", "routineId": "seed-schedule",
        "scheduledFor": START - 32 * DAY, "startedAt": START - 32 * DAY, "endedAt": START - 31 * DAY,
        "status": "acted", "chatId": "old-chat"}]
    traces["load-upkeep-then-publish"] = [
        opened(seed=json.dumps(expired)), command("get", "seed-schedule"),
        command("update", "seed-heartbeat", {"prompt": "post-load"}, fail="rename"),
        command("update", "seed-heartbeat", {"prompt": "post-load"}), command("reload"),
    ]
    signed_zero = copy.deepcopy(template)
    signed_zero["routines"][0]["createdAt"] = -0.0
    signed_zero["routines"][1]["createdAt"] = 0.0
    traces["imported-signed-zero-tie"] = [opened(seed=json.dumps(signed_zero)), command("list"),
        command("update", "seed-schedule", {"prompt": "tie preserved"}), command("list"), command("reload")]
    for kind, create in [("heartbeat", command("upsertHeartbeat", heartbeat())),
                         ("schedule", command("create", schedule()))]:
        trace = [opened(), create]
        for number in [2, 3]:
            trace += [command("startRun", "id1", START + number, now=START + number),
                      command("finishRun", f"id{number}", {"status": "failed", "error": "ordinary failure"})]
        trace += [command("startRun", "id1", START + 4, now=START + 4),
                  command("finishRun", "id4", {"status": "failed", "error": {"toString": None}}),
                  command("finishRun", "id4", {"status": "failed", "error": ["failure", {"nested": True}, None, 7]}),
                  command("finishRun", "missing"), command("finishRun", "missing", None), command("reload")]
        traces[f"error-interpolation-rollback-{kind}"] = trace
    missing = [opened()]
    for field in ["name", "prompt", "trigger", "target", "createdBy"]:
        spec = schedule()
        del spec[field]
        missing.append(command("create", spec))
    for parent, field in [("trigger", "cron"), ("trigger", "timezone"), ("target", "projectPath"), ("createdBy", "kind")]:
        spec = schedule()
        del spec[parent][field]
        missing.append(command("create", spec))
    missing += [command("create", schedule()), command("setLastError", "id1"), command("complete", "id1"),
                command("reload")]
    traces["missing-required-fields"] = missing
    return traces


def execute(argv, trace):
    encoded = [(json.dumps(row, ensure_ascii=True, separators=(",", ":")) + "\n").encode() for row in trace]
    assert len(encoded) <= 4096 and all(len(row) <= LIMIT for row in encoded), "Fixture input bounds"
    result = subprocess.run(argv, input=b"".join(encoded), capture_output=True, timeout=60, cwd=REPO)
    if result.returncode:
        raise AssertionError(f'{argv[0]} failed: {result.stderr[-4096:].decode(errors="replace")}')
    assert len(result.stdout) <= 128 * 1024 * 1024, "Aggregate fixture output bound"
    rows = [json.loads(line) for line in result.stdout.splitlines()]
    assert len(rows) == len(trace), "Every submitted command must produce exactly one observation"
    return rows


def refusal_corpus():
    template = seed_template()
    cases = []
    for label, edit, reason in [
        ("mixed-event", lambda row: row.update(trigger={"kind": "webhook", "hookId": "synthetic-hook"}), "non-schedule Routine"),
        ("mixed-flow", lambda row: row.update(flow={"revision": 1, "steps": []}), "flow Routine outside schedule checkpoint"),
        ("mixed-SystemV", lambda row: row["trigger"].update(timezone="SystemV/EST5EDT"), "ICU-only SystemV timezone"),
        ("fractional-time", lambda row: row.update(createdAt=START + 0.5), "timestamp"),
    ]:
        seed = copy.deepcopy(template)
        edit(seed["routines"][1])
        cases.append((label, json.dumps(seed), reason))
    duplicate = copy.deepcopy(template)
    duplicate["routines"].append(copy.deepcopy(duplicate["routines"][0]))
    cases += [("duplicate-identity", json.dumps(duplicate), "duplicate Routine identity"),
              ("wrong-version", json.dumps({**template, "version": 999}), "snapshot version is not supported"),
              ("wrong-shape", json.dumps({"version": 1, "routines": {}, "runs": {}}), "snapshot shape is not supported"),
              ("corrupt-json", "{", "JSON")]
    return [(name, [opened(seed=seed)], reason) for name, seed, reason in cases]


def id_refusal_corpus():
    template = seed_template()
    template["routines"][0]["id"] = "1"
    template["runs"] = {"1": [{"id": "2", "routineId": "1", "scheduledFor": START,
        "startedAt": START, "status": "running"}]}
    methods = {"get": [], "runs": [], "getRun": [], "hasRun": [], "hasPending": [], "wasRemoved": [],
               "update": [{"prompt": "must not alias"}], "remove": [], "startRun": [START],
               "finishRun": [{"status": "acted"}], "complete": ["must not alias"],
               "pause": ["must not alias"], "setLastError": ["must not alias"],
               "attachChat": [{"chatId": "must-not-alias"}], "setRunTitle": ["must not alias"]}
    cases = []
    for op, extra in methods.items():
        numeric = 2 if op in ["getRun", "hasRun", "finishRun", "attachChat", "setRunTitle"] else 1
        for label, value in [("number", numeric), ("null", None), ("boolean", True), ("object", {}), ("array", [str(numeric)])]:
            cases.append((f"{op}-{label}", [opened(seed=json.dumps(template)), command(op, value, *extra)]))
        cases.append((f"{op}-missing", [opened(seed=json.dumps(template)), command(op)]))
    return cases


def node_control(name, trace, rows):
    if name.startswith("rollback-"):
        for index, row in enumerate(trace):
            if row.get("fail"):
                assert rows[index]["result"] == {"error": f'EIO: injected {"writeFileSync" if row["fail"] == "write" else "renameSync"} failure'}
                assert rows[index]["file"] == rows[index - 1]["file"]
                assert rows[index]["saves"] == rows[index - 1]["saves"]
                assert rows[index]["effects"] == []
    if name == "due-boundaries-no-backlog":
        assert len(rows[2]["result"]["ok"]) == len(rows[5]["result"]["ok"]) == 1
        assert rows[3]["result"]["ok"] == rows[6]["result"]["ok"] == []
        assert len(rows[8]["views"][0]["runs"]) == 4
    if name == "restart-multiple-runs-and-failure-streak":
        assert all(view["routine"]["failedStreak"] == 1 for view in rows[7]["views"])
        assert rows[7]["file"] == rows[8]["file"] and rows[7]["saves"] == rows[8]["saves"]
    if name == "expiry-purge-tombstone-and-effects":
        assert rows[10]["file"] == rows[9]["file"], "Load upkeep must not invent a disk publication"
        assert rows[10]["views"][0]["removed"] is True and rows[10]["views"][0]["routine"] is None
    if name == "old-running-survives-retention":
        assert rows[-4]["result"] == {"ok": True}
        assert rows[-3]["result"]["ok"]["run"]["status"] == "running"
        assert rows[-2]["result"]["ok"]["runCount"] == 56
    if name.startswith("three-failures-"):
        routine = rows[-3]["result"]["ok"]
        assert routine["runCount"] == routine["failedStreak"] == 3
        assert routine["enabled"] is False
        if name.endswith("heartbeat"):
            assert routine["completedAt"] == START + 4
        else:
            assert routine["pausedReason"] == "original pause" and not routine.get("completedAt")
    if name.startswith("impossible-next-to-healthy-"):
        by_id = {row["id"]: row["routine"] for row in rows[1]["views"]}
        assert by_id["seed-schedule"]["enabled"] is False
        assert by_id["seed-schedule"]["pausedReason"] == "schedule has no next run"
        assert by_id["seed-heartbeat"]["enabled"] is True
        assert by_id["seed-heartbeat"]["nextRunAt"] > START
    if name == "load-upkeep-then-publish":
        assert rows[0]["file"] == trace[0]["seed"] and rows[0]["saves"] == 0
        assert all(row["id"] != "seed-schedule" for row in rows[0]["list"])
        assert rows[2]["result"] == {"error": "EIO: injected renameSync failure"}
        assert rows[2]["file"] == rows[0]["file"] and rows[2]["effects"] == []
        assert rows[3]["saves"] == 1 and rows[4]["file"] == rows[3]["file"]
    if name == "imported-signed-zero-tie":
        for row in rows:
            assert [r["id"] for r in row["list"]] == ["seed-schedule", "seed-heartbeat"]
    if name.startswith("error-interpolation-rollback-"):
        assert rows[7]["result"] == {"error": "Cannot convert object to primitive value"}
        assert rows[7]["file"] == rows[6]["file"] and rows[7]["saves"] == rows[6]["saves"]
        assert rows[7]["runningCount"] == 1 and rows[7]["effects"] == []
        assert rows[8]["result"]["ok"]["runCount"] == 3


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--node-only", action="store_true", help="Validate only the real oracle/corpus, not Rust parity")
    args = parser.parse_args()
    oracle = CRATE / "scripts/store-node-oracle.cjs"
    subprocess.run(["node", "--check", str(oracle)], check=True)
    binary = CRATE / "target/debug/examples/store_fixture"
    if not args.node_only:
        subprocess.run(["cargo", "build", "--offline", "--locked", "--manifest-path", str(CRATE / "Cargo.toml"), "--example", "store_fixture"], check=True)
    traces = corpus()
    steps = 0
    for name, trace in traces.items():
        expected = execute(["node", str(oracle)], trace)
        node_control(name, trace, expected)
        if not args.node_only:
            actual = execute([str(binary)], trace)
            for index, (left, right) in enumerate(zip(expected, actual)):
                if left != right:
                    # Emit one bounded observation pair, not a huge entire trace.
                    detail = json.dumps({"trace": name, "step": index, "command": trace[index], "node": left, "rust": right}, ensure_ascii=True)
                    raise AssertionError(detail[:20000])
        steps += len(trace)
        print(json.dumps({"trace": name, "steps": len(trace), "nodeControl": True, "rustCompared": not args.node_only}), flush=True)
    print(json.dumps({"traces": len(traces), "steps": steps, "realNode": True, "rustParity": not args.node_only}), flush=True)
    refusals = refusal_corpus()
    for name, trace, reason in refusals:
        node = execute(["node", str(oracle)], trace)
        if not args.node_only:
            rust = execute([str(binary)], trace)
            assert len(rust) == 1 and set(rust[0]) == {"result"}, "Refused seed must never expose an admitted model"
            result = rust[0]["result"]
            assert set(result) == {"refused"} and reason.lower() in result["refused"].lower(), (name, result, reason)
        # The actual Node loader may retain, quarantine, or enter read-only mode.
        # Its output is observed, never replaced with the Rust refusal.
        assert len(node) == 1 and node[0]["result"] == {"ok": None}, (name, node)
        print(json.dumps({"refusalCase": name, "rustRefused": not args.node_only,
                          "cause": reason, "nodeRoutineCount": len(node[0]["list"]),
                          "nodeSaves": node[0]["saves"], "nodeFileRetained": node[0]["file"] == trace[0]["seed"],
                          "parityClaim": False}), flush=True)
    print(json.dumps({"deliberateBoundaryCases": len(refusals), "notIncludedInParityCount": True}), flush=True)
    identity_cases = id_refusal_corpus()
    for name, trace in identity_cases:
        node = execute(["node", str(oracle)], trace)
        assert node[1]["file"] == node[0]["file"] and node[1]["saves"] == 0 and node[1]["effects"] == [], name
        if not args.node_only:
            rust = execute([str(binary)], trace)
            assert len(rust) == 2 and set(rust[1]["result"]) == {"refused"}, (name, rust)
            assert "id" in rust[1]["result"]["refused"].lower() and "string" in rust[1]["result"]["refused"].lower(), (name, rust[1]["result"])
            assert {k: v for k, v in rust[0].items() if k != "result"} == {k: v for k, v in rust[1].items() if k != "result"}, name
        print(json.dumps({"idBoundary": name, "rustRefused": not args.node_only,
                          "nodeResult": node[1]["result"], "stateUnchanged": True, "parityClaim": False}), flush=True)
    print(json.dumps({"identityBoundaryCases": len(identity_cases), "notIncludedInParityCount": True}), flush=True)


if __name__ == "__main__":
    main()
