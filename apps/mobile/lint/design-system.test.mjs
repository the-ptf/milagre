// Runs the milagre-design Oxlint plugin through the real oxlint binary on small fixtures: each case is one file, and
// the test checks which rules fire on it and where.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import plugin from "./design-system.mjs";

const PLUGIN = join(import.meta.dirname, "design-system.mjs");
const OXLINT = join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", process.platform === "win32" ? "oxlint.cmd" : "oxlint");
const RULES = Object.keys(plugin.rules);

/** [file name, source, expected `rule@line` hits]. Lines are 1-based. */
const CASES = [
  // font-size-token
  ["font-ok.tsx", `const s = { fontSize: type.body, lineHeight: lineHeight.body, other: { fontSize: textPx * scale } };`, []],
  [
    "font-bad.tsx",
    `const a = { fontSize: 15 };\nconst b = { lineHeight: 20 };\nconst c = { fontSize: big ? type.body : 13 };\nconst d = { fontSize: 17 as const, lineHeight: small && 18 };\n<Text style={{ fontSize: 12 }} />;`,
    ["font-size-token@1", "font-size-token@2", "font-size-token@3", "font-size-token@4", "font-size-token@4", "font-size-token@5"],
  ],
  // radius-token
  ["radius-ok.tsx", `const s = { borderRadius: radius.card, borderTopLeftRadius: 0, other: radius.full };\n<GlassSurface radius={radius.sheet} />;`, []],
  [
    "radius-bad.tsx",
    `const a = { borderRadius: 14 };\nconst b = { borderTopRightRadius: open ? 0 : 10 };\n<GlassSurface radius={20} />;\nconst c = { sheetCornerRadius: 999 };`,
    ["radius-token@1", "radius-token@2", "radius-token@3", "radius-token@4"],
  ],
  // spacing-grid
  ["spacing-ok.tsx", `const s = { padding: 0, margin: 2, gap: 6, paddingHorizontal: 16, marginTop: -4, rowGap: 20, columnGap: space.lg - 2, top: 7 };`, []],
  [
    "spacing-bad.tsx",
    `const a = { gap: 10 };\nconst b = { paddingVertical: 14, marginLeft: -3 };\nconst c = { padding: dense ? 5 : 8 };\nconst d = { marginTop: 1.5 };`,
    ["spacing-grid@1", "spacing-grid@2", "spacing-grid@2", "spacing-grid@3", "spacing-grid@4"],
  ],
  // no-raw-color
  [
    "color-ok.tsx",
    `const s = { color: colors.ink, backgroundColor: "transparent", borderColor: on ? colors.line : colors.accent };\n<Icon color={colors.ink2} />;\nconst label = "green";\nconst list = { colors: [{ key: "green" }] };\nconst issue = \`#\${n}\`;`,
    [],
  ],
  [
    "color-bad.tsx",
    `const a = { color: "#fff" };\nconst b = { backgroundColor: on ? "rgba(0,0,0,0.4)" : colors.page };\n<Path fill="white" />;\n<Svg stroke={"#00000033"} />;\nconst SCRIM = "#00000066";\n<LinearGradient colors={["#070b1f", colors.page]} />;\nconst t = { trackColor: { true: "red" } };`,
    ["no-raw-color@1", "no-raw-color@2", "no-raw-color@3", "no-raw-color@4", "no-raw-color@5", "no-raw-color@6", "no-raw-color@7"],
  ],
  // shadow-token
  ["shadow-ok.tsx", `const s = { boxShadow: colors.shadowRaised, elevation: 0, shadowOpacity: 0, shadowOffset: { width: 0, height: 0 } };`, []],
  [
    "shadow-bad.tsx",
    `const a = { boxShadow: "0 4px 20px #0000000f" };\nconst b = { boxShadow: on ? \`0 0 8px \${colors.purple}\` : colors.shadowCard };\nconst c = { shadowOpacity: 0.3, shadowRadius: 10 };\nconst d = { shadowOffset: { width: 0, height: 3 }, elevation: 4 };`,
    ["shadow-token@1", "shadow-token@2", "shadow-token@3", "shadow-token@3", "shadow-token@4", "shadow-token@4"],
  ],
  // opacity-token
  [
    "opacity-ok.tsx",
    `const s = { opacity: 0 };\nconst t = { opacity: visible ? 1 : 0 };\nconst u = pressStyle({ pressed });\nconst v = { opacity: DISABLED_OPACITY.row };`,
    [],
  ],
  [
    "opacity-bad.tsx",
    `const a = ({ pressed }) => ({ opacity: pressed ? 0.6 : 1 });\nconst b = { opacity: off ? 0.4 : pressed ? 0.5 : 1 };`,
    ["opacity-token@1", "opacity-token@2", "opacity-token@2"],
  ],
  // font-weight
  [
    "weight-ok.tsx",
    `const s = { fontWeight: "500" };\nconst t = { fontWeight: on ? "600" : "400" };\nconst title = { fontSize: type.largeTitle, fontWeight: "700" };\nconst spec = { fontWeight: key === "largeTitle" ? "700" : undefined };`,
    [],
  ],
  [
    "weight-bad.tsx",
    `const a = { fontWeight: "700" };\nconst b = { fontWeight: "bold", fontSize: type.body };\nconst c = { fontWeight: on ? "300" : "500" };`,
    ["font-weight@1", "font-weight@2", "font-weight@3"],
  ],
  // glass-primitive
  [
    "glass-bad.tsx",
    `import { BlurView } from "@sbaiahmed1/react-native-blur";\nconst lazy = () => import("@sbaiahmed1/react-native-blur");`,
    ["glass-primitive@1", "glass-primitive@2"],
  ],
  ["primitives/glass-surface.tsx", `import { LiquidGlassView } from "@sbaiahmed1/react-native-blur";`, []],
  ["src/bottom-fade.tsx", `import { ProgressiveBlurView } from "@sbaiahmed1/react-native-blur";`, []],
  // accessibility-role
  [
    "role-ok.tsx",
    `<Text accessibilityRole="header" />;\n<View accessibilityRole={on ? "button" : "none"} />;\n<Button role="destructive" />;\n<View accessibilityLiveRegion="polite" />;`,
    [],
  ],
  [
    "role-bad.tsx",
    `<Text accessibilityRole="status" />;\n<View accessibilityRole={on ? "button" : "heading"} />;`,
    ["accessibility-role@1", "accessibility-role@2"],
  ],
  // copy-computer
  [
    "copy-ok.tsx",
    `<Text>Connect to your computer</Text>;\n<Row title="macOS only" />;\nconst id = "this-mac";\n<Text>{"MacBook"}</Text>;\nconst viaMac = true;`,
    [],
  ],
  [
    "copy-bad.tsx",
    `<Text>Connect to a Mac first.</Text>;\n<Row title="This Mac" />;\nannounce(\`Opened on \${name}'s Mac\`);\n<Text>{ok ? "Done" : "Update Milagre on your Mac."}</Text>;\nconst rows = [{ subtitle: "The Mac's default model" }];\nAlert.alert("Mac offline");`,
    ["copy-computer@1", "copy-computer@2", "copy-computer@3", "copy-computer@4", "copy-computer@5", "copy-computer@6"],
  ],
  // Strings built outside JSX reach the screen too: thrown errors, error tables, template messages.
  ["copy-anywhere-ok.ts", `import x from "./mac-update";\nconst names = { Mac: 1 };\ntype Kind = "Mac";\nconst os = "macOS";`, []],
  [
    "copy-anywhere-bad.ts",
    `throw new Error("Your Mac refused this phone.");\nconst errors = { offline: "Your Mac isn't reachable." };\nconst hint = \`Open it on your Mac, \${name}\`;`,
    ["copy-computer@1", "copy-computer@2", "copy-computer@3"],
  ],
  // toolbar-icon
  [
    "toolbar-ok.tsx",
    [
      `const a = Platform.OS === "ios" ? <Stack.Toolbar.Button icon="xmark" /> : <Stack.Toolbar.View />;`,
      `const b = Platform.OS === "ios" && ready && <Stack.Toolbar.Button icon="plus" />;`,
      `const c = Platform.OS !== "ios" ? <Stack.Toolbar.View /> : <Stack.Toolbar.Button icon={on ? "a" : "b"} />;`,
      `function D() {\n  if (Platform.OS !== "ios") return null;\n  return <Stack.Toolbar.Button icon="gear" />;\n}`,
      `const e = <Stack.Toolbar.Button onPress={go}>Done</Stack.Toolbar.Button>;`,
    ].join("\n"),
    [],
  ],
  [
    "toolbar-bad.tsx",
    `const a = <Stack.Toolbar.Button icon="xmark" />;\nconst b = Platform.OS === "android" ? <Stack.Toolbar.Button icon="plus" /> : null;\nconst c = ready ? <Stack.Toolbar.Button icon={on ? "a" : "b"} /> : null;`,
    ["toolbar-icon@1", "toolbar-icon@2", "toolbar-icon@3"],
  ],
  // disable-reason, and that a documented exception silences exactly one line
  [
    "disable-ok.tsx",
    `// oxlint-disable-next-line milagre-design/radius-token -- the tray is composer + 4, outside the scale\nconst a = { borderRadius: 28 };\nconst b = { borderRadius: 28 };\n// oxlint-disable-next-line unicorn/no-array-sort\nconst c = 1;`,
    ["radius-token@3"],
  ],
  [
    "disable-bad.tsx",
    `// oxlint-disable-next-line milagre-design/radius-token\nconst a = { borderRadius: 28 };\n/* oxlint-disable milagre-design/no-raw-color -- artwork */\n// oxlint-disable-next-line\nconst b = 1;`,
    ["disable-reason@1", "disable-reason@3", "disable-reason@4"],
  ],
];

