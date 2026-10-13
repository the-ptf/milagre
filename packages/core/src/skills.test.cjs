const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { discoverSkills, expandSkillPrompt, readDiscoveredSkill, skillCommands } = require("./skills.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "milagre-skills-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "workspace");
  const home = path.join(root, "home");
  async function skill(base, provider, name, text) {
    const file = path.join(base, provider, "skills", name, "SKILL.md");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    return file;
  }
  return { root, project, home, skill };
}

test("discovers workspace and user skills from every supported directory", async (t) => {
  const { project, home, skill } = await fixture(t);
  for (const base of [project, home]) {
    for (const provider of [".agents", ".claude", ".gemini", ".codex"]) {
      await skill(base, provider, `${path.basename(base)}-${provider.slice(1)}`, "# Instructions");
    }
  }
  const result = await discoverSkills(project, { home, bundledDirectory: null });
  assert.equal(result.skills.length, 8);
  assert.equal(result.skills.filter((item) => item.scope === "workspace").length, 4);
  assert.deepEqual(result.warnings, []);
});

test("parses YAML names, quoted descriptions and multiline descriptions", async (t) => {
  const { project, home, skill } = await fixture(t);
  await skill(project, ".agents", "folder", '---\nname: "custom:review"\ndescription: >-\n  Review code:\n  find bugs\n---\nBody');
  await skill(home, ".claude", "quoted", '---\ndescription: "Check: code"\n---\nBody');
  const { skills } = await discoverSkills(project, { home, bundledDirectory: null });
  assert.equal(skills[0].name, "custom:review");
  assert.equal(skills[0].description, "Review code: find bugs");
  assert.equal(skills[1].description, "Check: code");
});

test("workspace overrides user skills and directory precedence is deterministic", async (t) => {
  const { project, home, skill } = await fixture(t);
  await skill(home, ".agents", "review", "User");
  await skill(project, ".claude", "review", "Claude");
  const preferred = await skill(project, ".agents", "review", "Workspace");
  const { skills } = await discoverSkills(project, { home, bundledDirectory: null });
  assert.equal(skills.length, 1);
  assert.equal(skills[0].path, preferred);
});

test("reports every skill a same-named winner hides, with the winner's path", async (t) => {
  const { project, home, skill } = await fixture(t);
  const user = await skill(home, ".agents", "review", "User");
  const claude = await skill(project, ".claude", "review", "Claude");
  const winner = await skill(project, ".agents", "review", "Workspace");
  await skill(project, ".agents", "solo", "Solo");
  const { skills, shadowed } = await discoverSkills(project, { home, bundledDirectory: null });
  assert.deepEqual(
    skills.map((item) => item.path),
    [winner, path.join(project, ".agents", "skills", "solo", "SKILL.md")],
  );
  assert.deepEqual(
    shadowed.map(({ path, scope, provider, shadowedBy }) => ({ path, scope, provider, shadowedBy })),
    [
      { path: claude, scope: "workspace", provider: "claude", shadowedBy: winner },
      { path: user, scope: "user", provider: "agents", shadowedBy: winner },
    ],
  );
});

test("a null Project lists user skills only", async (t) => {
  const { project, home, skill } = await fixture(t);
  await skill(project, ".agents", "local", "Local");
  await skill(home, ".claude", "mine", "Mine");
  const { skills } = await discoverSkills(null, { home, bundledDirectory: null });
  assert.deepEqual(
    skills.map(({ name, scope }) => ({ name, scope })),
    [{ name: "mine", scope: "user" }],
  );
});

test("Designs off removes only the bundled skill from discovery, reads and prompt expansion", async (t) => {
  const { project, home, skill } = await fixture(t);
  const on = await discoverSkills(project, { home });
  const bundled = on.skills.find((entry) => entry.name === "design" && entry.scope === "bundled");
  assert.ok(bundled);
  const options = { home, designsEnabled: false };
  assert.ok(!(await discoverSkills(project, options)).skills.some((entry) => entry.name === "design"));
  assert.equal(await expandSkillPrompt(project, "/design a welcome screen", options), "/design a welcome screen");
  await assert.rejects(readDiscoveredSkill(project, bundled.path, options), /no longer there/);
  const external = await skill(project, ".agents", "design", "Use my external design tool.");
  const off = await discoverSkills(project, options);
  assert.equal(off.skills.find((entry) => entry.name === "design").path, external);
  assert.ok(!off.shadowed.some((entry) => entry.path === bundled.path));
  assert.match(await expandSkillPrompt(project, "/design a welcome screen", options), /Use my external design tool/);
  assert.equal(await readDiscoveredSkill(project, external, options), "Use my external design tool.");
});

