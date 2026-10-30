import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const require = createRequire(import.meta.url);

test("provider names distinguish product and CLI while retaining picker order", async () => {
  const { PROVIDERS, providerName, cliName } = await import("./providers.mjs");
  assert.deepEqual(PROVIDERS, ["codex", "claude", "antigravity", "kiro"]);
  assert.equal(providerName("claude"), "Claude");
  assert.equal(cliName("claude"), "Claude Code");
  assert.equal(providerName("codex"), cliName("codex"));
  assert.equal(providerName("antigravity"), "Antigravity");
  assert.equal(cliName("antigravity"), "Antigravity");
  assert.equal(providerName("kiro"), "Kiro");
  assert.equal(cliName("kiro"), "Kiro CLI");
});
test("image limits and invalid image messages come from one contract", async () => {
  const { MAX_ATTACHMENT_BYTES, IMAGE_TYPES, IMAGE_ERRORS } = await import("./limits.mjs");
  const { decodeImages } = require("../../core/src/image-input.cjs");
  assert.equal(MAX_ATTACHMENT_BYTES, 50 * 1024 * 1024);
  assert.deepEqual(IMAGE_TYPES, ["image/png", "image/jpeg", "image/webp", "image/gif"]);
  for (const [images, expected] of [
    [[{ dataUrl: "data:image/svg+xml;base64,AAAA" }], IMAGE_ERRORS.type],
    [[{}], IMAGE_ERRORS.size],
  ]) {
    assert.throws(() => decodeImages(images), { message: expected });
  }
});
test("IPC failures lose only the Electron wrapper and retain code details", async () => {
  const { ipcErrorMessage, ipcErrorCode } = await import("./result.mjs");
  assert.equal(ipcErrorMessage(new Error("Error invoking remote method 'chat:patch': Error: disk full")), "disk full");
  assert.equal(ipcErrorMessage("plain"), "plain");
  assert.equal(ipcErrorMessage({ code: "EDITOR_OPEN", message: "Unavailable" }), "Unavailable");
  assert.equal(ipcErrorCode(new Error("Error invoking remote method 'worktree:remove': Error: WORKTREE_CHANGED")), "WORKTREE_CHANGED");
  assert.equal(ipcErrorCode(new Error("not WORKTREE_CHANGED text")), undefined);
  assert.equal(ipcErrorCode(new Error("Error invoking remote method 'worktree:remove': Error: WORKTREE_CHANGED: /tmp/project changed")), "WORKTREE_CHANGED");
  assert.equal(ipcErrorCode({ code: "WORKTREE_CHANGED" }), "WORKTREE_CHANGED");
});
test("core and clients share exactly the same terminal predicate", async () => {
  const { isTurnEnd } = await import("./agent-runs.mjs");
  assert.equal(require("../../core/src/agents/events.cjs").isTerminal, isTurnEnd);
});
test("provider labels and Electron error wrappers have one owner", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const offenders: string[] = [];
  for (const dir of ["packages/core/src", "packages/shared/src", "apps/desktop/app/src", "apps/desktop/electron", "apps/mobile/src"]) {
    for (const name of readdirSync(resolve(root, dir), { recursive: true })) {
      if (!/\.(cjs|mjs|tsx?|mts)$/.test(String(name)) || /\.test\.|\.d\.|providers\.mjs|result\.mjs/.test(String(name))) continue;
      const path = resolve(root, dir, String(name));
      const text = readFileSync(path, "utf8");
      if (/===\s*["']codex["']\s*\?\s*["'](?:Codex|Claude)/.test(text) || /Error invoking remote method/.test(text)) offenders.push(path.slice(root.length));
    }
  }
  assert.deepEqual(offenders, []);
});

test("the wire model contains no presentation catalog or obsolete spec types", () => {
  const model = readFileSync(new URL("./model.ts", import.meta.url), "utf8");
  assert.doesNotMatch(model, /MODEL_CATALOG|EFFORT_COPY|PERMISSION_MODES|interface Connection|interface Event/);
});
