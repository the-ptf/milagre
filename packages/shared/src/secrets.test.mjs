import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDotenv, secretHint, secretNameProblem, secretReaches, secretRedactor } from "./secrets.mjs";

test("names are env-style and refuse what changes how programs, Git or agents run", () => {
  for (const name of ["ASC_KEY_ID", "VERCEL_TOKEN", "A", "X1_2"]) assert.equal(secretNameProblem(name), null, name);
  for (const name of ["", "lower", "1ABC", "A-B", "A".repeat(65), 5, null]) assert.match(secretNameProblem(name), /capital letters/);
  for (const name of [
    "PATH",
    "NODE_OPTIONS",
    "DYLD_INSERT_LIBRARIES",
    "LD_PRELOAD",
    "GIT_SSH_COMMAND",
    "SSH_AUTH_SOCK",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "CLAUDE_CONFIG_DIR",
    "MILAGRE_SECRETS_URL",
    "MY_BASE_URL",
    "HTTPS_PROXY",
    "NPM_CONFIG_PREFIX",
  ])
    assert.match(secretNameProblem(name), /reserved/, name);
});

test("hints show the last four characters of long values only", () => {
  assert.equal(secretHint("sk-live-abcdefgh7QK2"), "7QK2");
  assert.equal(secretHint("short-value"), null);
  assert.equal(secretHint(undefined), null);
});

test("a secret reaches its Projects, and unattended runs only with consent", () => {
  const scoped = { name: "A", projects: ["github.com/a/b"], unattended: false };
  assert.equal(secretReaches(scoped, { origin: "github.com/a/b" }), true);
  assert.equal(secretReaches(scoped, { origin: "github.com/a/c" }), false);
  assert.equal(secretReaches(scoped, { origin: null }), false);
  assert.equal(secretReaches(scoped, { origin: "github.com/a/b", unattended: true }), false);
  assert.equal(secretReaches({ ...scoped, unattended: true }, { origin: "github.com/a/b", unattended: true }), true);
  assert.equal(secretReaches({ name: "B", projects: "all" }, { origin: null }), true);
});

test(".env files: comments, export, quotes and inline comments", () => {
  const text = ["# keys", "export ASC_KEY_ID=ABC123", 'NOTE="two\\nlines"', "SINGLE='a # b'", "BARE=value # comment", "", "not a line", "EMPTY="].join("\n");
  assert.deepEqual(parseDotenv(text), [
    { name: "ASC_KEY_ID", value: "ABC123" },
    { name: "NOTE", value: "two\nlines" },
    { name: "SINGLE", value: "a # b" },
    { name: "BARE", value: "value" },
    { name: "EMPTY", value: "" },
  ]);
});

test("redaction replaces values, file lines and base64 forms, longest first", () => {
  const redact = secretRedactor([
    { name: "TOKEN", value: "supersecret-123" },
    { name: "SHORT", value: "abc" },
    { name: "KEY", kind: "file", value: "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49\n-----END PRIVATE KEY-----" },
  ]);
  assert.equal(redact("token=supersecret-123 done"), "token=[secret TOKEN] done");
  assert.equal(redact("abc stays"), "abc stays");
  assert.equal(redact("line MIGTAgEAMBMGByqGSM49 leaked"), "line [secret KEY] leaked");
  assert.equal(redact(`b64 ${Buffer.from("supersecret-123").toString("base64").replace(/=+$/, "")}`), "b64 [secret TOKEN]");
  assert.equal(secretRedactor([])("anything at all"), "anything at all");
});

test("pending counts the trailing characters that could begin a secret", () => {
  const redact = secretRedactor([{ name: "TOKEN", value: "supersecret-123" }]);
  assert.equal(redact.pending("export TOKEN=supers"), 6);
  assert.equal(redact.pending("no match here"), 0);
  assert.equal(redact.pending("ends with s"), 1);
  assert.equal(secretRedactor([]).pending("anything"), 0);
});
