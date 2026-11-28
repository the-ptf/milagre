import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDotenv, secretFlags, secretHint, secretNameProblem, secretReaches, secretRedactor, secretScopeText } from "./secrets.mjs";

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

test("scope text and flags read the same on desktop and phone", () => {
  assert.equal(secretScopeText("all"), "All Projects");
  assert.equal(secretScopeText(["github.com/a/b"]), "github.com/a/b");
  assert.equal(secretScopeText(["github.com/a/b", "github.com/a/c"]), "2 Projects");
  assert.deepEqual(secretFlags({ delivery: "ambient", askEachUse: true, unattended: false }), ["In environment", "Asks each use"]);
  assert.deepEqual(secretFlags({ delivery: "on-demand", askEachUse: false, unattended: true }), ["Unattended runs"]);
});

test("redaction also matches URL-encoded, JSON-escaped, hex and base64url forms", () => {
  const value = 'p@ss/w+rd "quoted"';
  const redact = secretRedactor([{ name: "PASS", value }]);
  for (const form of [
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
    Buffer.from(value).toString("hex"),
    Buffer.from(value).toString("base64url"),
  ])
    assert.equal(redact(`x ${form} y`), "x [secret PASS] y", form);
});

test("browser exports become logins by their headers, and a login's name is stable and valid", async () => {
  const { loginName, parseLoginCsv } = await import("./secrets.mjs");
  const chrome = 'name,url,username,password,note\ngithub.com,https://github.com/login,octo,"pa,ss""1",work\nbad,not a url,x,y,\nempty,https://a.com,u,,\n';
  assert.deepEqual(parseLoginCsv(chrome), {
    logins: [{ line: 2, origin: "https://github.com", username: "octo", password: 'pa,ss"1', note: "work" }],
    skipped: [
      { row: 3, site: "not a url", reason: "The address isn't a web address." },
      { row: 4, site: "https://a.com", reason: "No password." },
    ],
  });
  assert.throws(() => parseLoginCsv('url,password\nhttps://a.com,"open\nhttps://b.com,x\n'), /never closes/);
  assert.throws(() => parseLoginCsv("name,secret\na,b\n"), /isn't a passwords export/);
  assert.throws(() => parseLoginCsv(""), /empty/);
  const multiline = 'url,password,note\n\nhttps://a.com,x-123456,"two\nlines"\n\nnot a url,y,\n';
  assert.deepEqual(
    parseLoginCsv(multiline).skipped,
    [{ row: 6, site: "not a url", reason: "The address isn't a web address." }],
    "lines count as the file has them",
  );
  assert.equal(parseLoginCsv(multiline).logins[0].line, 3);
  const exact = 'url,password\r\nhttps://a.com,"cr\rcrlf\r\nlf\nend"\r\nnot a url,y\r\n';
  assert.equal(parseLoginCsv(exact).logins[0].password, "cr\rcrlf\r\nlf\nend", "a quoted password keeps every character");
  assert.deepEqual(
    parseLoginCsv(exact).skipped.map((entry) => entry.row),
    [6],
  );
  const safari = "Title,URL,Username,Password,Notes,OTPAuth\r\nVercel,https://vercel.com/,me@x.com,secret-pass,,otpauth://x\r\n";
  assert.deepEqual(parseLoginCsv(safari).logins, [{ line: 2, origin: "https://vercel.com", username: "me@x.com", password: "secret-pass", note: null }]);
  const name = loginName("https://github.com", "octo");
  assert.match(name, /^LOGIN_GITHUB_COM_[0-9A-F]{6}$/);
  assert.equal(secretNameProblem(name), null);
  assert.equal(loginName("https://github.com", "octo"), name);
  assert.notEqual(loginName("https://github.com", "other"), name);
});

test("parseDotenv drops quotes before a trailing comment and reads escaped backslashes", () => {
  const text = ['A="abc def" # note', "B='x y' # c", 'C="a\\\\nb"', 'D="a\\nb"', 'E="say \\"hi\\"" # c', 'F="a # b"'].join("\n");
  assert.deepEqual(parseDotenv(text), [
    { name: "A", value: "abc def" },
    { name: "B", value: "x y" },
    { name: "C", value: "a\\nb" },
    { name: "D", value: "a\nb" },
    { name: "E", value: 'say "hi"' },
    { name: "F", value: "a # b" },
  ]);
});
