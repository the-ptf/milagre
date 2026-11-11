import { compileRules, defaultKeybindings, KEYBINDING_COMMANDS, MAX_KEYBINDINGS } from "@milagre/shared/keybindings";

const forwarded = new Set(KEYBINDING_COMMANDS.filter((command) => command.forward).map((command) => command.id));

// Compile the same current rules as Electron's app-shortcuts.cjs. Native forwards
// by key only; the existing main renderer resolves `when` and the winning command.
export function forwardedShortcuts(rules = defaultKeybindings()) {
  return compileRules(rules.slice(0, MAX_KEYBINDINGS))
    .filter((rule) => forwarded.has(rule.command))
    .map(({ shortcut }) => ({
      key: shortcut.key,
      meta: shortcut.meta || shortcut.mod,
      control: shortcut.ctrl,
      alt: shortcut.alt,
      shift: shortcut.shift,
    }));
}