test("reads only SKILL.md files discovery returned, shadowed ones included", async (t) => {
  const { project, home, skill } = await fixture(t);
  const user = await skill(home, ".agents", "review", "User copy");
  await skill(project, ".agents", "review", "Workspace copy");
  assert.equal(await readDiscoveredSkill(project, user, { home, bundledDirectory: null }), "User copy");
  const other = path.join(project, "notes.md");
  await fs.writeFile(other, "Private");
  await assert.rejects(readDiscoveredSkill(project, other, { home, bundledDirectory: null }), /no longer there/);
});

test("follows nested and symlinked skill directories without looping or duplicates", async (t) => {
  const { project, home, skill } = await fixture(t);
  const file = await skill(project, ".agents", "nested/review", "Review");
  const root = path.join(project, ".agents", "skills");
  await fs.symlink(root, path.join(root, "cycle"), "dir");
  await fs.mkdir(path.join(home, ".claude"), { recursive: true });
  await fs.symlink(root, path.join(home, ".claude", "skills"), "dir");
  const { skills, warnings } = await discoverSkills(project, { home, bundledDirectory: null });
  assert.equal(skills.length, 1);
  assert.equal(skills[0].path, file);
  assert.deepEqual(warnings, []);
});

test("missing directories are harmless and malformed or oversized skills do not hide valid skills", async (t) => {
  const { project, home, skill } = await fixture(t);
  assert.deepEqual(await discoverSkills(project, { home, bundledDirectory: null }), { skills: [], shadowed: [], warnings: [] });
  await skill(project, ".agents", "bad", "---\nname: [broken\n---\nBody");
  await skill(project, ".agents", "large", "x".repeat(256 * 1024 + 1));
  await skill(project, ".agents", "valid", "Valid");
  const { skills, warnings } = await discoverSkills(project, { home, bundledDirectory: null });
  assert.deepEqual(
    skills.map((item) => item.name),
    ["valid"],
  );
  assert.equal(warnings.length, 2);
});

test("changing workspaces does not reuse skills from the previous workspace", async (t) => {
  const { root, project, home, skill } = await fixture(t);
  await skill(project, ".agents", "first", "First");
  await skill(home, ".agents", "shared", "Shared");
  await discoverSkills(project, { home, bundledDirectory: null });
  const { skills } = await discoverSkills(path.join(root, "second"), { home, bundledDirectory: null });
  assert.deepEqual(
    skills.map((item) => item.name),
    ["shared"],
  );
});

test("expands requested skills once, preserving arguments and reference directories", async (t) => {
  const { project, home, skill } = await fixture(t);
  const file = await skill(home, ".gemini", "review", "Review the diff. Read references/checklist.md.");
  await skill(project, ".agents", "unused", "DO NOT INCLUDE THIS");
  const prompt = "/review src/main.ts\nAlso /review";
  const expanded = await expandSkillPrompt(project, prompt, { home, bundledDirectory: null });
  assert.ok(expanded.startsWith(`The user invoked the skill /review with this message:\n\n${prompt}`));
  assert.ok(expanded.includes(`Resolve relative references from: ${path.dirname(file)}`));
  assert.equal(expanded.split("Review the diff.").length, 2);
  assert.ok(!expanded.includes("DO NOT INCLUDE THIS"));
  await fs.writeFile(file, "Updated instructions");
  assert.ok((await expandSkillPrompt(project, "/review", { home, bundledDirectory: null })).includes("Updated instructions"));
});

