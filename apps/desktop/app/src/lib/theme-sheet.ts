import type { ThemePalette } from "@milagre/shared/themes";

export const THEME_EVENT = "milagre-theme";
const kebab = (key: string) =>
  key
    .replace(/([a-z])([A-Z0-9])/g, "$1-$2")
    .replace(/([0-9])([A-Za-z])/g, "$1-$2")
    .toLowerCase();
const SHIKI: Record<string, keyof ThemePalette["syntax"]> = {
  "--shiki-foreground": "plain",
  "--shiki-token-comment": "comment",
  "--shiki-token-keyword": "keyword",
  "--shiki-token-string": "string",
  "--shiki-token-string-expression": "string",
  "--shiki-token-constant": "number",
  "--shiki-token-function": "function",
  "--shiki-token-parameter": "property",
  "--shiki-token-punctuation": "punctuation",
  "--shiki-token-link": "type",
};

/** The resolved theme as one stylesheet; `html:root` outranks the static fallbacks in styles.css. */
export function themeStylesheet(palette: ThemePalette) {
  const lines: string[] = [];
  // `purple` stays Ultracode's brand color on desktop (styles.css), like the provider logos.
  for (const [key, value] of Object.entries(palette)) if (typeof value === "string" && key !== "purple") lines.push(`--${kebab(key)}: ${value};`);
  palette.ansi.forEach((color, index) => lines.push(`--ansi-${index}: ${color};`));
  for (const [kind, color] of Object.entries(palette.syntax)) lines.push(`--syntax-${kind}: ${color};`);
  for (const [name, kind] of Object.entries(SHIKI)) lines.push(`${name}: ${palette.syntax[kind]};`);
  return `html:root {
  ${lines.join("\n  ")}
}`;
}

export function applyPalette(palette: ThemePalette) {
  let sheet = document.getElementById("milagre-theme") as HTMLStyleElement | null;
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.id = "milagre-theme";
    document.head.appendChild(sheet);
  }
  sheet.textContent = themeStylesheet(palette);
  window.dispatchEvent(new Event(THEME_EVENT));
}
