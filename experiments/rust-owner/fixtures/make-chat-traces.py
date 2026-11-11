#!/usr/bin/env python3
"""Writes fixtures/chat-traces.json (run from experiments/rust-owner, then `npx oxfmt fixtures/chat-traces.json` for
the repository formatter). Shared by chat-node.cjs and tests/chat.rs."""
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
    # (A second turn-completed here, with nothing running, is published by Node and dropped by Rust on purpose:
    # tests/chat_safety.rs a_duplicate_turn_end_while_idle_is_dropped.)
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


def step(kind, **fields):
    return event(kind, **fields)


AGENT_T = START + 1000
T.append({"name": "tool-steps-subagents-plans", "start": START, "seed": seed, "steps": [
    {"op": "open"},
    send("Run the tests", "t-1"),
    event("session-started", nativeId="native-t"),
    event("turn-started", turnId="t1"),
    event("text-delta", text="Let me check.\n"),
    step("step-started", step={"id": "s1", "kind": "shell", "title": "Run npm test", "detail": "$ npm test\n"}),
    {"op": "advance", "ms": 1200},
    step("step-output", id="s1", text="# pass 12\n# fail 1\n"),
    step("step-output", id="missing", text="ignored"),
    step("step-completed", id="s1", status="failed", title="Ran npm test",
         detail="$ npm test\n# pass 12\n# fail 1\nnot ok 3 - parses dates\n"),
    step("step-started", step={"id": "s2", "kind": "edit", "title": "Edit src/a.ts", "file": "src/a.ts"}),
    step("step-completed", id="s2", status="done", detail="--- a\n+++ b\n+x\n+y\n-z\n"),
    step("step-started", step={"id": "s3", "kind": "thinking", "title": "Thinking", "detail": "Considering the options"}),
    step("step-completed", id="s3", status="done"),
    step("step-started", step={"id": "s4", "kind": "tool", "title": "Search issues", "source": "linear"}),
    {"op": "advance", "ms": 40},
    step("step-completed", id="s4", status="done", detail="[{\"id\":1},{\"id\":2}]", durationMs=7),
    step("step-started", step={"id": "s5", "kind": "shell", "title": "Run vitest", "detail": "$ vitest run\n"}),
    step("step-completed", id="s5", status="done", detail="$ vitest run\n Tests  2 failed | 8 passed (10)\n", note="flaky"),
    step("step-started", step={"id": "s6", "kind": "shell", "title": "Serve", "detail": "$ npm run dev\n"}),
    step("step-started", step={"id": "s6", "kind": "shell", "title": "Serve (waiting)", "detail": "$ npm run dev\n"}),
    event("tasks-updated", tasks=[{"id": "1", "content": "Write tests", "status": "in_progress", "activeForm": "Writing tests"},
                                  {"id": "2", "content": "Ship", "status": "pending"}]),
    event("tasks-updated", tasks=[{"id": "1", "content": "Write tests", "status": "in_progress", "activeForm": "Writing tests"},
                                  {"id": "2", "content": "Ship", "status": "pending"}]),
    event("background-tasks", tasks=[{"id": "b1", "kind": "shell", "title": "dev server"}]),
    event("background-tasks", tasks=[{"id": "b1", "kind": "shell", "title": "dev server"}]),
    event("subagent-update", agent={"id": "a1", "title": "Explorer", "status": "running", "startedAt": AGENT_T, "updatedAt": AGENT_T,
                                    "transcript": [{"id": "e1", "text": "looking"}], "prompt": "Find the files"}),
    event("subagent-update", agent={"id": "a1", "title": "Subagent", "status": "completed", "startedAt": AGENT_T + 5, "updatedAt": AGENT_T + 10,
                                    "endedAt": AGENT_T + 10, "transcript": [{"id": "e1", "text": "looked"}, {"id": "e2", "text": "done"}]}),
    event("subagent-update", agent={"id": "a1", "title": "Stale", "status": "running", "startedAt": AGENT_T, "updatedAt": AGENT_T + 1,
                                    "transcript": []}),
    event("subagent-update", agent={"id": "native-t", "title": "Self", "status": "running", "startedAt": AGENT_T, "updatedAt": AGENT_T,
                                    "transcript": []}),
    event("subagent-update", agent={"id": "a2", "title": "Tailer", "status": "running", "startedAt": AGENT_T, "updatedAt": AGENT_T,
                                    "transcript": [{"id": "x1", "text": "one"}], "transcriptLength": 1}),
    # Three updates, then the turn end archives it: Node keeps `archived: undefined` in its place from the second
    # merge, so `archived: true` lands before `endedAt` (jsjson's undefined marker reproduces that).
    event("subagent-update", agent={"id": "a3", "title": "Builder", "status": "running", "startedAt": AGENT_T, "updatedAt": AGENT_T,
                                    "transcript": [{"id": "b1", "text": "start"}]}),
    event("subagent-update", agent={"id": "a3", "title": "Builder", "status": "running", "startedAt": AGENT_T, "updatedAt": AGENT_T + 1,
                                    "transcript": [{"id": "b2", "text": "more"}]}),
    event("subagent-update", agent={"id": "a3", "title": "Builder", "status": "completed", "startedAt": AGENT_T, "updatedAt": AGENT_T + 2,
                                    "endedAt": AGENT_T + 2, "transcript": [{"id": "b3", "text": "built"}]}),
    event("text-delta", text="All done."),
    event("turn-completed"),
    event("background-tasks", tasks=[]),
    event("plan-updated", plan={"source": "milagre", "tasks": [{"id": "1", "title": "Mine", "status": "pending"}], "phases": [], "updatedAt": 1}),
    event("tasks-updated", tasks=[{"id": "9", "content": "Ignored", "status": "pending"}]),
    event("plan-updated", plan=None),
    event("tasks-updated", tasks=[]),
    {"op": "advance", "ms": 300},
    {"op": "snapshot"}]})

