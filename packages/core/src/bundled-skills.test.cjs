const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { BUNDLED_SKILLS_DIRECTORY } = require("./bundled-skills.cjs");
const { GENUI_COMPONENTS } = require("@milagre/shared/genui");

const skill = fs.readFileSync(path.join(BUNDLED_SKILLS_DIRECTORY, "genui", "SKILL.md"), "utf8");

test("the genui skill lists every component of the contract with its props in positional order, and nothing else", () => {
  const rows = [...skill.matchAll(/^\| `(\w+)\(([^)]*)\)` \|/gm)].map((match) => [
    match[1],
    match[2]
      .split(",")
      .map((arg) => arg.trim().replace(/\?$/, ""))
      .filter(Boolean),
  ]);
  const expected = Object.entries(GENUI_COMPONENTS).map(([name, { props }]) => [name, Object.keys(props.shape)]);
  assert.deepEqual(rows, expected);
});

test("the genui skill marks optional props with a question mark, as the contract does", () => {
  for (const [name, { props }] of Object.entries(GENUI_COMPONENTS)) {
    const row = new RegExp(`^\\| \`${name}\\(([^)]*)\\)\` \\|`, "m").exec(skill);
    assert.ok(row, `${name} is in the skill`);
    const optional = row[1]
      .split(",")
      .map((arg) => arg.trim())
      .filter((arg) => arg.endsWith("?"))
      .map((arg) => arg.slice(0, -1));
    const expected = Object.entries(props.shape)
      .filter(([, schema]) => schema.safeParse(undefined).success)
      .map(([key]) => key);
    assert.deepEqual(optional, expected, `${name} optional props`);
  }
});

test("the design skill lists exactly the bundled catalog fonts", () => {
  const { DESIGN_CATALOG_FAMILIES } = require("@milagre/shared/design");
  const design = fs.readFileSync(path.join(BUNDLED_SKILLS_DIRECTORY, "design", "SKILL.md"), "utf8");
  const list = /^## Fonts\n\n.*\n\n(.+)\.\n/m.exec(design)?.[1];
  assert.ok(list, "the Fonts section has its list of families");
  assert.deepEqual(list.split(", "), DESIGN_CATALOG_FAMILIES);
});
