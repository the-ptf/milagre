const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createReleaseNotes } = require("./update-release-notes.cjs");

test("loads and caches Markdown for the selected release, including beta", async () => {
  const urls = [];
  const notes = createReleaseNotes({
    fetch: async (url) => {
      urls.push(url);
      return { ok: true, json: async () => ({ body: "## Fixes\n\n- Update downloads" }) };
    },
  });
  assert.match(await notes("1.2.3-beta.2"), /Update downloads/);
  await notes("1.2.3-beta.2");
  assert.deepEqual(urls, ["https://api.github.com/repos/the-ptf/milagre-ade/releases/tags/v1.2.3-beta.2"]);
  await assert.rejects(notes("../../elsewhere"), /Invalid release/);
  assert.equal(urls.length, 1);
});

test("empty notes and missing releases have an empty state; offline failures can retry", async () => {
  let status = 503;
  const notes = createReleaseNotes({ fetch: async () => ({ ok: status === 200, status, json: async () => ({ body: null }) }) });
  await assert.rejects(notes("1.2.3"), /Could not load/);
  status = 404;
  assert.equal(await notes("1.2.3"), "");
  status = 200;
  assert.equal(await notes("1.2.3"), "");
});