QUESTION = {"requestId": "q1", "questions": [
    {"id": "color", "header": "Color", "question": "Which color?", "options": [{"label": "Red"}, {"label": "Blue"}]},
    {"id": "token", "header": "Token", "question": "API token?", "secret": True, "options": [{"label": "Skip"}]},
    {"id": "size", "header": "Size", "question": "Which size?", "options": []}]}

T.append({"name": "permissions-and-questions", "start": START, "seed": seed, "steps": [
    {"op": "open"},
    {"op": "respondPermission", "session": 1, "requestId": "p0", "decision": "allow"},
    send("Clean up", "q-1"),
    event("session-started", nativeId="native-q"),
    event("turn-started", turnId="tq"),
    event("text-delta", text="I need to ask first."),
    event("permission-request", requestId="p1", title="Run rm -rf build", stepId="s1"),
    {"op": "respondPermission", "session": 1, "requestId": "p1", "decision": "allow"},
    {"op": "respondPermission", "session": 1, "requestId": "p1", "decision": "maybe"},
    event("permission-resolved", requestId="p1"),
    event("question-request", **QUESTION),
    {"op": "answerQuestion", "session": 1, "requestId": "q1", "answers": {"color": ["Red"], "token": ["hunter2"], "size": []},
     "summary": "Red, ••••••"},
    event("question-resolved", requestId="q1"),
    event("text-delta", text="Thanks."),
    event("question-request", **dict(QUESTION, requestId="q2")),
    {"op": "refuseAnswers", "refuse": True},
    {"op": "answerQuestion", "session": 1, "requestId": "q2", "answers": {"color": ["Blue"]}, "summary": "Blue"},
    {"op": "answerQuestion", "session": 1, "requestId": "q2", "answers": {"color": [5]}, "summary": "Five"},
    {"op": "answerQuestion", "session": 1, "requestId": "q2", "answers": None, "summary": "Dismissed"},
    {"op": "refuseAnswers", "refuse": False},
    {"op": "answerQuestion", "session": 1, "requestId": "q2", "answers": {"token": ["Skip"]}},
    event("question-resolved", requestId="q2"),
    {"op": "respondPermission", "session": 7, "requestId": "p9", "decision": "deny"},
    event("turn-completed"),
    {"op": "advance", "ms": 300},
    {"op": "snapshot"},
    {"op": "crash"},
    {"op": "open"},
    {"op": "respondPermission", "session": 1, "requestId": "p1", "decision": "allow"},
    {"op": "snapshot"}]})

T.append({"name": "claude-suggestion", "start": START, "seed": seed, "steps": [
    {"op": "open"},
    send("Hi Claude", "c-1", provider="claude"),
    event("session-started", nativeId="native-c"),
    event("turn-started", turnId="tc1"),
    event("text-delta", text="Hello."),
    event("prompt-suggestion", turnId="tc1", text="Too early"),
    event("turn-completed"),
    event("prompt-suggestion", turnId="other", text="Wrong turn"),
    event("prompt-suggestion", turnId="tc1", text="   "),
    event("prompt-suggestion", turnId="tc1", text="Run the tests"),
    {"op": "advance", "ms": 300},
    {"op": "snapshot"},
    send("Next", "c-2", provider="claude"),
    event("turn-completed"),
    {"op": "advance", "ms": 300},
    {"op": "snapshot"}]})

T.append({"name": "claude-steering-save", "start": START, "seed": seed, "steps": [
    {"op": "open"},
    send("Refactor the parser", "st-1", provider="claude", effort="high"),
    event("session-started", nativeId="native-st"),
    event("turn-started", turnId="ts1"),
    event("text-delta", text="Looking at the parser.\n"),
    step("step-started", step={"id": "r1", "kind": "read", "title": "Read parser.ts", "file": "parser.ts"}),
    step("step-completed", id="r1", status="done"),
    step("step-started", step={"id": "r2", "kind": "shell", "title": "Run tests", "detail": "$ npm test\n"}),
    {"op": "advance", "ms": 500},
    # A steer: another model and provider asked for, the running turn's kept; the reply so far is split above it,
    # the running step carries on at the start of the rest.
    send("Also keep the old API", "st-2", provider="codex", model="model-b", effort="low"),
    send("Also keep the old API", "st-2", provider="claude"),
    event("text-delta", text="Sure, I'll keep it."),
    # The first text after the steer, before the agent goes back to its tools, is its own reply.
    step("step-started", step={"id": "r3", "kind": "edit", "title": "Edit parser.ts", "file": "parser.ts"}),
    step("step-completed", id="r2", status="done", detail="$ npm test\n# pass 3\n# fail 0\n"),
    step("step-completed", id="r3", status="done", detail="+a\n-b\n"),
    # A steer with nothing streamed since: nothing to split.
    send("And add a test", "st-3", provider="claude"),
    send("Queue this one", "st-4", provider="claude", delivery="queue"),
    event("text-delta", text="Done."),
    event("turn-completed"),
    {"op": "advance", "ms": 300},
    {"op": "snapshot"}]})

with open("fixtures/chat-traces.json", "w", encoding="ascii") as out:
    out.write(json.dumps(T, indent=2) + "\n")
print(len(T), "traces,", sum(len(t["steps"]) for t in T), "steps")
