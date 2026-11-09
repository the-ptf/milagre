import assert from "node:assert/strict";
import test from "node:test";
import { COMPACT_LINE_HEIGHT, composerLayout, type CompactOverflow } from "./composer-layout.ts";

/**
 * PromptComposer's layout effect, run the way React runs it: once per commit, and again whenever it changes the
 * layout. `lineWidth` is the width the compact prompt lays the draft out at; `estimate` is the canvas measurement.
 * Returns the layouts it went through, stopping at 60 as React does at its nested-update limit.
 */
function settle({
  draft,
  width,
  lineWidth,
  estimate,
  start = { expanded: false, overflow: null as CompactOverflow },
}: {
  draft: string;
  width: number;
  lineWidth: number;
  estimate: number;
  start?: { expanded: boolean; overflow: CompactOverflow };
}) {
  let { expanded, overflow } = start;
  const layouts = [expanded];
  for (let commit = 0; commit < 60; commit++) {
    const contentHeight = !expanded && lineWidth + 8 > width ? COMPACT_LINE_HEIGHT + 18 : COMPACT_LINE_HEIGHT;
    const next = composerLayout({ draft, expanded, alwaysExpanded: false, contentHeight, compactWidth: width, overflow, measure: () => estimate });
    overflow = next.overflow;
    if (next.expanded === expanded) break;
    expanded = next.expanded;
    layouts.push(expanded);
  }
  return { layouts, expanded, overflow };
}

test("a draft the compact prompt wraps stays tall even when the estimate says it fits", () => {
  // The macOS CI runner's window crashed with React error #185 here: the compact prompt wrapped the draft, the canvas
  // estimate said it fit, and the layout flipped on every commit.
  const result = settle({ draft: "Keep this unsent draft", width: 140, lineWidth: 136, estimate: 120 });
  assert.deepEqual(result.layouts, [false, true]);
  assert.deepEqual(result.overflow, { draft: "Keep this unsent draft", width: 140 });
});

test("typing more onto a wrapped draft keeps the tall layout without measuring", () => {
  const start = settle({ draft: "Keep this", width: 140, lineWidth: 150, estimate: 60 });
  const next = composerLayout({
    draft: "Keep this unsent draft",
    expanded: true,
    alwaysExpanded: false,
    contentHeight: 68,
    compactWidth: 140,
    overflow: start.overflow,
    measure: () => assert.fail("a longer draft than one that wrapped can't fit"),
  });
  assert.equal(next.expanded, true);
});

test("the tall layout collapses once the draft is shortened, deleted or the prompt widens", () => {
  const tall = { expanded: true, overflow: { draft: "Keep this unsent draft", width: 140 } };
  // Shortened: the estimate decides again, and the compact layout confirms it.
  assert.deepEqual(settle({ draft: "Keep", width: 140, lineWidth: 30, estimate: 30, start: tall }).layouts, [true, false]);
  // Deleted.
  assert.deepEqual(settle({ draft: "", width: 140, lineWidth: 0, estimate: 0, start: tall }).layouts, [true, false]);
  // The same draft in a wider prompt.
  assert.deepEqual(settle({ draft: "Keep this unsent draft", width: 400, lineWidth: 136, estimate: 134, start: tall }).layouts, [true, false]);
});

test("a wider prompt that still wraps the draft settles tall after one try", () => {
  const tall = { expanded: true, overflow: { draft: "Keep this unsent draft", width: 140 } };
  const result = settle({ draft: "Keep this unsent draft", width: 150, lineWidth: 146, estimate: 120, start: tall });
  assert.deepEqual(result.layouts, [true, false, true]);
});

test("new chats, line breaks and long drafts are always tall; an empty draft never expands", () => {
  const base = { expanded: false, contentHeight: 46, compactWidth: 400, overflow: null, measure: () => 10 };
  assert.equal(composerLayout({ ...base, draft: "", alwaysExpanded: true }).expanded, true);
  assert.equal(composerLayout({ ...base, draft: "a\nb", alwaysExpanded: false }).expanded, true);
  assert.equal(composerLayout({ ...base, draft: "", alwaysExpanded: false }).expanded, false);
  assert.equal(composerLayout({ ...base, expanded: true, draft: "x".repeat(201), alwaysExpanded: false }).expanded, true);
  // Without a measurement the compact layout gets the next say, as before.
  assert.equal(composerLayout({ ...base, expanded: true, draft: "short", alwaysExpanded: false, measure: () => null }).expanded, false);
});
