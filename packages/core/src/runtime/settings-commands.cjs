const path = require("node:path");
const { createAutoUpdate, hostActivity } = require("../app-auto-update.cjs");
const { createComputerResources } = require("../computer-resources.cjs");
const { createKeybindings } = require("../keybindings.cjs");
const { createBabysitSettings } = require("../babysit-settings.cjs");
const { createDoneSettings } = require("../done-settings.cjs");
const { createSettingsFile } = require("../settings-file.cjs");
const { normalizeSidebarSettings } = require("@milagre/shared/sidebar-settings");

function registerSettingsCommands({ commands, dataDir, emit, worktreeRoot, chatsHome, projectRegistry, chats, scopeStates, heldState, routines }) {
  const autoUpdate = createAutoUpdate({ file: path.join(dataDir, "app-update.json"), emit });
  commands.handle("app-update:auto:read", () => autoUpdate.read());
  commands.handle("app-update:auto:save", (_event, value) => autoUpdate.save(value === true));
  const computerResources = createComputerResources({
    dataDir,
    worktreeRoot: worktreeRoot(),
    chatsHome: chatsHome.path,
    chatFolders: async () => (await projectRegistry().list()).map((project) => path.join(project.path, ".milagre")),
  });
  commands.handle("computer:resources:read", (_event, options) => computerResources.read(options));
  const keybindings = createKeybindings({ file: path.join(dataDir, "keybindings.json"), emit });
  commands.handle("keybindings:read", () => keybindings.read());
  commands.handle("keybindings:set-command", (_event, command, rules) => keybindings.setCommand(command, rules));
  commands.handle("keybindings:reset-command", (_event, command) => keybindings.resetCommand(command));
  commands.handle("keybindings:reset", () => keybindings.resetAll());
  const contextSettings = require("../context-settings.cjs").createContextSettings({ file: path.join(dataDir, "context-settings.json"), emit });
  commands.handle("context:settings:read", () => contextSettings.read());
  commands.handle("context:settings:save", (_event, patch) => contextSettings.save(patch));

  const babysitSettings = createBabysitSettings({ file: path.join(dataDir, "babysit.json"), emit });
  commands.handle("babysit:settings:read", () => babysitSettings.read());
  commands.handle("babysit:settings:save", (_event, patch) => babysitSettings.save(patch));
  const doneSettings = createDoneSettings({ file: path.join(dataDir, "done.json"), emit });
  commands.handle("done:settings:read", () => doneSettings.read());
  commands.handle("done:settings:save", (_event, patch) => doneSettings.save(patch));
  const sidebarSettings = createSettingsFile({
    file: path.join(dataDir, "sidebar.json"),
    emit,
    normalize: normalizeSidebarSettings,
    event: "sidebar:settings",
    name: "Sidebar settings",
  });
  commands.handle("sidebar:settings:read", () => sidebarSettings.read());
  commands.handle("sidebar:settings:save", (_event, patch) => sidebarSettings.save(patch));
  commands.handle("app-update:activity", () =>
    hostActivity({
      busy: chats.busyChats(),
      scopes: scopeStates.projects().map((key) => ({ key, state: heldState(key) })),
      routines: routines().runningCount(),
    }),
  );
  return { keybindings, computerResources, contextSettings, babysitSettings, doneSettings, sidebarSettings };
}

module.exports = { registerSettingsCommands };
