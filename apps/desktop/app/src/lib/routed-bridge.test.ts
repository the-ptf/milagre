import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The window.milagre calls each file may make: this Mac's own (its window, host, devices, accounts, canvas, editors,
// notifications, image menus over local bytes) and the raw listeners that take every computer's events. Any other call
// goes through bridgeFor / bridgeForKey / useBridge, so it reaches the computer of the Project or chat it is about.
const ALLOWED: Record<string, string[]> = {
  "lib/offline-cache.ts": ["computers", "onComputersChanged"],
  "App.tsx": [
    "onAccountsChanged",
    "listRecentProjects",
    "onQuitFailed",
    "updateCli",
    "getCurrentProject",
    "onRuntimeConnection",
    "getRuntimeConnection",
    "onRuntimeSnapshot",
    "onComputerEvent",
    "onWorktreeRenamed",
    "revealInFolder",
    "setKeepAwake",
    "syncNotifications",
    "setNotifyWhenWaiting",
    "setFloatingInbox",
    "onOpenExperimental",
    "notifyCompletion",
    "onOpenChat",
    "onOpenPhoneSettings",
    "openProject",
    "openCanvasProject",
    "onAppShortcut",
    "restartHost",
    "retryQuit",
  ],
  "components/AddProjectDialog.tsx": ["openProject"],
  "components/FloatingInbox.tsx": [
    "getFloatingInboxOpen",
    "onFloatingInboxOpen",
    "onSelectedInboxItem",
    "getSelectedInboxItem",
    "expandFloatingBar",
    "selectInboxItem",
    "resizeFloatingBar",
    "resizeFloatingInbox",
    "closeFloatingInbox",
    "toggleFloatingInbox",
    "openInboxSettings",
    "openInboxChat",
    "showInboxPreview",
    "getInboxPreviewKey",
    "onInboxPreview",
    "getFloatingPlacement",
    "onFloatingPlacement",
    "beginFloatingDrag",
    "moveFloatingDrag",
    "endFloatingDrag",
    "getFloatingDragOverlay",
    "onFloatingDragOverlay",
  ],
  "lib/inbox.ts": ["getInbox", "onProjectState", "onComputerEvent", "onLinkState"],
  "components/Settings.tsx": [
    "listRecentProjects",
    "onPhoneStatus",
    "getPhoneStatus",
    "listDevices",
    "removeDevice",
    "acknowledgeDevices",
    "openPhonePairing",
    "setPhoneEnabled",
    "setPhoneLan",
    "resetPhoneAccess",
    "getAppVersion",
    "getReleaseChannel",
    "setReleaseChannel",
    "checkForUpdates",
    "readMainSyncDefault",
    "saveMainSyncDefault",
    "readLinearEnabled",
    "readLinearStatus",
    "onLinearStatusChanged",
    "saveLinearEnabled",
    "saveLinearMoveToStarted",
    "connectLinear",
    "disconnectLinear",
    "onMainSyncStatus",
    "computers",
  ],
  "components/SidebarNav.tsx": ["listRecentProjects", "listNamedLinks", "listProjects", "revealInFolder", "updateNamedLink"],
  // Canvas Links are this Mac's own, like the canvas.
  "components/sidebar/SidebarLinks.tsx": ["onLinksChanged"],
  "components/LinkWorkspace.tsx": ["syncNotifications", "revealInFolder"],
  "components/ComputerAllowPrompt.tsx": ["onDevicesPending", "listPendingDevices", "allowDevice", "denyDevice"],
  "components/UpdateNotice.tsx": ["onUpdateState", "getUpdateState", "installUpdate", "checkForUpdates"],
  "components/AccountsSettings.tsx": ["getCliStatus", "listAccounts", "onAccountsChanged", "accountAction", "onCliProgress", "updateCli"],
  "components/ProjectAccountsSettings.tsx": ["listAccountScopes", "onAccountsChanged", "accountAction"],
  "components/CanvasView.tsx": ["getCanvas", "stopNegotiation", "addLink", "removeLink", "setProjectPosition", "setWorktreePosition"],
  "components/AddComputerDialog.tsx": ["onComputerAddPending", "computers"],
  "components/useAgentRuns.ts": ["onRuntimeSnapshot", "onComputerEvent", "getRuns"],
  "components/usePastedImages.ts": ["getPathForFile"],
  "components/usage/useUsage.ts": ["onAccountsChanged", "readUsage", "getCachedUsage"],
  "components/terminal/TerminalPanel.tsx": ["onCloseFocusedTerminal", "setTerminalFocused"],
  "components/SkillsSettings.tsx": ["openSkill", "revealSkill"],
  // This Mac's Linear account and its Experimental switch.
  "components/useLinear.ts": ["readLinearEnabled", "readLinearStatus", "onLinearStatusChanged", "onLinearEnabledChanged"],
  "components/LinearIssuePicker.tsx": ["listLinearIssues"],
  "components/Attachments.tsx": ["showImageMenu"],
  "components/agents/GeneratedImage.tsx": ["copyImage", "saveImage", "showImageMenu"],
  "components/motion/MediaLightbox.tsx": ["showImageMenu"],
  "lib/state-events.ts": ["onProjectState", "onLinkState", "onAgentEvent", "onComputerEvent"],
  "lib/computer-bridge.ts": ["on", "onAgentEvent", "onComputerEvent"],
  "lib/computers.ts": ["computers", "onComputersChanged"],
  "lib/ports.ts": ["onAgentPorts", "onRuntimeSnapshot", "getAgentPorts", "onComputerEvent"],
  "lib/settings.ts": ["setWindowTranslucent"],
  "lib/editors.ts": ["listEditors", "openInEditor"],
  "lib/linked-work.ts": ["getLinkedWork", "onLinkedWork"],
  "lib/terminal-sessions.ts": ["setTerminalFocused"],
  "lib/terminal-actions.ts": ["onTerminalsChanged", "onComputerEvent"],
};

function sources(folder: string): string[] {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [full] : [];
  });
}

test("every window.milagre call outside this Mac's own goes through its computer's bridge", () => {
  const wrong: string[] = [];
  for (const file of sources(SRC)) {
    const name = path.relative(SRC, file).split(path.sep).join("/");
    const code = fs
      .readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const [, method] of code.matchAll(/window\.milagre\??\s*\.\s*(\w+)/g))
      if (!(ALLOWED[name] ?? []).includes(method)) wrong.push(`${name}: window.milagre.${method}`);
  }
  assert.deepEqual([...new Set(wrong)], []);
});
