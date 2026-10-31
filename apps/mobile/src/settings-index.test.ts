import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { SETTINGS_INDEX, SETTINGS_PAGES } from "./settings-index.ts";

const shared = (name: string) => `../../../packages/shared/src/${name}`;

/**
 * Where each Settings route's rows are written: its route file, then the sections it renders (src/ files by name) and
 * the shared modules its row titles, groups and hints come from. A section a route starts to render must be added here.
 */
const SOURCES: Record<keyof typeof SETTINGS_PAGES, string[]> = {
  computers: ["app/(settings)/computers.tsx"],
  routines: ["app/routines.tsx"],
  notifications: ["app/(settings)/notifications.tsx", "notification-schedule-setting.tsx"],
  appearance: ["app/(settings)/appearance.tsx", "appearance-section.tsx", "custom-theme-section.tsx"],
  "browser-settings": ["app/(settings)/browser-settings.tsx", "browser-sign-ins-section.tsx"],
  "chat-display": [
    "app/(settings)/chat-display.tsx",
    "chat-display-section.tsx",
    "context-settings-section.tsx",
    shared("chat-row.ts"),
    shared("chat-display.ts"),
  ],
  "dictation-language": ["app/(settings)/dictation-language.tsx"],
  "dictation-model": ["app/(settings)/dictation-model.tsx"],
  archived: ["app/(settings)/archived.tsx"],
  experimental: ["app/(settings)/experimental.tsx", "experimental-section.tsx", shared("device-notes.mjs")],
  "babysit-prs": ["app/(settings)/babysit-prs.tsx", "babysit-section.tsx"],
  simlock: ["app/(settings)/simlock.tsx", "simlock-section.tsx"],
  "computer-use": ["app/(settings)/computer-use.tsx", "computer-use-section.tsx"],
  general: ["app/(settings)/general.tsx", "general-section.tsx", shared("main-sync.ts"), shared("auto-update.ts")],
  usage: ["app/(settings)/usage.tsx", "usage-section.tsx"],
  "token-usage": ["app/(settings)/token-usage.tsx", "token-usage-section.tsx"],
  accounts: ["app/(settings)/accounts.tsx", "accounts-section.tsx", "limit-switch-section.tsx"],
  "project-accounts": ["app/(settings)/project-accounts.tsx", "project-accounts-section.tsx"],
  connections: ["app/(settings)/connections.tsx", "linear-section.tsx", shared("linear.ts")],
  skills: ["app/(settings)/skills.tsx"],
  mcp: ["app/(settings)/mcp.tsx", "mcp-section.tsx"],
  "local-mcp": ["app/(settings)/local-mcp.tsx", "published-pages-section.tsx", "local-mcp-section.tsx"],
  keybindings: ["app/(settings)/keybindings.tsx", "keybindings-section.tsx"],
};

/**
 * Rows with a fixed title that search leaves out on purpose, as "route: title". Each one is a row of its page that
 * nobody searches for by that name, or that the page list already finds.
 */
const NOT_INDEXED: Record<string, string> = {
  // The row opens a page that is itself in SETTINGS_PAGES, so search finds the page by its own name.
  "chat-display: Dictation language": "opens the Dictation language page",
  "chat-display: Speech model": "opens the Speech model page",
  "experimental: Babysit PRs": "opens the Babysit PRs page",
  "experimental: Simlock devices": "opens the Simlock devices page",
  "experimental: Computer use": "opens the Computer use page",
  "general: Plan usage": "opens the Plan usage page",
  "general: Token usage": "opens the Token usage page",
  // The page's only switch carries the page's own name.
  "simlock: Simlock devices": "the page's own name",
  "computer-use: Computer use": "the page's own name",
  // A state of the page, not a setting.
  "project-accounts: Retry": "appears only after a failed load",
};

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
/** Source text as a row would show it: JSX entities decoded and runs of whitespace folded. */
const flat = (text: string) => text.replaceAll("&apos;", "'").replaceAll("&quot;", '"').replace(/\s+/g, " ");
const sourceOf = (route: keyof typeof SETTINGS_PAGES) => flat(SOURCES[route].map(read).join("\n"));

