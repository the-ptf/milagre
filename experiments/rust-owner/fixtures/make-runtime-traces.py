#!/usr/bin/env python3
"""Writes fixtures/runtime-traces.json (run from experiments/rust-owner). Shared by runtime-node.cjs and tests/runtime.rs."""
import json

START = 1767225600000  # 2026-01-01T00:00:00Z: before any file's real mtime, so no sweep finds a sidecar old enough
H = 3600 * 1000


def m(i, chat, role, body, **kw):
    d = {"id": i, "session_id": chat, "role": role, "body": body}
    d.update(kw)
    return d


seed_msgs = [
    m(1, 1, "user", "Fix the parser please", clientMessageId="cm-1"),
    m(2, 1, "assistant", "Parsing works now; the parser handles naïve café input.", outcome="completed"),
    m(3, 2, "user", "Look at İstanbul and 日本語 text \U0001F600 here", clientMessageId="cm-3"),
    m(4, 2, "assistant", "Ran the checks.", outcome="completed",
      steps=[{"id": "s1", "kind": "shell", "title": "grep", "detail": "grep:" + "x" * 1500, "status": "done"}]),
    m(5, 1, "user", "Another parser question", clientMessageId="cm-5"),
    m(6, 3, "user", "Third chat asks about the paser typo", clientMessageId="cm-6"),
    m(7, 3, "assistant", "Third chat answer about parsers", outcome="completed"),
    m(8, 2, "user", "Second chat follow up on the parser", clientMessageId="cm-8"),
    m(9, 4, "user", "Archived chat mentions parser too", clientMessageId="cm-9"),
    m(10, 3, "assistant", "A longer reply " + "word " * 80, outcome="completed"),
    m(11, 1, "assistant", "First chat reply", outcome="failed"),
]
seed = {
    "next_id": 12,
    "sessions": {
        "1": {"id": 1, "title": "One", "summary": {"lastAt": START - 1000, "lastOutcome": "failed"}, "unread": True},
        "2": {"id": 2, "title": "Two", "summary": {"lastAt": START - 2 * H, "lastOutcome": "completed"},
              "subagents": [{"id": "helper", "title": "helper",
                             "transcript": [{"id": "e1", "kind": "message", "text": "hello"}, {"id": "e2", "kind": "tool", "text": "z" * 1200}]}]},
        "3": {"id": 3, "title": "Three", "summary": {"lastAt": START - 2 * H, "lastOutcome": "completed"}, "unread": True,
              "queued": [{"clientMessageId": "queued-3", "body": "later"}]},
        "4": {"id": 4, "title": "Four", "archived": True, "summary": {"lastAt": START - 3 * H}},
    },
    "messages": seed_msgs,
}
lazy_seed = json.loads(json.dumps(seed))
lazy_seed["messages"].append(m(15, 3, "assistant", "cut emoji \ud83d in half", outcome="completed"))

T = []
T.append({"name": "lazy-lifecycle", "start": START, "seed": lazy_seed, "steps": [
    {"op": "open"},
    {"op": "update", "chats": [1], "change": {"kind": "append", "messages": [m(12, 1, "user", "New question about parsing", clientMessageId="cm-12")]}},
    {"op": "advance", "ms": 300},
    {"op": "update", "chats": [2], "change": {"kind": "append", "messages": [m(13, 2, "assistant", "Second chat new reply", outcome="completed")]}},
    {"op": "update", "change": {"kind": "edit", "id": 6, "patch": {"body": "Third chat edited about the parser"}}},
    {"op": "advance", "ms": 300},
    {"op": "search", "query": "the parser"}, {"op": "search", "query": "  PARSER\t works  "}, {"op": "search", "query": "a"},
    {"op": "search", "query": "\U0001F600"}, {"op": "search", "query": "text here"}, {"op": "search", "query": "cut emoji"},
    {"op": "search", "query": "third parser", "limit": 1},
    {"op": "search", "query": "parser"}, {"op": "search", "query": "pars"}, {"op": "search", "query": "parsre"},
    {"op": "search", "query": "naive cafe"}, {"op": "search", "query": "istanbul"}, {"op": "search", "query": "日本語"},
    {"op": "search", "query": "third chat parser", "limit": 2}, {"op": "search", "query": "x"}, {"op": "search", "query": "word word"},
    {"op": "chatMessages", "chat": 3, "options": {"turns": 1}}, {"op": "chatMessages", "chat": 2},
    {"op": "chatMessage", "id": 4}, {"op": "chatMessage", "id": 99},
    {"op": "allMessages", "marks": True}, {"op": "allMessages", "withState": True}, {"op": "allMessages"},
    {"op": "sendStatus", "id": "cm-8"}, {"op": "sendStatus", "id": "queued-3"}, {"op": "sendStatus", "id": "nope"},
    {"op": "subagent", "chat": 2, "agent": "helper"}, {"op": "subagent", "chat": 2, "agent": "gone"},
    {"op": "inboxValue"}, {"op": "whole"},
    {"op": "advance", "ms": 11 * 60 * 1000},
    {"op": "busy", "chat": 1, "value": True},
    {"op": "update", "chats": [1], "change": {"kind": "append", "messages": [m(14, 1, "user", "Keep chat one busy", clientMessageId="cm-14")]}},
    {"op": "advance", "ms": 11 * 60 * 1000},
    {"op": "inboxValue"}, {"op": "search", "query": "parser"}, {"op": "sendStatus", "id": "cm-6"},
    {"op": "snapshot"},
    {"op": "crash"}, {"op": "open"}, {"op": "search", "query": "parser"}, {"op": "allMessages", "marks": True}, {"op": "snapshot"}]})
