// DESIGN.md's token tables against the code: the theme builder's default theme, apps/desktop/app/src/styles.css,
// the Icon primitive and apps/mobile/src/design-tokens.ts. When a token changes, change its table in DESIGN.md too.
// node --test apps/site/src/design-system.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  COLOR_KEYS,
  contrastChecks,
  DESIGN_MD,
  designChunks,
  desktop,
  desktopValue,
  isSpecimen,
  palette,
  paletteKey,
  phone,
  SCHEMES,
  SPECIMENS,
  specimenTables,
  tokenName,
  type Table,
} from "./design-system.ts";

const tables = specimenTables(DESIGN_MD);
function table(id: string): Table {
  const found = tables.get(id);
  assert.ok(found, `DESIGN.md has a table under <!-- specimen: ${id} -->`);
  return found;
}
/** A table's rows as objects keyed by its header. */
const rows = (id: string) => table(id).rows.map((row) => Object.fromEntries(table(id).header.map((name, i) => [name, row[i] ?? ""])));
const sorted = (values: Iterable<string>) => [...values].sort();

test("every specimen marker in DESIGN.md is one /design draws, and each is used once", () => {
  const ids = designChunks(DESIGN_MD).flatMap((chunk) => (chunk.kind === "specimen" ? [chunk.id] : []));
  assert.deepEqual(
    ids.filter((id) => !isSpecimen(id)),
    [],
    "add the specimen to SPECIMENS and the page",
  );
  assert.deepEqual(sorted(ids), sorted(SPECIMENS), "each specimen appears exactly once");
});

test("the colour tables list every token of the default theme with its exact light and dark values", () => {
  const listed: string[] = [];
  for (const id of ["color-surfaces", "color-ink", "color-accent", "color-status", "color-purple", "color-diff"])
    for (const row of rows(id)) {
      listed.push(row.Token);
      const key = paletteKey(row.Token);
      assert.ok(key in palette.light, `${row.Token} is a palette token`);
      for (const scheme of SCHEMES) {
        const column = scheme === "light" ? "Light" : "Dark";
        assert.equal(row[column], palette[scheme][key], `${row.Token} ${scheme}: DESIGN.md ${row[column]}, theme builder ${palette[scheme][key]}`);
      }
    }
  assert.deepEqual(sorted(listed), sorted(COLOR_KEYS.map(tokenName)), "the colour tables cover the palette, once each");
});

test("styles.css starts on the default theme's colours before the theme sheet loads", () => {
  for (const key of COLOR_KEYS)
    for (const scheme of SCHEMES) {
      const value = desktopValue(tokenName(key), scheme);
      assert.equal(value?.toLowerCase(), palette[scheme][key].toLowerCase(), `--${tokenName(key)} in styles.css (${scheme})`);
    }
});

test("the contrast floors in DESIGN.md hold on the default theme", () => {
  for (const scheme of SCHEMES) {
    const checks = contrastChecks(scheme);
    assert.ok(checks.length > 10, "the contrast table parses");
    for (const check of checks) assert.ok(check.ratio >= check.floor, `${scheme} ${check.text} on ${check.ground}: ${check.ratio.toFixed(2)} < ${check.floor}`);
  }
});

test("the desktop type table matches styles.css", () => {
  assert.deepEqual(
    rows("type-desktop").map((row) => ({ token: row.Token, size: Number(row.Size), lineHeight: Number(row["Line height"]) })),
    desktop.type,
  );
});

test("the phone type table matches design-tokens.ts", () => {
  const listed = rows("type-phone").map((row) => ({ style: row.Style, size: Number(row.Size), lineHeight: Number(row["Line height"]) }));
  const code = Object.entries(phone.type)
    .map(([style, size]) => ({ style, size, lineHeight: phone.lineHeight[style as keyof typeof phone.lineHeight] }))
    .sort((a, b) => b.size - a.size);
  assert.deepEqual(listed, code);
});

test("the radius tables match styles.css and design-tokens.ts", () => {
  const desktopRows = rows("radius-desktop").filter((row) => row.Value !== "full");
  assert.deepEqual(
    desktopRows.map((row) => ({ token: row.Token, value: Number(row.Value) })),
    desktop.radius,
  );
  assert.deepEqual(
    rows("radius-phone").map((row) => [row.Token, Number(row.Value)]),
    Object.entries(phone.radius).map(([name, value]) => [`radius.${name}`, value]),
  );
});

test("the phone spacing table matches design-tokens.ts", () => {
  assert.deepEqual(
    rows("space-phone").map((row) => [row.Token, Number(row.Value)]),
    Object.entries(phone.space).map(([name, value]) => [`space.${name}`, value]),
  );
});

test("the elevation and blur tables list every token in styles.css", () => {
  assert.deepEqual(
    rows("elevation").map((row) => row.Token),
    desktop.shadows.map((shadow) => shadow.token),
  );
  assert.deepEqual(
    rows("blur").map((row) => ({ token: row.Token, value: Number(row.Value) })),
    desktop.blur,
  );
});

test("the motion table matches both platforms", () => {
  for (const row of rows("motion")) {
    if (row.Token === "press") {
      assert.equal(Number(row.Value), desktop.pressScale, "desktop --press-scale");
      assert.equal(Number(row.Value), phone.pressScale, "phone pressStyle scale");
    } else if (row.Token in desktop.duration) {
      assert.equal(Number(row.Value), desktop.duration[row.Token], `desktop --duration-${row.Token}`);
      assert.equal(Number(row.Value), phone.duration[row.Token as keyof typeof phone.duration], `phone duration.${row.Token}`);
      assert.equal(row.Desktop, `duration-${row.Token}`);
      assert.equal(row.Phone, `duration.${row.Token}`);
    } else {
      assert.equal(row.Value, desktop.easing[row.Token], `desktop --ease-${row.Token}`);
      assert.equal(row.Value, `cubic-bezier(${phone.easing[row.Token as keyof typeof phone.easing].join(", ")})`, `phone easing.${row.Token}`);
      assert.equal(row.Desktop, `ease-${row.Token}`);
    }
  }
  assert.deepEqual(sorted(rows("motion").map((row) => row.Token)), sorted([...Object.keys(desktop.duration), ...Object.keys(desktop.easing), "press"]));
});

test("the icon table matches the Icon primitive's strokes", () => {
  assert.deepEqual(Object.fromEntries(rows("icons").map((row) => [Number(row.Size), Number(row.Stroke)])), desktop.iconStroke);
});
