import assert from "node:assert/strict";
import test from "node:test";
import { IMPORT_INTRO, defaultSelection, foundLine, importIntro, importSummary, stayedBehind, type ImportScan } from "./ade-import.ts";

const thread = (id: string, extra = {}) => ({
  id,
  title: id,
  provider: "claude" as const,
  sourceProvider: "claudeAgent",
  nativeId: id,
  cwd: null,
  branch: "main",
  archived: false,
  imported: false,
  ...extra,
});

const scan: ImportScan = {
  sources: [
    {
      id: "t3code",
      label: "T3 Code",
      found: true,
      location: null,
      projects: [
        {
          name: "acme-web",
          path: "/code/acme-web",
          exists: true,
          registered: false,
          threads: [thread("open"), thread("old", { archived: true }), thread("lost", { unsupported: "no-transcript" }), thread("done", { imported: true })],
        },
      ],
    },
  ],
};

test("the onboarding card and the default selection count only threads that can come over", () => {
  assert.deepEqual(foundLine(scan), { title: "Bring your work from T3 Code", detail: "1 Project and 1 Chat ready to import" });
  assert.deepEqual(defaultSelection(scan), { projects: ["t3code:/code/acme-web"], threads: ["open"] });
});

test("the toast is one short line naming the Project and counting what was skipped", () => {
  const project = { path: "/code/acme-web", name: "acme-web", source: "t3code" as const };
  const skipped = (reason: string) => ({ title: "x", reason, message: "" });
  assert.equal(importSummary({ projects: [project], chats: 2, skipped: [] }), "Imported 2 Chats into acme-web.");
  assert.equal(
    importSummary({ projects: [project], chats: 0, skipped: [skipped("no-transcript"), skipped("no-transcript")] }),
    "Imported acme-web. 2 skipped.",
  );
  assert.equal(
    importSummary({ projects: [project, { ...project, path: "/b", name: "b" }], chats: 1, skipped: [skipped("unsupported")] }),
    "Imported 1 Chat into 2 Projects. 1 skipped.",
  );
  assert.equal(importSummary({ projects: [], chats: 0, skipped: [] }), "Nothing new to import.");
});

test("the dialog's intro names only the apps this computer has data from", () => {
  assert.equal(importIntro(scan), "Bring Projects and ongoing Chats from T3 Code. Imported Chats keep their history and pick up the same agent conversation.");
  assert.equal(importIntro({ sources: [] }), IMPORT_INTRO);
});

test("a second import says nothing new came in instead of claiming the Projects again", () => {
  const again = {
    projects: [{ path: "/code/acme-web", name: "acme-web", source: "t3code" as const, added: false }],
    chats: 0,
    skipped: [{ title: "x", reason: "already-imported", message: "" }],
  };
  assert.equal(importSummary(again), "Nothing new to import. 1 Chat already in Milagre.");
});

test("what didn't come over lists the import's skips and the scan's unavailable threads and missing folders", () => {
  const lines = stayedBehind({ projects: [], chats: 1, skipped: [{ title: "done", reason: "already-imported", message: "Already in Milagre" }] }, scan);
  assert.deepEqual(
    lines.map((line) => line.title),
    ["lost"],
  );
});
