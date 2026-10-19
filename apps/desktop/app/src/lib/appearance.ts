import {
  CHAT_SIZES,
  CHAT_WIDTHS,
  CODE_SIZES,
  DIFF_PAIRS,
  MONO_FONTS,
  MOTION_SPEEDS,
  SIDEBAR_SIZES,
  UI_FONTS,
  fontStack,
  type Appearance,
} from "@milagre/shared/appearance";

/** The bundled fontsource families are registered with a "Variable" suffix; try that name first. */
const BUNDLED_FAMILIES = ["Inter", "Geist", "Geist Mono", "JetBrains Mono"];

function withBundledNames(stack: string) {
  const first = /^"([^"]+)"/.exec(stack)?.[1];
  return first && BUNDLED_FAMILIES.includes(first) ? `"${first} Variable", ${stack}` : stack;
}

const tint = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

/** The appearance settings as CSS custom properties; pure, so `installed` is injected (the renderer probes real fonts). */
export function appearanceVars(a: Appearance, dark: boolean, installed: (family: string) => boolean): Record<string, string> {
  const vars: Record<string, string> = {
    "--ui-font": withBundledNames(fontStack(UI_FONTS, a.uiFont, installed)),
    "--mono-font": withBundledNames(fontStack(MONO_FONTS, a.monoFont, installed)),
    "--sidebar-delta": `${SIDEBAR_SIZES.find((s) => s.id === a.sidebarSize)?.delta ?? 0}px`,
    "--chat-size": `${CHAT_SIZES.find((s) => s.id === a.chatSize)?.px ?? 13}px`,
    "--code-size": `${CODE_SIZES.find((s) => s.id === a.codeSize)?.px ?? 12}px`,
    "--chat-width": ((px) => (px === null || px === undefined ? "none" : `${px}px`))(CHAT_WIDTHS.find((w) => w.id === a.chatWidth)?.px),
    "--motion-scale": String(MOTION_SPEEDS.find((m) => m.id === a.motion)?.scale ?? 1),
  };
  const colors = DIFF_PAIRS.find((p) => p.id === a.diffColors)?.[dark ? "dark" : "light"];
  if (colors) {
    vars["--diff-add-color"] = colors.add;
    vars["--diff-remove-color"] = colors.remove;
    vars["--diff-add"] = tint(colors.add, 14);
    vars["--diff-add-word"] = tint(colors.add, 28);
    vars["--diff-remove"] = tint(colors.remove, 14);
    vars["--diff-remove-word"] = tint(colors.remove, 28);
  }
  return vars;
}

const DIFF_VARS = ["--diff-add-color", "--diff-remove-color", "--diff-add", "--diff-add-word", "--diff-remove", "--diff-remove-word"];

/** Whether a font family is installed: the font set knows it, and a canvas probe shows it differs from both fallbacks. */
export function isFontInstalled(family: string): boolean {
  if (!document.fonts.check(`12px "${family}"`)) return false;
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return false;
  const sample = "mmmmmmmmmmlli1WwQq";
  return ["monospace", "serif"].some((fallback) => {
    context.font = `72px ${fallback}`;
    const base = context.measureText(sample).width;
    context.font = `72px "${family}", ${fallback}`;
    return context.measureText(sample).width !== base;
  });
}

export function applyAppearance(a: Appearance) {
  const root = document.documentElement;
  const vars = appearanceVars(a, root.classList.contains("dark"), isFontInstalled);
  for (const name of DIFF_VARS) if (!(name in vars)) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
}
