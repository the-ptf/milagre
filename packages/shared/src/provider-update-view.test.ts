import test from "node:test";
import assert from "node:assert/strict";
import { downloadPercent, installedLine, progressLine, updatePill, type ProviderUpdateItem } from "./provider-update-view.ts";

const codex: ProviderUpdateItem = { provider: "codex", installedVersion: "0.170.0", version: "0.171.0", channel: "homebrew-cask", status: "available" };
const claude: ProviderUpdateItem = { provider: "claude", installedVersion: "2.1.300", version: "2.1.311", channel: "installer", status: "available" };

test("the pill names a single update, counts several, and counts Milagre's own update with them", () => {
  assert.deepEqual(updatePill([codex]), { kind: "available", providers: ["codex"], label: "Codex 0.171.0" });
  assert.equal(updatePill([claude, codex])?.label, "2 updates");
  assert.equal(updatePill([codex], 1)?.label, "2 updates");
  assert.equal(updatePill([]), null);
});

test("the pill follows an install: percent while downloading, installing after, then failed or installed", () => {
  const downloading = { ...codex, status: "updating" as const, progress: { phase: "download" as const, received: 42, total: 100 } };
  assert.deepEqual(updatePill([downloading, claude]), { kind: "updating", provider: "codex", label: "Updating Codex", percent: 42 });
  const installing = { ...codex, status: "updating" as const, progress: { phase: "install" as const } };
  assert.deepEqual(updatePill([installing]), { kind: "updating", provider: "codex", label: "Installing Codex…", percent: null });
  assert.equal(updatePill([{ ...codex, status: "failed" }])?.label, "Codex update failed");
  assert.equal(updatePill([{ ...codex, status: "done" }])?.label, "Codex 0.171.0 installed");
  assert.equal(
    updatePill([
      { ...codex, status: "done" },
      { ...claude, status: "done" },
    ])?.label,
    "2 updates installed",
  );
});

test("progress reads in whole percent and megabytes, and installing has no percent", () => {
  assert.equal(downloadPercent({ phase: "download", received: 999, total: 1000 }), 99);
  assert.equal(downloadPercent({ phase: "download", received: 5, total: 0 }), null);
  assert.equal(downloadPercent({ phase: "install" }), null);
  assert.equal(progressLine({ phase: "download", received: 14_200_000, total: 38_400_000 }), "Downloading · 14.2 of 38.4 MB");
  assert.equal(progressLine(undefined), "Installing…");
});

test("the card says the version you have and how it was installed", () => {
  assert.equal(installedLine(codex), "You have 0.170.0, installed with Homebrew.");
  assert.equal(installedLine({ ...codex, channel: "other" }, "Studio"), "You have 0.170.0 on Studio.");
});