T.append({"name": "failures-and-retry", "start": START, "seed": seed, "steps": [
    {"op": "open"},
    {"op": "update", "chats": [1], "change": {"kind": "append", "messages": [m(12, 1, "user", "Will fail to save", clientMessageId="cm-12")]}},
    {"op": "block"}, {"op": "advance", "ms": 300},
    {"op": "update", "chats": [1], "persist": False, "change": {"kind": "edit", "id": 12, "patch": {"body": "Transient edit"}}},
    {"op": "advance", "ms": 300},
    {"op": "flush"},
    {"op": "unblock"}, {"op": "retry"},
    {"op": "update", "chats": [1], "persist": False, "change": {"kind": "field", "key": "next_id", "value": 13}},
    {"op": "close"},
    {"op": "open"}, {"op": "sendStatus", "id": "cm-12"}, {"op": "snapshot"}]})
T.append({"name": "debounce-and-crash", "start": START, "seed": seed, "steps": [
    {"op": "open"},
    {"op": "update", "chats": [1], "change": {"kind": "append", "messages": [m(12, 1, "user", "one", clientMessageId="cm-a")]}},
    {"op": "advance", "ms": 100},
    {"op": "update", "chats": [1], "change": {"kind": "append", "messages": [m(13, 1, "user", "two", clientMessageId="cm-b")]}},
    {"op": "advance", "ms": 200},
    {"op": "update", "chats": [1], "change": {"kind": "append", "messages": [m(14, 1, "user", "three", clientMessageId="cm-c")]}},
    {"op": "advance", "ms": 100},
    {"op": "advance", "ms": 200},
    {"op": "update", "chats": [1], "change": {"kind": "append", "messages": [m(15, 1, "user", "lost in the crash", clientMessageId="cm-d")]}},
    {"op": "advance", "ms": 100},
    {"op": "crash"},
    {"op": "open"}, {"op": "sendStatus", "id": "cm-c"}, {"op": "sendStatus", "id": "cm-d"}, {"op": "snapshot"},
    {"op": "update", "chats": [1], "change": {"kind": "append", "messages": [m(15, 1, "user", "sent again", clientMessageId="cm-d")]}},
    {"op": "flush"}, {"op": "sendStatus", "id": "cm-d"}, {"op": "snapshot"}]})
T.append({"name": "unload-rules", "start": START, "seed": seed, "steps": [
    {"op": "load", "chats": [3]},
    {"op": "update", "chats": [], "change": {"kind": "edit", "id": 3, "patch": {"body": "Edited in an unloaded chat"}}},
    {"op": "update", "chats": [], "change": {"kind": "remove", "ids": [8]}},
    {"op": "advance", "ms": 300},
    {"op": "update", "chats": [], "change": {"kind": "session", "id": "4", "value": None}},
    {"op": "advance", "ms": 300},
    {"op": "whole"}, {"op": "allMessages", "marks": True},
    {"op": "update", "chats": [1], "change": {"kind": "none"}},
    {"op": "advance", "ms": 11 * 60 * 1000},
    {"op": "update", "change": {"kind": "edit", "id": 1, "patch": {"body": "Everything loaded again"}}},
    {"op": "advance", "ms": 300},
    {"op": "whole"}, {"op": "snapshot"}]})

with open("fixtures/runtime-traces.json", "w", encoding="ascii") as out:
    out.write(json.dumps(T, indent=1) + "\n")
print(len(T), "traces,", sum(len(t["steps"]) for t in T), "steps")
