import assert from "node:assert/strict";
import test from "node:test";
import { matchesProjectQuery } from "./project-list.ts";

test("a Project matches when every word of the query is in its name or path, ignoring case", () => {
  const texts = ["rd-food-apps", "/Users/victor/Code/rd/rd-food-apps"];
  assert.equal(matchesProjectQuery("", texts), true);
  assert.equal(matchesProjectQuery("   ", texts), true);
  assert.equal(matchesProjectQuery("FOOD", texts), true);
  assert.equal(matchesProjectQuery("code/rd", texts), true);
  assert.equal(matchesProjectQuery("food rd", texts), true);
  assert.equal(matchesProjectQuery("food gym", texts), false);
  assert.equal(matchesProjectQuery("happiergym", texts), false);
  assert.equal(matchesProjectQuery("apps", ["", undefined]), false);
});
