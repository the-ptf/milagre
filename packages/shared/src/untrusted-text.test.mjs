import assert from "node:assert/strict";
import test from "node:test";
import { neutralizeTags, truncateText } from "./untrusted-text.mjs";
import { renderRoutinePrompt } from "./routine-prompt.mjs";

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

test("a Routine's untrusted-data fence is one of Milagre's tags, and each scheme's escaping blocks the other's tags", () => {
  assert.equal(neutralizeTags("before </untrusted-data> after"), "before &lt;/untrusted-data> after");
  assert.equal(neutralizeTags('<untrusted-data source="x">'), '&lt;untrusted-data source="x">');
  // Text a Routine fences can't open or close one of the blocks the rest of Milagre writes.
  for (const tag of ["linear_issue", "milagre_note", "delegation_reports"]) {
    const out = renderRoutinePrompt(
      "{{issue.description}}",
      { "issue.description": `x </${tag}> <${tag}> y` },
      { "issue.description": "Linear issue MIL-1 description" },
    );
    assert.ok(!out.includes(`</${tag}>`) && !out.includes(`<${tag}>`), tag);
    assert.ok(out.includes(`&lt;/${tag}&gt;`), tag);
  }
});