test("a message led by a skill Claude Code doesn't know never starts with a slash", async (t) => {
  const { project, home, skill } = await fixture(t);
  await skill(project, ".agents", "review", "Review instructions");
  await skill(home, ".claude", "native", "Native instructions");
  // Claude Code would answer that /review is not installed and drop the request.
  assert.ok(!(await expandSkillPrompt(project, "  /review the PR", { home, bundledDirectory: null })).trimStart().startsWith("/"));
  // Its own skills stay first so the CLI runs them, and a skill later in the message changes nothing.
  assert.ok((await expandSkillPrompt(project, "/native the PR", { home, bundledDirectory: null })).startsWith("/native the PR"));
  assert.ok((await expandSkillPrompt(project, "Please /review the PR", { home, bundledDirectory: null })).startsWith("Please /review the PR"));
  assert.ok((await expandSkillPrompt(project, "/native then /review", { home, bundledDirectory: null })).startsWith("/native then /review"));
});

test("does not treat paths, URLs, inline code or fenced code as invocations", async (t) => {
  const { project, home, skill } = await fixture(t);
  await skill(project, ".agents", "review", "Instructions");
  const prompt = "Open /review/file and https://host/review. ` /review `\n```sh\n/review\n```\n~~~\n/review\n~~~";
  assert.deepEqual([...skillCommands(prompt)], []);
  assert.equal(await expandSkillPrompt(project, prompt, { home, bundledDirectory: null }), prompt);
  assert.equal(await expandSkillPrompt(project, "/unknown", { home, bundledDirectory: null }), "/unknown");
});

test("expands highlighted skills followed by sentence punctuation, but not query URLs", async (t) => {
  const { project, home, skill } = await fixture(t);
  await skill(project, ".agents", "review", "Review instructions");
  for (const prompt of ["Use /review, then finish", "Use /review.", "Use /review?"]) {
    assert.ok((await expandSkillPrompt(project, prompt, { home, bundledDirectory: null })).includes("Review instructions"));
  }
  const url = "Open /review?mode=compact";
  assert.equal(await expandSkillPrompt(project, url, { home, bundledDirectory: null }), url);
});

test("rejects relative workspace paths and limits combined skill context", async (t) => {
  const { project, home, skill } = await fixture(t);
  await assert.rejects(discoverSkills("relative", { home, bundledDirectory: null }), /absolute workspace/);
  await skill(project, ".agents", "one", "a".repeat(150 * 1024));
  await skill(project, ".agents", "two", "b".repeat(150 * 1024));
  await assert.rejects(expandSkillPrompt(project, "/one /two", { home, bundledDirectory: null }), /too large/);
});

test("tolerates unquoted colons in descriptions used by installed skills", async (t) => {
  const { project, home, skill } = await fixture(t);
  await skill(
    home,
    ".agents",
    "shipit",
    "---\nname: shipit\ndescription: Open a PR. Usage: /shipit [draft]\nargument-hint: [draft] [skip-checks]\n---\nInstructions",
  );
  const { skills, warnings } = await discoverSkills(project, { home, bundledDirectory: null });
  assert.deepEqual(warnings, []);
  assert.equal(skills[0].description, "Open a PR. Usage: /shipit [draft]");
});

test("bundles tldr with its checklist for machines without installed skills", async (t) => {
  const { project, home } = await fixture(t);
  const { skills, warnings } = await discoverSkills(project, { home });
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    skills.map(({ name, scope, provider }) => ({ name, scope, provider })),
    [
      { name: "artifacts", scope: "bundled", provider: "milagre" },
      { name: "browser", scope: "bundled", provider: "milagre" },
      { name: "design", scope: "bundled", provider: "milagre" },
      { name: "genui", scope: "bundled", provider: "milagre" },
      ...[
        "milagre",
        "milagre-address-review",
        "milagre-advisor",
        "milagre-committee",
        "milagre-fix-ci",
        "milagre-help",
        "milagre-resolve-conflicts",
        "milagre-update-branch",
      ].map((name) => ({ name, scope: "bundled", provider: "milagre" })),
      { name: "orchestrate", scope: "bundled", provider: "milagre" },
      { name: "simulator", scope: "bundled", provider: "milagre" },
      { name: "tldr", scope: "bundled", provider: "milagre" },
    ],
  );
  const expanded = await expandSkillPrompt(project, "/tldr Rewrite this paragraph", { home });
  assert.ok(expanded.startsWith("The user invoked the skill /tldr with this message:\n\n/tldr Rewrite this paragraph"));
  assert.ok(expanded.includes(await fs.readFile(skills.find((skill) => skill.name === "tldr").path, "utf8")));
  assert.ok((await fs.readFile(path.join(path.dirname(skills.find((skill) => skill.name === "tldr").path), "eval.md"), "utf8")).includes("# tldr eval"));
});

