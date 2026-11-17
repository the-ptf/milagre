import test from "node:test";
import assert from "node:assert/strict";
import { promptSkillParts, promptSkillAtSelection, promptSkillQuery } from "./prompt-skills.mjs";

test("skill completion queries follow the native caret and ignore code, paths and selected text", () => {
  const query = promptSkillQuery;
  assert.deepEqual(query("/", { start: 1, end: 1 }), { start: 0, end: 1, query: "" });
  assert.deepEqual(query("run /TL then", { start: 7, end: 7 }), { start: 4, end: 7, query: "tl" });
  assert.deepEqual(query("run /tldr then", { start: 7, end: 7 }), { start: 4, end: 9, query: "tl" });
  assert.deepEqual(query("run /tl. please", { start: 7, end: 7 }), { start: 4, end: 7, query: "tl" });
  assert.deepEqual(query("run /tl. please", { start: 8, end: 8 }), { start: 4, end: 7, query: "tl" });
  assert.deepEqual(query("/docs.v2.", { start: 9, end: 9 }, ["docs.v2."]), { start: 0, end: 9, query: "docs.v2." });
  assert.deepEqual(query("/plugin:", { start: 8, end: 8 }, ["plugin:review-code"]), { start: 0, end: 8, query: "plugin:" });
  assert.deepEqual(query("/docs.", { start: 6, end: 6 }, ["docs.v2"]), { start: 0, end: 6, query: "docs." });
  for (const draft of ["https://host/tl", "/tl/file", "/tl?mode=compact", "` /tl `", "run `echo /tl", "``echo ` /tl ``", "```\n/tl", "~~~\n/tl"]) {
    const caret = draft.indexOf("/tl") + 3;
    assert.equal(query(draft, { start: caret, end: caret }), null, draft);
  }
  assert.equal(query("/tl", { start: 0, end: 3 }), null);
  assert.equal(query("/tl ", { start: 4, end: 4 }), null);
});

test("recognizes complete skills in prose while preserving the exact text", () => {
  const draft = "run /tldr, then\n/Plugin:review-code and /docs.v2.";
  const parts = promptSkillParts(draft, ["tldr", "plugin:review-code", "docs.v2"]);
  assert.deepEqual(
    parts.filter((part) => part.skill).map((part) => part.text),
    ["/tldr", "/Plugin:review-code", "/docs.v2"],
  );
  assert.equal(parts.map((part) => part.text).join(""), draft);
});

test("leaves partial skills, unknown commands, code and URLs unrecognized", () => {
  const draft =
    "/tl /tldr-extra /unknown https://host/tldr /tldr/file /tldr.md /tldr?mode=compact /tldr#section @/tldr ` /tldr `\n```\n/tldr\n```\n~~~\n/tldr\n~~~";
  assert.deepEqual(promptSkillParts(draft, ["tldr"]), [{ text: draft, skill: false }]);
  assert.deepEqual(promptSkillParts("", ["tldr"]), []);
});

test("prefers a literal catalog name over stripping sentence punctuation", () => {
  assert.deepEqual(
    promptSkillParts("/docs.v2. /tldr?", ["docs.v2.", "tldr"])
      .filter((part) => part.skill)
      .map((part) => part.text),
    ["/docs.v2.", "/tldr"],
  );
});

test("selects the skill at a native UTF-16 caret or range contained within the command", () => {
  const parts = promptSkillParts("🙂 use /tldr please", ["tldr"]);
  assert.equal(promptSkillAtSelection(parts, { start: 9, end: 9 }), "tldr");
  assert.equal(promptSkillAtSelection(parts, { start: 12, end: 12 }), "tldr");
  assert.equal(promptSkillAtSelection(parts, { start: 15, end: 15 }), null);
  assert.equal(promptSkillAtSelection(parts, { start: 7, end: 12 }), "tldr");
  assert.equal(promptSkillAtSelection(parts, { start: 3, end: 12 }), null);
});
