const assert = require("node:assert/strict");
const { test } = require("node:test");
const { announcement, announce, DESCRIPTION_LIMIT } = require("./announce-release.cjs");

const URL = "https://github.com/the-ptf/milagre/releases/tag/v0.233.0-beta.1";
const NOTES = [
  "Changes since v0.232.0.",
  "",
  "### New",
  "",
  "- **settings:** Find any setting from ⌘K ([#967](https://github.com/the-ptf/milagre/pull/967))",
  "",
  "### Fixes",
  "",
  "- **sidebar:** Pins belong to the device that made them ([#970](https://github.com/the-ptf/milagre/pull/970))",
].join("\n");

function discord(...answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, payload: JSON.parse(init.body) });
    const [status, body = ""] = answers.shift();
    return { status, ok: status >= 200 && status < 300, text: async () => body };
  };
  return { calls, fetchImpl };
}

test("a release posts its notes as one embed that links to the release and pings nobody", async () => {
  const { calls, fetchImpl } = discord([204]);
  await announce({ tagName: "v0.233.0-beta.1", url: URL, body: NOTES, isPrerelease: true }, "https://discord.test/hook", fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://discord.test/hook?wait=true");
  const { embeds, allowed_mentions: mentions } = calls[0].payload;
  assert.deepEqual(mentions, { parse: [] });
  assert.equal(embeds[0].title, "Nova versão beta do Milagre: v0.233.0-beta.1");
  assert.equal(embeds[0].url, URL);
  assert.match(embeds[0].description, /^Changes since v0\.232\.0\.\n\n\*\*New\*\*\n/);
  assert.match(embeds[0].description, /\*\*Fixes\*\*/);
  assert.doesNotMatch(embeds[0].description, /###/);
});

test("a stable release is announced without the beta label", () => {
  assert.equal(announcement({ tagName: "v0.233.0", url: URL, body: NOTES, isPrerelease: false }).title, "Nova versão do Milagre: v0.233.0");
});

test("long notes stop at a whole line within Discord's limit and link to the rest", () => {
  const body = Array.from({ length: 400 }, (_, index) => `- change ${index} with a description long enough to add up`).join("\n");
  const { description } = announcement({ tagName: "v0.233.0", url: URL, body, isPrerelease: false });
  assert.ok(description.length <= DESCRIPTION_LIMIT, `${description.length} characters`);
  assert.ok(description.endsWith(`\n\n[Ver todas as mudanças](${URL})`));
  const lines = description.split("\n\n[Ver")[0].split("\n");
  assert.match(lines.at(-1), /^- change \d+ with a description long enough to add up$/);
});

test("a forum channel gets the announcement as a new post named after the release", async () => {
  const { calls, fetchImpl } = discord(
    [400, JSON.stringify({ code: 220001, message: "Webhooks posted to forum channels must have a thread_name or thread_id" })],
    [204],
  );
  await announce({ tagName: "v0.233.0", url: URL, body: NOTES, isPrerelease: false }, "https://discord.test/hook", fetchImpl);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].payload.thread_name, undefined);
  assert.equal(calls[1].url, "https://discord.test/hook?wait=true");
  assert.equal(calls[1].payload.thread_name, "Nova versão do Milagre: v0.233.0");
});

test("any other rejection fails with Discord's answer and is not retried", async () => {
  const { calls, fetchImpl } = discord([404, JSON.stringify({ code: 10015, message: "Unknown Webhook" })]);
  await assert.rejects(
    announce({ tagName: "v0.233.0", url: URL, body: NOTES, isPrerelease: false }, "https://discord.test/hook", fetchImpl),
    /Discord answered 404: .*Unknown Webhook/,
  );
  assert.equal(calls.length, 1);
});

test("existing webhook query parameters are kept next to wait=true", async () => {
  const { calls, fetchImpl } = discord([200]);
  await announce({ tagName: "v0.233.0", url: URL, body: NOTES, isPrerelease: false }, "https://discord.test/hook?thread_id=42", fetchImpl);
  assert.equal(calls[0].url, "https://discord.test/hook?thread_id=42&wait=true");
});
