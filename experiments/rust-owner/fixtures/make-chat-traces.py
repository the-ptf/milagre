#!/usr/bin/env python3
"""Writes fixtures/chat-traces.json (run from experiments/rust-owner). Shared by chat-node.cjs and tests/chat.rs."""
import json

START = 1767225600000  # 2026-01-01T00:00:00Z

seed = {
    "next_id": 1,
    "worktrees": {"1": {"id": 1, "path": "/tmp/milagre-chat-worktree", "name": "main"}},
    "sessions": {"1": {"id": 1, "worktree_id": 1, "agent_name": "main", "status": "Created", "title": "Seeded"}},
    "messages": [],
}


def send(body, client, session=1, provider="kiro", **extra):
    request = {"sessionId": session, "provider": provider, "model": "model-a", "body": body, "clientMessageId": client}
    request.update(extra)
    return {"op": "send", "request": request}


def event(kind, session=1, **fields):
    return {"op": "event", "session": session, "event": dict({"type": kind}, **fields)}


QUEUED_1 = "00000000-0000-4000-8000-000000000001"
QUEUED_2 = "00000000-0000-4000-8000-000000000002"
QUEUED_3 = "00000000-0000-4000-8000-000000000003"

T = []
T.append({"name": "send-lifecycle", "start": START, "seed": seed, "steps": [
    {"op": "open"},
    send("Hello there", "c1", permissionMode="auto", effort="high"),
    event("session-started", nativeId="native-1"),
    event("turn-started", turnId="t1"),
    event("text-delta", text="Hi "), event("text-delta", text="there"),
    event("context-usage", used=100, size=1000),
    event("permission-request", requestId="p1", title="Run ls"),
    event("permission-resolved", requestId="p1"),
    send("Second question", "c2", prompt="Second question, longer prompt"),
    send("Second question", "c2"),
    send("Hello there", "c1"),
    {"op": "sendStatus", "id": "c1"}, {"op": "sendStatus", "id": "c2"}, {"op": "sendStatus", "id": "c3"},
    event("turn-completed"),
    event("text-delta", text="Answer two"),
    event("turn-failed", message="boom"),
    {"op": "send", "request": {"worktreeId": 1, "provider": "kiro", "model": "model-b", "body": "A new chat", "clientMessageId": "c4"}},
    {"op": "interrupt", "session": 5},
    event("turn-cancelled", session=5),
    {"op": "failNextStart", "message": "kiro-cli was not found"},
    send("Fails to start", "c5", session=5),
    send("", "c6", session=5),
    event("turn-completed", session=5),
    event("turn-completed", session=5),
    {"op": "advance", "ms": 300},
    {"op": "snapshot"},
    {"op": "crash"},
    {"op": "open"},
    {"op": "sendStatus", "id": "c5"},
    send("Fails to start", "c5", session=5),
    {"op": "snapshot"}]})
T.append({"name": "queue-hold-and-remove", "start": START, "seed": seed, "steps": [
    {"op": "open"},
    send("First", "q-a"),
    event("session-started", nativeId="native-q"),
    send("Queued B", "q-b"),
    send("Queued C", "q-c"),
    {"op": "interrupt", "session": 1},
    event("turn-cancelled"),
    {"op": "queueRemove", "session": 1, "id": QUEUED_2},
    {"op": "queueRemove", "session": 1, "id": QUEUED_2},
    {"op": "queueSend", "session": 1, "id": QUEUED_1},
    event("text-delta", text="B answered"),
    event("turn-completed"),
    send("D", "q-d"),
    send("E queued", "q-e"),
    {"op": "queueSend", "session": 1, "id": QUEUED_3},
    event("turn-cancelled"),
    event("turn-completed"),
    send("F runs into a crash", "q-f"),
    send("F2 queued before the crash", "q-f2"),
    {"op": "advance", "ms": 300},
    {"op": "crash"},
    {"op": "open"},
    {"op": "sendStatus", "id": "q-f"},
    {"op": "sendStatus", "id": "q-f2"},
    send("G after the crash", "q-g"),
    event("turn-completed"),
    event("turn-completed"),
    {"op": "advance", "ms": 300},
    {"op": "snapshot"}]})
T.append({"name": "idle-sweep-keeps-running-chat", "start": START, "seed": seed, "steps": [
    {"op": "open"},
    send("Long turn", "s-1"),
    event("session-started", nativeId="native-s1"),
    {"op": "send", "request": {"worktreeId": 1, "provider": "kiro", "model": "model-a", "body": "Other chat", "clientMessageId": "s-2"}},
    event("session-started", session=2, nativeId="native-s2"),
    event("turn-completed", session=2),
    {"op": "advance", "ms": 11 * 60 * 1000},
    event("text-delta", text="still going"),
    event("turn-completed"),
    {"op": "advance", "ms": 300},
    {"op": "sendStatus", "id": "s-2"},
    {"op": "snapshot"}]})

with open("fixtures/chat-traces.json", "w", encoding="ascii") as out:
    out.write(json.dumps(T, indent=1) + "\n")
print(len(T), "traces,", sum(len(t["steps"]) for t in T), "steps")
