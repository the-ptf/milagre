import assert from "node:assert/strict";
import test from "node:test";
import { createDesignDraftCache, type DesignDraft } from "./design-draft-cache.ts";

function draft(text = "saved"): DesignDraft {
  const document = { schemaVersion: 1 as const, width: 390, height: 844, nodes: [{ id: "text", type: "text" as const, width: 100, height: 40, text }] };
  return {
    saved: {
      id: "design",
      title: "Design",
      version: 1,
      latest: 1,
      versions: 1,
      format: "design",
      width: 390,
      height: 844,
      document,
      html: "large rendered HTML",
    },
    history: { past: [], present: document, future: [] },
    selection: ["text"],
    fields: [[JSON.stringify(["text", "Text"]), { base: text, value: "still typing" }]],
  };
}

test("draft recovery scopes by host, Chat and design and clears explicitly", () => {
  const cache = createDesignDraftCache();
  cache.save("remote|chat#1/design", draft());
  assert.equal(cache.read("remote|chat#1/design")?.fields[0]?.[1].value, "still typing");
  assert.equal(cache.read("chat#1/design"), undefined);
  assert.equal(cache.read("remote|chat#1/design")?.saved.html, "", "regenerated preview HTML is not retained");
  cache.delete("remote|chat#1/design");
  assert.equal(cache.read("remote|chat#1/design"), undefined);
});

test("draft recovery bounds entries and trims history without mutating the editor", () => {
  const value = draft("a".repeat(100));
  value.history.past = Array.from({ length: 20 }, () => value.history.present);
  const cache = createDesignDraftCache(3000, 2);
  cache.save("one", value);
  assert.ok(cache.read("one")!.history.past.length < 20);
  assert.equal(value.history.past.length, 20);
  const entries = createDesignDraftCache(16000, 2);
  entries.save("one", draft());
  entries.save("two", draft());
  entries.save("three", draft());
  assert.equal(entries.read("one"), undefined);
  assert.ok(entries.read("two"));
  assert.ok(entries.read("three"));
});

test("Load latest recovery keeps its document and Undo history within the shared cache budget", () => {
  const value = draft("latest");
  const earlier = draft("my earlier draft");
  value.fields = [];
  value.recovery = { saved: earlier.saved, history: { ...earlier.history, past: [draft("before edit").history.present] } };
  const cache = createDesignDraftCache();
  cache.save("design", value);
  assert.equal(cache.read("design")?.recovery?.history.present.nodes[0].text, "my earlier draft");
  assert.equal(cache.read("design")?.recovery?.history.past[0].nodes[0].text, "before edit");
  assert.equal(cache.read("design")?.recovery?.saved.html, "");
  value.recovery.history.past = Array.from({ length: 100 }, () => earlier.history.present);
  const bounded = createDesignDraftCache(6000);
  bounded.save("design", value);
  assert.ok(bounded.read("design")!.recovery!.history.past.length < 100);
  assert.equal(value.recovery.history.past.length, 100, "cache trimming cannot mutate the editor recovery");
  assert.ok(JSON.stringify(bounded.read("design")).length * 2 <= 6000);
  const tooLarge = createDesignDraftCache(1000);
  tooLarge.save("design", value);
  assert.equal(tooLarge.read("design"), undefined, "recovery documents count towards the byte limit");
});
