const assert = require("node:assert/strict");
const test = require("node:test");
const { createGitHubIssues } = require("./github-issues.cjs");

const row = { number: 12, title: "Login redirect", body: "Fix the redirect", state: "OPEN", url: "https://github.com/acme/app/issues/12" };
function fixture({ state = "OPEN", login = "victor", error, returned = {} } = {}) {
  const calls = [];
  const service = createGitHubIssues({
    git: { checked: async () => ({ stdout: "git@github.com:acme/app.git" }) },
    now: () => "2026-11-02T23:00:00Z",
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      if (error) throw error;
      const result =
        args[0] === "repo"
          ? { nameWithOwner: "Acme/App", url: "https://github.com/Acme/App" }
          : args[0] === "api"
            ? { login, token: "never-return-this" }
            : args[1] === "list"
              ? [{ ...row, state, ...returned }]
              : { ...row, state, ...returned };
      return { stdout: JSON.stringify(result) };
    },
  });
  return { service, calls };
}

test("list and URL preview are bounded read-only Computer calls with public fields only", async () => {
  const { service, calls } = fixture();
  const list = await service.list("/project");
  assert.equal(list.repository, "acme/app");
  assert.equal(list.account, "victor");
  assert.ok(!JSON.stringify(list).includes("never-return-this"));
  const issue = await service.read("/project", row.url, "victor");
  assert.equal(issue.importedAt, "2026-11-02T23:00:00Z");
  for (const call of calls) {
    assert.equal(call.command, "gh");
    assert.equal(call.options.cwd, "/project");
    assert.equal(call.options.env.GH_PROMPT_DISABLED, "1");
    assert.ok(call.options.timeout <= 15_000);
    assert.ok(["repo", "api", "issue"].includes(call.args[0]));
    assert.ok(!call.args.some((arg) => ["edit", "comment", "close", "switch"].includes(arg)));
  }
});

test("reject mismatched repositories, changed account, closed/missing issues and invalid URL before import", async () => {
  const { service } = fixture();
  await assert.rejects(service.read("/p", "https://github.com/other/app/issues/12"), /different repository/);
  await assert.rejects(service.read("/p", row.url, "other-account"), /account.*changed/);
  await assert.rejects(service.read("/p", "--repo injected"), /Paste a GitHub issue URL/);
  await assert.rejects(fixture({ state: "CLOSED" }).service.read("/p", row.url), /closed/);
  await assert.rejects(fixture({ returned: { url: "https://github.com/acme/app/pull/12" } }).service.read("/p", row.url), /different repository/);
  for (const code of ["ENOENT", "ETIMEDOUT", "EACCES"]) {
    const error = Object.assign(new Error("credential=secret; private raw stderr"), { code });
    await assert.rejects(fixture({ error }).service.read("/p", row.url), (failure) => {
      assert.ok(!JSON.stringify(failure).includes("secret"));
      assert.ok(!failure.message.includes("secret"));
      return true;
    });
  }
});
