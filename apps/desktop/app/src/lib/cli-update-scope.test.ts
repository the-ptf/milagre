import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

test("CLI update completion refreshes the current scope and ignores unscoped status", async () => {
  const source = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("  const updateCli = async"), source.indexOf("  // Every finished message card"));
  let finish!: (value: unknown) => void;
  const updating = new Promise((resolve) => {
    finish = resolve;
  });
  const refreshed: string[] = [];
  const written: unknown[] = [];
  // Every scope's cached CLI status is read again when next shown, not only the current one's.
  let staled = 0;
  const refreshCliStatus = () => refreshed.push("old-project");
  const refreshCliStatusRef = { current: refreshCliStatus };
  const update = runInNewContext(ts.transpileModule(`${body}\nupdateCli;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, {
    window: { milagre: { updateCli: () => updating } },
    setUpdatingCli: () => {},
    setNotice: () => {},
    cliName: () => "Codex",
    setCliStatus: (value: unknown) => written.push(value),
    refreshCliStatus,
    refreshCliStatusRef,
    staleProviders: () => staled++,
  });
  const pending = update("codex");
  refreshCliStatusRef.current = () => refreshed.push("new-project");
  finish({ ok: true, status: { state: "signed-out" } });
  await pending;
  assert.deepEqual(refreshed, ["new-project"]);
  assert.deepEqual(written, []);
  assert.equal(staled, 1);
});