function lint() {
  const dir = mkdtempSync(join(tmpdir(), "milagre-design-"));
  try {
    const config = {
      plugins: [],
      categories: { correctness: "off" },
      jsPlugins: [PLUGIN],
      rules: Object.fromEntries(RULES.map((rule) => [`milagre-design/${rule}`, "error"])),
    };
    writeFileSync(join(dir, ".oxlintrc.json"), JSON.stringify(config));
    for (const [name, source] of CASES) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), `${source}\n`);
    }
    const result = spawnSync(OXLINT, ["-c", ".oxlintrc.json", "-f", "json", ...CASES.map(([name]) => name)], {
      cwd: dir,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    assert.ok(result.stdout, `oxlint printed nothing: ${result.stderr}`);
    const hits = new Map(CASES.map(([name]) => [name, []]));
    for (const diagnostic of JSON.parse(result.stdout).diagnostics) {
      const rule = /^milagre-design\((.+)\)$/.exec(diagnostic.code)?.[1];
      assert.ok(rule, `unexpected diagnostic ${diagnostic.code}: ${diagnostic.message}`);
      hits.get(diagnostic.filename.split("\\").join("/")).push(`${rule}@${diagnostic.labels[0].span.line}`);
    }
    return hits;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hits = lint();
for (const [name, , expected] of CASES)
  test(`${name}: ${expected.length ? expected.join(", ") : "clean"}`, () => {
    assert.deepEqual(hits.get(name).toSorted(), expected.toSorted());
  });

test("every rule has a fixture that fires it", () => {
  const fired = new Set(CASES.flatMap(([, , expected]) => expected.map((hit) => hit.split("@")[0])));
  assert.deepEqual(
    RULES.filter((rule) => !fired.has(rule)),
    [],
  );
});
