import assert from "node:assert/strict";
import test from "node:test";
import { clearDesignMessages, designMessageSent, peekDesignMessage, postDesignMessage } from "./design-outbox.ts";

test("a Chat keeps every feedback batch handed over, in order, until each one went", () => {
  const recorded: string[] = [];
  const batch = (name: string, kind?: "designs" | "artifacts") => ({ text: name, kind, onSent: () => recorded.push(name) });
  const first = batch("first");
  const second = batch("second");
  postDesignMessage("mac|/p#1", first);
  postDesignMessage("mac|/p#1", second);
  assert.equal(peekDesignMessage("mac|/p#1"), first);
  designMessageSent("mac|/p#1", first);
  assert.deepEqual(recorded, ["first"]);
  assert.equal(peekDesignMessage("mac|/p#1"), second, "the later batch still waits");
  designMessageSent("mac|/p#1", first);
  assert.deepEqual(recorded, ["first"], "a batch is recorded once");
  designMessageSent("mac|/p#1", second);
  assert.equal(peekDesignMessage("mac|/p#1"), null);
  assert.deepEqual(recorded, ["first", "second"]);
});

test("turning Designs off drops that computer's design batches and keeps Artifact feedback", () => {
  const design = { text: "design", kind: "designs" as const, onSent: () => {} };
  const page = { text: "page", kind: "artifacts" as const, onSent: () => {} };
  const other = { text: "other", kind: "designs" as const, onSent: () => {} };
  postDesignMessage("mac|/p#2", design);
  postDesignMessage("mac|/p#2", page);
  postDesignMessage("studio|/p#2", other);
  clearDesignMessages("mac");
  assert.equal(peekDesignMessage("mac|/p#2"), page);
  assert.equal(peekDesignMessage("studio|/p#2"), other);
});
