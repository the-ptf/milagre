// Shared by the Node conformance test and the checked-in Rust test fixture.
import { compileRules, defaultKeybindings, eventKey, eventMatches, KEYBINDING_COMMANDS } from "@milagre/shared/keybindings";
import { forwardedShortcuts } from "./shortcuts.js";

export function fixtures() {
  const rules = [
    ...defaultKeybindings(),
    { key: "ctrl+alt+f5", command: "settings.open", when: "!chatView" },
    { key: "shift+/", command: "artifacts.toggle", when: "terminalFocus" },
    { key: "mod+q", command: "theme.toggle" },
    { key: "mod+w", command: "theme.toggle" },
    { key: "mod+shift+q", command: "settings.open" },
    { key: "mod+p", command: "chat.new" },
  ];
  const forwarded = new Set(KEYBINDING_COMMANDS.filter((command) => command.forward).map((command) => command.id));
  const compiled = compileRules(rules).filter((rule) => forwarded.has(rule.command));
  const inputs = [
    [43, ",", "Comma", ",", true, false, false, false],
    [17, "T", "KeyT", "T", true, false, false, true],
    [2, "D", "KeyD", "D", true, false, false, true],
    [0, "A", "KeyA", "A", true, false, false, true],
    [0, "Q", "KeyA", "Q", true, false, false, true], // Layout letter takes precedence over physical position.
    [2, "∂", "KeyD", "∂", true, false, true, false],
    [18, "!", "Digit1", "!", true, false, false, true],
    [44, "?", "Slash", "?", false, false, false, true],
    [96, "\uf708", "F5", "F5", false, true, true, false],
    [123, "\uf702", "ArrowLeft", "ArrowLeft", true, false, true, false],
    [36, "\r", "Enter", "Enter", false, false, false, false],
    [76, "\u0003", "NumpadEnter", "Enter", false, false, false, false],
    [49, " ", "Space", " ", false, false, true, false],
    [12, "q", "KeyQ", "q", true, false, false, false],
    [13, "w", "KeyW", "w", true, false, false, false],
    [12, "Q", "KeyQ", "Q", true, false, false, true],
    [35, "p", "KeyP", "p", true, false, false, false],
    [200, "é", "", "é", false, false, false, false],
    [200, "😀", "", "😀", false, false, false, false],
    [43, ",", "Comma", ",", true, true, false, false], // Additional modifiers must not match.
  ];
  const cases = inputs.map(([keyCode, characters, code, key, meta, control, alt, shift]) => {
    const event = { key, code, metaKey: meta, ctrlKey: control, altKey: alt, shiftKey: shift };
    const normalized = eventKey(event) || "";
    const lifecycle = meta && !alt && !shift && ["q", "w"].includes(normalized);
    return {
      keyCode,
      characters,
      code,
      key,
      meta,
      control,
      alt,
      shift,
      normalized,
      matched: !lifecycle && compiled.some((rule) => eventMatches(event, rule.shortcut, true)),
    };
  });
  return { rules: forwardedShortcuts(rules), cases };
}
