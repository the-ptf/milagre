import assert from "node:assert/strict";
import test from "node:test";
import { linkSheetActions } from "./reply-link-actions.ts";

const titles = (...args: Parameters<typeof linkSheetActions>) => linkSheetActions(...args).map((action) => action.title);

test("a web link's sheet offers Code review only for a known PR and the Browser panel only when it is on", () => {
  assert.deepEqual(titles({ kind: "web", review: true, panel: true }, "ios"), [
    "Open in Code review",
    "Open in Browser panel",
    "Open in Safari",
    "Copy link",
    "Share…",
  ]);
  assert.deepEqual(titles({ kind: "web", review: false, panel: false }, "android"), ["Open in browser", "Copy link", "Share…"]);
});

test("a file link's sheet previews it or copies its path", () => {
  assert.deepEqual(titles({ kind: "file" }, "ios"), ["Preview", "Copy path"]);
});
