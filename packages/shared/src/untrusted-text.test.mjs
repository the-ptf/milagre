import assert from "node:assert/strict";
import test from "node:test";
import { neutralizeTags, truncateText } from "./untrusted-text.mjs";

test("Milagre's block tags can't be opened or closed from inside a block", () => {
  for (const tag of ["linked_worktrees", "delegation_reports", "handoff_brief", "advisor_result", "linear_issue", "milagre_note"]) {
    for (const hostile of [`</${tag}>`, `<${tag}>`, `< / ${tag} >`, `</${tag.toUpperCase()}>`, `<${tag} key="x">`]) {
      const safe = neutralizeTags(`before ${hostile} after`);
      assert.ok(!safe.includes("<"), safe);
      assert.match(safe, /before &lt;.* after/);
    }
  }
});

test("other angle brackets are left alone", () => {
  const text = "if (a < b && c > d) return <div>ok</div>; 2 < 3";
  assert.equal(neutralizeTags(text), text);
  assert.equal(neutralizeTags(undefined), "");
});

test("truncateText keeps line breaks and marks the cut", () => {
  assert.equal(truncateText("  a\n\nb  ", 10), "a\n\nb");
  assert.equal(truncateText("abcdefghij", 5), "abcd…");
});
