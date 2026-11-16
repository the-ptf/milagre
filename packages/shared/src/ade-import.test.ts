import assert from "node:assert/strict";
import test from "node:test";
import { defaultSelection, foundLine, importSummary, type ImportScan } from "./ade-import.ts";

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
  assert.deepEqual(foundLine(scan), { title: "Bring your work from T3 Code", detail: "1 Project, 2 Chats" });
  assert.deepEqual(defaultSelection(scan), { projects: ["t3code:/code/acme-web"], threads: ["open"] });
});

test("the toast names the Project and groups what stayed behind by reason", () => {
  const project = { path: "/code/acme-web", name: "acme-web", source: "t3code" as const };
  const skipped = (reason: string) => ({ title: "x", reason, message: "" });
  assert.equal(importSummary({ projects: [project], chats: 2, skipped: [] }), "Imported 2 Chats into acme-web.");
  assert.equal(
    importSummary({ projects: [project], chats: 0, skipped: [skipped("no-transcript"), skipped("no-transcript")] }),
    "Imported acme-web. 2 Chats stayed behind: their conversation isn't on this computer.",
  );
  assert.equal(
    importSummary({ projects: [project, { ...project, path: "/b", name: "b" }], chats: 1, skipped: [skipped("unsupported")] }),
    "Imported 1 Chat into 2 Projects. 1 Chat stayed behind: Milagre doesn't run their agent.",
  );
  assert.equal(importSummary({ projects: [], chats: 0, skipped: [] }), "Nothing new to import.");
});
