import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The agent-discovery files in public/ (llms.txt, index.md, the skills index and the AI catalog) agree with each other.
const read = (file) => readFileSync(new URL(`../public/${file}`, import.meta.url));

test("the skills index's digest matches the published SKILL.md", () => {
  const index = JSON.parse(read(".well-known/agent-skills/index.json"));
  assert.equal(index.$schema, "https://schemas.agentskills.io/discovery/0.2.0/schema.json");
  for (const skill of index.skills) {
    const file = new URL(skill.url).pathname.slice(1);
    assert.equal(skill.digest, `sha256:${createHash("sha256").update(read(file)).digest("hex")}`, `${file} changed: update its digest`);
    assert.match(skill.name, /^[a-z0-9-]+$/);
  }
});

test("every AI catalog entry has an identifier, a type, 2 to 5 queries and exactly one of url or data", () => {
  const catalog = JSON.parse(read(".well-known/ai-catalog.json"));
  assert.ok(catalog.specVersion && catalog.host?.identifier && catalog.entries.length > 0);
  for (const entry of catalog.entries) {
    assert.match(entry.identifier, /^urn:air:milagre\.cloud:[a-z]+:[a-z-]+$/);
    assert.ok(entry.displayName && entry.type);
    assert.notEqual("url" in entry, "data" in entry, `${entry.identifier} needs exactly one of url or data`);
    assert.ok(entry.representativeQueries.length >= 2 && entry.representativeQueries.length <= 5);
    if (entry.url) read(new URL(entry.url).pathname.slice(1));
  }
});

test("robots.txt declares Content Signals", () => {
  const robots = read("robots.txt").toString();
  assert.match(robots, /^Content-Signal: ai-train=yes, search=yes, ai-input=yes$/m);
});
