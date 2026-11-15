import { shortcutLabel, useKeybindings, chatJumpCommand } from "../../lib/keybindings";

export function useSidebarKeys() {
  const { rules } = useKeybindings();
  return {
    newChat: shortcutLabel(rules, "chat.new"),
    sidebar: shortcutLabel(rules, "sidebar.toggle"),
    search: shortcutLabel(rules, "commandPalette.toggle"),
    canvas: shortcutLabel(rules, "canvas.open"),
    addProject: shortcutLabel(rules, "project.add"),
    settings: shortcutLabel(rules, "settings.open"),
    jump: (index: number) => shortcutLabel(rules, chatJumpCommand(index)),
  };
}
