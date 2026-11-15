import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { Client } from "./client.ts";
import { registerVisibleRunChat, visibleRunChats, watchVisibleRunChats } from "./visible-run-chats.ts";

const client = () => ({ url: "same-computer" }) as Client;
test("registrations count two panes of one Chat and isolate clients and Projects", () => {
  const a = client(),
    b = client();
  let changes = 0;
  const unwatch = watchVisibleRunChats(a, "/p", () => changes++);
  assert.deepEqual(visibleRunChats(a, "/p"), [], "with no detail reader on screen the Project's runs come as summaries only");
  const first = registerVisibleRunChat(a, "/p", 3);
  const second = registerVisibleRunChat(a, "/p", 3);
  const other = registerVisibleRunChat(a, "/p", 1);
  const otherClient = registerVisibleRunChat(b, "/p", 5);
  const otherProject = registerVisibleRunChat(a, "/q", 6);
  assert.deepEqual(visibleRunChats(a, "/p"), [1, 3]);
  assert.deepEqual(visibleRunChats(b, "/p"), [5]);
  assert.deepEqual(visibleRunChats(a, "/q"), [6]);
  assert.equal(changes, 2);
  first();
  first();
  assert.deepEqual(visibleRunChats(a, "/p"), [1, 3]);
  assert.equal(changes, 2);
  second();
  assert.deepEqual(visibleRunChats(a, "/p"), [1]);
  other();
  assert.deepEqual(visibleRunChats(a, "/p"), []);
  assert.equal(changes, 4);
  unwatch();
  otherClient();
  otherProject();
});

test("a late sync subscription catches an already mounted pane and unsubscribes", () => {
  const a = client();
  const remove = registerVisibleRunChat(a, "/p", 1);
  let changes = 0;
  const stop = watchVisibleRunChats(a, "/p", () => changes++);
  assert.equal(changes, 1);
  stop();
  remove();
  assert.equal(changes, 1);
});

test("the hook releases on hide, selection/client/Project change and unmount", () => {
  // Execute the real hook with an effect host, without importing React Native or starting an app.
  let deps: unknown[] = [],
    cleanup: (() => void) | undefined;
  const useEffect = (effect: () => (() => void) | undefined, next: unknown[]) => {
    if (next.length === deps.length && next.every((value, i) => value === deps[i])) return;
    cleanup?.();
    deps = next;
    cleanup = effect();
  };
  const source = readFileSync(new URL("./visible-run-chats.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {} as typeof import("./visible-run-chats.ts");
  new Function("exports", "require", code)(exports, (id: string) => {
    assert.equal(id, "react");
    return { useEffect };
  });
  const a = client(),
    b = client();
  const render = exports.useVisibleRunChat;
  render(a, "/p", 1, true);
  assert.deepEqual(exports.visibleRunChats(a, "/p"), [1]);
  render(a, "/p", 2, true);
  assert.deepEqual(exports.visibleRunChats(a, "/p"), [2]);
  render(a, "/q", 2, true);
  assert.deepEqual(exports.visibleRunChats(a, "/p"), []);
  render(b, "/q", 2, true);
  assert.deepEqual(exports.visibleRunChats(a, "/q"), []);
  render(b, "/q", 2, false);
  assert.deepEqual(exports.visibleRunChats(b, "/q"), []);
  render(null, undefined, undefined, true);
  render(a, "/p", 1, true);
  cleanup?.();
  assert.deepEqual(exports.visibleRunChats(a, "/p"), []);
});
