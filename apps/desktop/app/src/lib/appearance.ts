import {
  CHAT_SIZES,
  CHAT_WIDTHS,
  CODE_SIZES,
  DIFF_PAIRS,
  MONO_FONTS,
  MOTION_SPEEDS,
  SIDEBAR_SIZES,
  UI_FONTS,
  clampChatWidth,
  fontStack,
  type Appearance,
} from "@milagre/shared/appearance";

/** The bundled fontsource families are registered with a "Variable" suffix; try that name first. */
const BUNDLED_FAMILIES = [...UI_FONTS, ...MONO_FONTS].filter((f) => f.bundled && f.id !== "system").map((f) => f.label);

export function withBundledNames(stack: string) {
  const first = /^"([^"]+)"/.exec(stack)?.[1];
  return first && BUNDLED_FAMILIES.includes(first) ? `"${first} Variable", ${stack}` : stack;
}

const tint = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

/** The appearance settings as CSS custom properties; pure, so `installed` is injected (the renderer probes real fonts). */
export function appearanceVars(a: Appearance, dark: boolean, installed: (family: string) => boolean): Record<string, string> {
  const vars: Record<string, string> = {
    "--sidebar-delta": `${SIDEBAR_SIZES.find((s) => s.id === a.sidebarSize)?.delta ?? 0}px`,
    "--chat-size": `${CHAT_SIZES.find((s) => s.id === a.chatSize)?.px ?? 13}px`,
    "--code-size": `${CODE_SIZES.find((s) => s.id === a.codeSize)?.px ?? 12}px`,
    "--chat-width":
      a.chatWidth === "custom"
        ? `${clampChatWidth(a.chatWidthPx)}px`
        : ((px) => (px === null || px === undefined ? "none" : `${px}px`))(CHAT_WIDTHS.find((w) => w.id === a.chatWidth)?.px),
    "--motion-scale": String(MOTION_SPEEDS.find((m) => m.id === a.motion)?.scale ?? 1),
  };
  // The system font (or one that isn't installed) emits nothing, so styles.css's own fallback chain applies as today.
  const ui = fontStack(UI_FONTS, a.uiFont, installed);
  if (ui !== UI_FONTS[0].stack) vars["--ui-font"] = withBundledNames(ui);
  const mono = fontStack(MONO_FONTS, a.monoFont, installed);
  if (mono !== MONO_FONTS[0].stack) vars["--mono-font"] = withBundledNames(mono);
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

const OPTIONAL_VARS = [
  "--ui-font",
  "--mono-font",
  "--diff-add-color",
  "--diff-remove-color",
  "--diff-add",
  "--diff-add-word",
  "--diff-remove",
  "--diff-remove-word",
];

const installedCache = new Map<string, boolean>();

/**
 * Whether a font family is installed. `document.fonts.check` returns true for any family no @font-face declares,
 * so it is no real gate; the canvas probe (width differs from both fallbacks) does the work. Memoized per family.
 */
export function isFontInstalled(family: string): boolean {
  const cached = installedCache.get(family);
  if (cached !== undefined) return cached;
  const result = probeFont(family);
  installedCache.set(family, result);
  return result;
}

function probeFont(family: string): boolean {
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

/** Fires after applyAppearance has set the variables, for surfaces that cache a size or family (xterm). */
export const APPEARANCE_EVENT = "milagre-appearance";

export function applyAppearance(a: Appearance) {
  const root = document.documentElement;
  const vars = appearanceVars(a, root.classList.contains("dark"), isFontInstalled);
  for (const name of OPTIONAL_VARS) if (!(name in vars)) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  window.dispatchEvent(new Event(APPEARANCE_EVENT));
}