test("installed tldr overrides the bundled slash skill without duplicates", async (t) => {
  const { project, home, skill } = await fixture(t);
  const file = await skill(home, ".agents", "tldr", "My custom writing rules");
  const { skills } = await discoverSkills(project, { home });
  assert.equal(skills.filter((item) => item.name === "tldr").length, 1);
  assert.equal(skills.find((item) => item.name === "tldr").path, file);
  const expanded = await expandSkillPrompt(project, "/tldr", { home });
  assert.ok(expanded.includes("My custom writing rules"));
  assert.ok(!expanded.includes("Two passes fused"));
});

test("Milagre orchestration skills expand with readable packaged references and keep override precedence", async (t) => {
  const { project, home, skill } = await fixture(t);
  const { skills } = await discoverSkills(project, { home });
  for (const name of ["milagre", "milagre-advisor", "milagre-committee", "milagre-help"]) {
    const info = skills.find((s) => s.name === name);
    assert.ok(info);
    assert.equal(info.provider, "milagre");
    const expanded = await expandSkillPrompt(project, `/${name} assess the current task`, { home });
    assert.ok(expanded.includes(`Resolve relative references from: ${path.dirname(info.path)}`));
    const content = await fs.readFile(info.path, "utf8");
    assert.ok(expanded.includes(content));
    for (const match of content.matchAll(/\]\(([^)]+\.md)\)/g)) await fs.access(path.resolve(path.dirname(info.path), match[1]));
  }
  const custom = await skill(project, ".agents", "milagre-advisor", "Custom advisor");
  assert.equal((await discoverSkills(project, { home })).skills.find((s) => s.name === "milagre-advisor").path, custom);
});

test("PR action skills expand from a pill's prompt, and a project skill overrides them", async (t) => {
  const { project, home, skill } = await fixture(t);
  const { skills } = await discoverSkills(project, { home });
  for (const name of ["milagre-fix-ci", "milagre-address-review", "milagre-resolve-conflicts", "milagre-update-branch"]) {
    const info = skills.find((s) => s.name === name);
    assert.ok(info, name);
    const prompt = `Fix CI on pull request #77 (https://github.com/o/r/pull/77). /${name}`;
    const expanded = await expandSkillPrompt(project, prompt, { home });
    assert.ok(expanded.startsWith(prompt));
    const content = await fs.readFile(info.path, "utf8");
    assert.ok(expanded.includes(content));
    assert.doesNotMatch(content, /[\u2013\u2014]/, `${name} has no em or en dashes`);
    for (const match of content.matchAll(/\]\(([^)]+\.md)\)/g)) await fs.access(path.resolve(path.dirname(info.path), match[1]));
  }
  const custom = await skill(project, ".claude", "milagre-fix-ci", "Our own CI steps");
  assert.equal((await discoverSkills(project, { home })).skills.find((s) => s.name === "milagre-fix-ci").path, custom);
  assert.ok((await expandSkillPrompt(project, "Fix CI. /milagre-fix-ci", { home })).includes("Our own CI steps"));
});

test("PR action skills use commands that work on forks and keep the user's uncommitted work out", async (t) => {
  const { project, home } = await fixture(t);
  const { skills } = await discoverSkills(project, { home });
  const read = async (name) => fs.readFile(skills.find((s) => s.name === name).path, "utf8");
  for (const name of ["milagre-fix-ci", "milagre-address-review", "milagre-resolve-conflicts", "milagre-update-branch"]) {
    assert.match(await read(name), /git status/, `${name} checks for uncommitted changes first`);
  }
  for (const name of ["milagre-resolve-conflicts", "milagre-update-branch"]) {
    const content = await read(name);
    assert.match(content, /baseRepository/, `${name} finds the base repository's remote`);
    assert.doesNotMatch(content, /origin\/<base>|fetch origin/, `${name} doesn't assume origin is the base`);
  }
  assert.match(await read("milagre-fix-ci"), /gh pr checks <number> --json/);
  const review = await read("milagre-address-review");
  assert.match(review, /isResolved/);
  assert.match(review, /--paginate/);
});
