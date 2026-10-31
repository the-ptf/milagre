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
  // The keys this window runs are this Mac's own keybindings.json; Settings › Keybindings reads other computers' through bridgeFor.
  "lib/keybindings.ts": ["readKeybindings", "onKeybindings"],
  "components/settings/KeybindingsSettings.tsx": ["openKeybindingsFile"],
  // A paired computer's chat paints from the copy this Mac keeps of it while the computer answers.
  "lib/chat-messages.ts": ["computers"],
  "App.tsx": [
    // Triage an issue diagnoses this Mac's own host, as New chat opens on this Mac.
    "prepareTriage",
    "getAppVersion",
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
    "setNotificationChime",
    "setNotificationSchedule",
    "onPlayChime",
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
    "readLimitAutoSwitch",
    "saveLimitAutoSwitch",
    "readRoutinesEnabled",
    "onMainSyncStatus",
    "computers",
    "setProjectHidden",
  ],
  "components/SidebarNav.tsx": ["listRecentProjects", "listNamedLinks", "listProjects", "revealInFolder", "setProjectHidden", "updateNamedLink"],
  // This Mac's own Projects in the new-chat Project picker and computer chip; other computers' come through their bridges.
  "lib/project-copies.ts": ["listRecentProjects"],
  // Canvas Links are this Mac's own, like the canvas.
  "components/sidebar/SidebarLinks.tsx": ["onLinksChanged"],
  "components/LinkWorkspace.tsx": ["syncNotifications", "revealInFolder"],
  "components/ComputerAllowPrompt.tsx": ["onDevicesPending", "listPendingDevices", "allowDevice", "denyDevice"],
  "components/ProviderUpdateNotice.tsx": ["getProviderUpdates", "updateCli"],
  "components/UpdateNotice.tsx": ["onUpdateState", "getUpdateState", "installUpdate", "checkForUpdates"],
  "components/UpdateReleaseNotes.tsx": ["getUpdateReleaseNotes"],
  "components/AccountsSettings.tsx": ["getCliStatus", "listAccounts", "onAccountsChanged", "accountAction", "onCliProgress", "updateCli"],
  // First launch on this Mac, before any Project or computer: its own agents, folders and agent history.
  "components/Onboarding.tsx": [
    "getCliStatus",
    "listAccounts",
    "onAccountsChanged",
    "updateCli",
    "accountAction",
    "listAgentFolders",
    "openProject",
    "openProjectAt",
    "cloneProject",
    "createProject",
    "setUpGit",
  ],
  "components/ProjectAccountsSettings.tsx": ["listAccountScopes", "onAccountsChanged", "accountAction"],
  "components/CanvasView.tsx": ["getCanvas", "stopNegotiation", "addLink", "removeLink", "setProjectPosition", "setWorktreePosition"],
  "components/AddComputerDialog.tsx": ["onComputerAddPending", "computers"],
  "components/useAgentRuns.ts": ["onRuntimeSnapshot", "onComputerEvent", "getRuns"],
  "components/usePastedImages.ts": ["getPathForFile"],
  "components/terminal/TerminalPanel.tsx": ["onCloseFocusedTerminal", "setTerminalFocused"],
  "components/SkillsSettings.tsx": ["openSkill", "revealSkill"],
  // This Mac's Linear account and its Experimental switch.
  "components/useLinear.ts": ["readLinearEnabled", "readLinearStatus", "onLinearStatusChanged", "onLinearEnabledChanged"],
  "components/LinearIssuePicker.tsx": ["listLinearIssues"],
  "components/Attachments.tsx": ["showImageMenu"],
  "components/agents/GeneratedImage.tsx": ["copyImage", "saveImage", "showImageMenu"],
  "components/agents/UsageLimitCard.tsx": ["onAccountsChanged"],
  // Previews register bytes in this renderer's local Electron protocol, even for remote Chats.
  "components/agents/ArtifactCanvas.tsx": ["createArtifactPreview", "releaseArtifactPreview"],
  "components/motion/MediaLightbox.tsx": ["showImageMenu"],
  "lib/state-events.ts": ["onRuntimeSnapshot", "onProjectState", "onLinkState", "onAgentEvent", "onComputerEvent"],
  // Connection metadata and raw events originate on this Mac, including for a paired computer's readers.
  "lib/computer-bridge.ts": ["on", "onAgentEvent", "onComputerEvent", "onComputersChanged"],
  "lib/computers.ts": ["computers"],
  "lib/computers-store.ts": ["computers", "onComputersChanged"],
  "lib/ports.ts": ["onAgentPorts", "onRuntimeSnapshot", "getAgentPorts", "onComputerEvent"],
  "lib/settings.ts": ["setWindowBackground"],
  "lib/editors.ts": ["listEditors", "openInEditor"],
  "lib/linked-work.ts": ["getLinkedWork", "onLinkedWork"],
  // This Mac's own switch for its Chats delegating to other computers.
  "lib/remote-delegation.ts": ["readRemoteDelegationEnabled", "saveRemoteDelegationEnabled", "onRemoteDelegationEnabledChanged"],
  // This Mac's own Babysit PRs settings, which its daemon's poller follows.
  "lib/babysit-settings.ts": ["readBabysitSettings", "saveBabysitSettings", "onBabysitSettings"],
  "lib/terminal-sessions.ts": ["setTerminalFocused"],
  // The microphone is on this computer: Whisper transcribes here whichever computer the Chat is on.
  "components/useDictation.ts": ["dictation"],
  "components/useDictationModels.ts": ["dictation"],
  // Every computer's terminal:changed, and every host's reconnect snapshot, mark the Terminal lists the window holds.
  "lib/terminal-actions.ts": ["onTerminalsChanged", "onComputerEvent", "onRuntimeSnapshot"],
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