/** Titles written as a plain string on a row primitive, or on the helpers a section draws its rows with. */
function staticTitles(file: string): string[] {
  const tree = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // Rows and controls the find param lights up: the first four by `title`, the last three by `label`.
  const primitives = new Set(["Row", "ListRow", "Toggle", "ChoiceRow"]);
  const labelled = new Set(["Choice", "Segmented", "ChoiceCards"]);
  const helpers = new Set(["toggle", "permission"]);
  const found: string[] = [];
  const text = (node: ts.Node | undefined) => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined);
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(tree);
      if (primitives.has(tag) || labelled.has(tag)) {
        const prop = primitives.has(tag) ? "title" : "label";
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute) || attribute.name.getText(tree) !== prop) continue;
          const value = attribute.initializer;
          const title = text(value) ?? (value && ts.isJsxExpression(value) ? text(value.expression) : undefined);
          if (title !== undefined) found.push(title);
        }
      }
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && helpers.has(node.expression.text)) {
      const title = text(node.arguments[0]);
      if (title !== undefined) found.push(title);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

const routes = Object.keys(SETTINGS_PAGES) as (keyof typeof SETTINGS_PAGES)[];

test("every Settings page has its sources, and they exist", () => {
  assert.deepEqual(Object.keys(SOURCES).sort(), [...routes].sort());
  for (const route of routes) for (const file of SOURCES[route]) assert.ok(existsSync(new URL(file, import.meta.url)), `${route}: ${file} is missing`);
});

test("a page's route file renders only sections this test reads", () => {
  for (const route of routes) {
    const file = SOURCES[route][0] ?? "";
    for (const [, name] of read(file).matchAll(/from "(?:\.\.?\/)+([a-z-]+-section|notification-schedule-setting)"/g)) {
      assert.ok(SOURCES[route].includes(`${name}.tsx`), `${route} renders ${name}: add it to SOURCES`);
    }
  }
});

test("every entry is on a Settings page, once", () => {
  const seen = new Set<string>();
  for (const entry of SETTINGS_INDEX) {
    assert.ok(entry.page in SETTINGS_PAGES, `${entry.title}: ${entry.page} is not a Settings page`);
    const key = JSON.stringify([entry.page, entry.title, entry.group ?? ""]);
    assert.ok(!seen.has(key), `${entry.page}: ${entry.title} is indexed twice`);
    seen.add(key);
  }
});

test("no entry repeats a page's own name", () => {
  for (const entry of SETTINGS_INDEX) {
    assert.notEqual(entry.title, SETTINGS_PAGES[entry.page].title, `${entry.page}: ${entry.title} is found through SETTINGS_PAGES`);
  }
});

test("every entry's title, group and hint are still in its page's source", () => {
  for (const entry of SETTINGS_INDEX) {
    const source = sourceOf(entry.page);
    assert.ok(source.includes(entry.title), `${entry.page}: row "${entry.title}" is not in the source`);
    if (entry.group) assert.ok(source.includes(entry.group), `${entry.page}: group "${entry.group}" is not in the source`);
    if (entry.description) assert.ok(source.includes(flat(entry.description)), `${entry.page}: the hint of "${entry.title}" changed`);
  }
});

test("every entry's title is drawn by a row or control that lights up", () => {
  for (const entry of SETTINGS_INDEX) {
    const titles = SOURCES[entry.page].filter((file) => file.endsWith(".tsx")).flatMap(staticTitles);
    // Rows titled by a constant or a field list (MAIN_SYNC_TITLE, CHAT_ROW_FIELDS) have no string in the section: the shared module holds it.
    const inShared = SOURCES[entry.page].some((file) => !file.endsWith(".tsx") && read(file).includes(entry.title));
    assert.ok(
      titles.includes(entry.title) || inShared,
      `${entry.page}: "${entry.title}" is not the title of a Row, ListRow, Toggle or ChoiceRow, nor the label of a Choice, Segmented or ChoiceCards`,
    );
  }
});

test("every row with a fixed title is indexed or left out on purpose", () => {
  const indexed = new Set(SETTINGS_INDEX.map((entry) => `${entry.page}: ${entry.title}`));
  const present = new Set<string>();
  for (const route of routes) {
    for (const file of SOURCES[route].filter((name) => name.endsWith(".tsx"))) {
      for (const title of staticTitles(file)) {
        const key = `${route}: ${title}`;
        present.add(key);
        assert.ok(indexed.has(key) || key in NOT_INDEXED, `${key} is a row search cannot find: add it to SETTINGS_INDEX, or to NOT_INDEXED with a reason`);
      }
    }
  }
  for (const key of Object.keys(NOT_INDEXED)) {
    assert.ok(present.has(key), `NOT_INDEXED lists ${key}, which no page draws any more`);
    assert.ok(!indexed.has(key), `${key} is both indexed and listed in NOT_INDEXED`);
  }
});
