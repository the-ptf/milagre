import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { SETTINGS_INDEX } from "./settings-index.ts";
import { computerNoun } from "./shortcut-hints.ts";

const here = new URL(".", import.meta.url);
const read = (relative: string) => readFileSync(new URL(relative, here), "utf8");

/** The pages the desktop Settings can open (SettingsSection in Settings.tsx), minus the per-Project and per-computer ones. */
const PAGES = new Set([
  "general",
  "usage",
  "accounts",
  "project-accounts",
  "appearance",
  "chat",
  "keybindings",
  "browser",
  "notifications",
  "routines",
  "connections",
  "skills",
  "mcp",
  "local-mcp",
  "devices",
  "experimental",
  "about",
]);

const COMPONENTS = "../components/";
const settingsDirectory = readdirSync(new URL(`${COMPONENTS}settings/`, here)).filter((name) => name.endsWith(".tsx"));
/** Settings.tsx and the files under components/settings/: where rows are declared. */
const rowSources = [`${COMPONENTS}Settings.tsx`, ...settingsDirectory.map((name) => `${COMPONENTS}settings/${name}`)];
/** Every file whose text a Settings page can show, and the shared modules the copy constants come from. */
const pageSources = [
  ...rowSources,
  ...[
    "AccountsSettings",
    "ProjectAccountsSettings",
    "ContextSettings",
    "McpSettings",
    "LocalMcpSettings",
    "SkillsSettings",
    "NotificationScheduleSetting",
    "token-usage/TokenUsagePage",
  ].map((name) => `${COMPONENTS}${name}.tsx`),
  ...["auto-update.ts", "browser-sign-ins.ts", "chat-display.ts", "device-notes.mjs", "linear.ts", "main-sync.ts"].map(
    (name) => `../../../../../packages/shared/src/${name}`,
  ),
];
// The index writes a Mac or computer title with the same constant as the row, so the source reads `${computerNoun}` where the index has its value.
const allSource = pageSources.map(read).join("\n").replaceAll("${computerNoun}", computerNoun);

test("every page is a known Settings section", () => {
  for (const entry of SETTINGS_INDEX) assert.ok(PAGES.has(entry.page), `${entry.page}: ${entry.title}`);
});

test("no entry repeats a page, title and group", () => {
  const seen = new Set<string>();
  for (const entry of SETTINGS_INDEX) {
    const key = JSON.stringify([entry.page, entry.title, entry.group ?? null]);
    assert.ok(!seen.has(key), `repeated: ${key}`);
    seen.add(key);
  }
});

test("every entry's title and group are still in the Settings source", () => {
  for (const entry of SETTINGS_INDEX) {
    assert.ok(allSource.includes(entry.title), `${entry.page}: "${entry.title}" is not in the Settings source`);
    if (entry.group) assert.ok(allSource.includes(entry.group), `${entry.page}: group "${entry.group}" of "${entry.title}" is not in the Settings source`);
  }
});

test("every group names a heading that its page also has", () => {
  for (const entry of SETTINGS_INDEX) {
    if (!entry.group) continue;
    assert.ok(
      SETTINGS_INDEX.some((other) => other.page === entry.page && other.title === entry.group),
      `${entry.page}: "${entry.title}" sits under "${entry.group}", which has no entry of its own`,
    );
  }
});

/**
 * Labels the index leaves out on purpose. Anything else a Row, SettingCheckbox or Select labels, and any Group title,
 * has to be in the index (as a title or a group), so a new setting cannot ship unsearchable.
 */
const NOT_INDEXED: Record<string, string> = {
  // Settings › Computer (one page per paired computer; not a section the search opens).
  Name: "Computer page",
  "Same network": "Computer page",
  Relay: "Computer page",
  General: "Computer page group",
  Connection: "Computer page group",
  Remove: "Computer page group",
  // Settings › Project (one page per Project; not a section the search opens).
  Appearance: "Project page group",
  "New worktrees": "Project page group",
  "Remove Project": "Project page group",
  "Remove from Projects list": "Project page row",
  // The row is on the Project page and the Plan usage row on General; the aria label of both is covered by "Show in sidebar".
  "Show usage in sidebar": "aria label of the Plan usage checkbox, whose row is indexed as Show in sidebar",
  // A Select or checkbox whose visible row label differs from its aria label: the row label is the indexed title.
  "Show usage as": "aria label; the row is Show",
  "Dictation language": "aria label; the row is Language",
  "Pairing connection": "aria label; the row is Connect through",
  // Rows inside a section that only exist after another setting is turned on, or after opening a sub-page: the highlight cannot reach them.
  "Show chat activity": "appears under Floating inbox once it is on",
  "Devices at once": "Simlock rows, shown once Simlock devices is on",
  "Return a device after": "Simlock rows, shown once Simlock devices is on",
  "Start from": "Custom theme editor, shown once Custom theme is on",
  "Babysit new PRs": "Babysit PRs sub-page",
  "Check every": "Babysit PRs sub-page",
  "Resolve threads it answered": "Babysit PRs sub-page",
  "Watch the PR for": "Babysit PRs sub-page",
  "Failed to fix the same problem": "Babysit PRs sub-page",
  "When something needs fixing": "Babysit PRs sub-page group",
  "Stop babysitting when": "Babysit PRs sub-page group",
  "Your instructions": "Babysit PRs sub-page group",
  "Show the agent's cursor": "Computer use sub-page",
  Permissions: "Computer use sub-page group",
  "Never used by agents": "Computer use sub-page group",
  // Keybindings: a computer picker, not a setting row.
  Computers: "Keybindings scope picker",
};

/** The static label="…" of every Row, SettingCheckbox and Select, and the title="…" of every Group, in the files that declare rows. */
function declaredLabels() {
  const labels = new Set<string>();
  for (const file of rowSources) {
    const source = read(file);
    for (const match of source.matchAll(/<(?:Row|SettingCheckbox|Select)\b(?:<[^>]*>)?\s+(?:[^>]*?\s)?label="([^"]*)"/g)) labels.add(match[1]!);
    for (const match of source.matchAll(/<(?:Group|ChoiceGroup)\b[^>]*?\btitle="([^"]*)"/g)) labels.add(match[1]!);
  }
  return labels;
}

test("every Row, SettingCheckbox, Select label and Group title is indexed or allowed", () => {
  const labels = declaredLabels();
  // The regexes still find the rows: a refactor that renames Row or Group would otherwise pass this empty.
  assert.ok(labels.size > 80, `only ${labels.size} labels found`);
  const indexed = new Set(SETTINGS_INDEX.flatMap((entry) => (entry.group ? [entry.title, entry.group] : [entry.title])));
  const missing = [...labels].filter((label) => !indexed.has(label) && !(label in NOT_INDEXED));
  assert.deepEqual(missing, [], `add these to settings-index.ts, or to NOT_INDEXED with a reason: ${missing.join(", ")}`);
});

test("everything allowed is still declared and not indexed", () => {
  const labels = declaredLabels();
  const indexed = new Set(SETTINGS_INDEX.map((entry) => entry.title));
  for (const label of Object.keys(NOT_INDEXED)) {
    assert.ok(labels.has(label), `"${label}" is no longer a label: drop it from NOT_INDEXED`);
    assert.ok(!indexed.has(label), `"${label}" is indexed: drop it from NOT_INDEXED`);
  }
});
