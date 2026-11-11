#!/usr/bin/env node
// Generates the GPUI app's embedded icon set. Run by hand after changing ICONS below; commit what it writes.
//
//   node tools/gen-icons.mjs [path/to/@hugeicons/core-free-icons]
//
// The Hugeicons package defaults to the repository's node_modules (or HUGEICONS_DIR). It writes:
// - assets/hugeicons/<name>.svg: each Hugeicons glyph in ICONS, stroked like the desktop's <Icon> draws it
//   (stroke on every element, width 1.8 in the 24-unit viewBox; the app swaps the width per size).
// - assets/logos/<provider>.svg (brand colours) and <provider>-mono.svg (one path, drawn in the text colour),
//   from packages/shared/src/provider-logos.ts, the shapes desktop and phone draw.
// - src/ui/icon_name.rs: the IconName enum and its asset paths.
// - src/assets/embedded.rs: every file under assets/, embedded with include_bytes!.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The desktop app's names (`@hugeicons/core-free-icons` exports, without the `Icon` suffix), grouped by where they
// are used. Add a name here, run the script, and use `IconName::<Name>`.
const ICONS = [
  // Sidebar (SidebarNav.tsx, sidebar/*.tsx)
  "SidebarLeft01",
  "Search01",
  "PencilEdit02",
  "FlowConnection",
  "TimeSchedule",
  "Link04",
  "Filter",
  "ArrowRight01",
  "ArrowDown01",
  "ArrowUp01",
  "FolderAdd",
  "Settings01",
  "ShieldAlert",
  "BubbleChatQuestion",
  "Alert02",
  // Panel tabs (agents/PanelToggles.tsx) and panel chrome
  "FileDiff",
  "ComputerTerminal01",
  "Globe02",
  "PaintBoard",
  "File01",
  "GitPullRequest",
  "ArrowExpand01",
  "Cancel01",
  // Composer (PromptComposer.tsx)
  "Attachment01",
  "Mic01",
  "ArrowUp02",
  // Model picker, permission picker and new-Chat tray (ModelPicker.tsx, ChatComposer.tsx)
  "Flash",
  "UserMultiple",
  "Shield01",
  "SecurityCheck",
  "ChatGpt",
  "GitFork",
  // Tool rows and activity marks (agents/ActivitySource.tsx)
  "AiBrain01",
  "CommandLine",
  "Wrench01",
  "Image01",
  // Primitives (Checkbox, Chip, menus)
  "Tick02",
  "Add01",
  "MoreVertical",
  "Copy01",
  "Delete02",
  "GitBranch",
  // Prompt chips, quote chips and the Tab suggestion (PromptChip.tsx, QuoteChips.tsx, PromptEditor.tsx)
  "MagicWand01",
  "BubbleChat",
  "Computer",
  "Folder01",
  "React",
  "LeftToRightBlockQuote",
  "ArrowRightToLine",
  // Settings nav, search and sections (settings/*.tsx)
  "Notification01",
  "Keyboard",
  "UserCircle",
  "ChartColumn",
  "BookOpen01",
  "Plug01",
  "FolderTree",
  "Connect",
  "Smartphone",
  "Laptop",
  "Church",
  "InformationCircle",
  "Clean",
  "VolumeHigh",
  // Transcript cards and dividers (WP-23)
  "Refresh01",
  "ArrowShrink01",
  "UserSwitch",
  "Pulse01",
  "Undo02",
  "Redo02",
  "ArrowDataTransferHorizontal",
  "Clock01",
  "CornerDownRight",
  "CornerUpLeft",
  "Download04",
  // WP-27 pill row, Subchats, tasks and undo (PillMorph, TaskTrack, PhaseGraph, PortTrack, SubchatTrack, SubchatBookmark, UndoPanel)
  "ListTodo",
  "ArrowShrink02",
  "EthernetPort",
  "LinkSquare02",
  "StopCircle",
  "HelpCircle",
  "CancelCircle",
  "CheckmarkCircle02",
  "Favourite",
  "Flag01",
  "Target02",
  "TestTube01",
  "Eye",
  "GitMerge",
  "Rocket01",
  "ArrowLeft01",
  "MoreHorizontal",
  "UnfoldMore",
  "GridView",
  "LayoutTwoColumn",
  "FileEdit",
  "FileAdd",
  "FileRemove",
  "AlertCircle",
  "Archive02",
  "Scroll",
  // WP-45 Routines (RoutinesPage, RoutineRow, RoutinePage, RunList, RoutineEditor, PlaceholderTextarea)
  "PlusSign",
  "PauseCircle",
  "PlayCircle",
  "Play",
  "Comment01",
  "Flag02",
  "Tag01",
  "UserCheck01",
  "Webhook",
  "ArrowLeft02",
  "Sparkles",
  "Refresh",
  "Loading03",
  "MinusSignCircle",
  "Moon02",
  "Calendar03",
  "Next",
  "Pause",
  "Unavailable",
  "UnfoldLess",
  "Code",
  "Split",
  "Text",
  // WP-32 PR panel and Git actions dialog (PullRequestPanel, pr/Properties, GitActionsDialog). Comment01, MinusSignCircle,
  // PlusSign, Tag01 and Sparkles are in other blocks; Delete02, GitMerge, Clock01, Tick02 and Alert02 above.
  "ArrowUpDown",
  "Circle",
  "CloudUpload",
  "GitPullRequestClosed",
  "GitPullRequestDraft",
  "UserAdd01",
  "UserGroup",
  // WP-42 Accounts and Usage (AccountsSettings, ProjectAccountsSettings: the account type marks). Alert02, Circle,
  // CheckmarkCircle02, Delete02, Refresh and UserMultiple are in other blocks.
  "Briefcase01",
  "User",
  // WP-20 Sidebar menus, actions and undo (ChatRow menu, FiltersMenu, ScopeRail, Folder footer). Copy01, GitBranch,
  // PencilEdit02, Refresh01, Tick02, Circle, GitPullRequest, Link04, Delete02, Undo02, Filter, Laptop, Folder01,
  // FolderAdd, Clock01, Pulse01, EthernetPort, FileEdit and ArrowRight01 are in other blocks.
  "Bug01",
  "FolderOpen",
  "SourceCode",
  "Pin",
  "PinOff",
  "Unlink04",
  "View",
  "PlusMinus01",
  "SidebarRight01",
  // WP-44 Devices, This Mac and Projects settings (resource gauges). Loading03, Computer, Laptop, Smartphone,
  // ArrowDown01, ArrowRight01, ArrowLeft01, AlertCircle and CheckmarkCircle02 are in other blocks.
  "RamMemory",
  "HardDrive",
  // WP-43 MCP, Milagre MCP, skills and integrations (McpServerRow, BabysitPrsSettings)
  "FolderGit",
  "Message01",
  "Upload01",
  // WP-46 Flows (FlowPage, FlowSteps, FlowInspector, FlowRun, flow-look). Alert02, ArrowDown01, ArrowUp01, Cancel01,
  // Delete02, PencilEdit02, Pause, Play, TestTube01, PlusSign, MoreHorizontal, Message01, SecurityCheck, Split,
  // GitPullRequest, Code, CancelCircle, CheckmarkCircle02, Copy01, Refresh, Shield01 and Tick02 are in other blocks.
  "Stop",
  "WorkflowSquare03",
  "Link01",
  "Bot",
  "CheckmarkSquare02",
  "Hashtag",
  "Hourglass",
  "LeftToRightListBullet",
  "TextFont",
  "Zap",
  "DashedLineCircle",
  "Invoice03",
  "Lock",
  // WP-52 notices and WP-51 onboarding (UpdateNotice, Onboarding, FirstChatStarters). Cancel01, CheckmarkCircle02, Folder01,
  // FolderAdd, FolderGit, FolderOpen, GitFork, ArrowLeft02, Bug01 and TestTube01 are in other blocks.
  "Gift",
  "ArrowRight02",
  "ArrowUpRight01",
  "Maps",
  // Round 9 (replaces the stand-ins): Subchats button (ChangesChrome), Designs zoom bar and Artifact zoom (ZoomBar), design
  // editor toolbar (DesignPageEditor, DesignTools), diff bar (DiffPrefs), terminal right-click menu (TerminalMenu).
  // PlusSign, ArrowLeft01 and Copy01 are in other blocks.
  "HierarchySquare02",
  "MinusSign",
  "FitToScreen",
  "Undo",
  "Redo",
  "Layers01",
  "Frame",
  "Square",
  "Star",
  "LayoutTop",
  "Layout2Column",
  "TextWrap",
  "ClipboardPaste",
];

/** The stroke written into every icon file; `src/assets` replaces it for the 12px (1.6) and 18px (2) sizes. */
const FILE_STROKE = "1.8";
// Asset paths live under hugeicons/, logos/ and ui/: gpui-component's own (Lucide) icons are under icons/.
const PROVIDERS = ["claude", "codex", "antigravity", "kiro"];

const crate = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(crate, "../..");

function hugeiconsDir() {
  const given = process.argv[2] ?? process.env.HUGEICONS_DIR;
  if (given) return path.resolve(given);
  const local = path.join(repo, "node_modules/@hugeicons/core-free-icons");
  if (existsSync(local)) return local;
  try {
    return path.dirname(createRequire(path.join(repo, "package.json")).resolve("@hugeicons/core-free-icons/package.json"));
  } catch {
    throw new Error("Can't find @hugeicons/core-free-icons: run npm install at the repository root, or pass its folder as the first argument.");
  }
}

const kebab = (name) =>
  name
    .replace(/([a-z])([A-Z0-9])/g, "$1-$2")
    .replace(/([0-9])([A-Za-z])/g, "$1-$2")
    .toLowerCase();
const attrName = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Renders one icon the way `<HugeiconsIcon strokeWidth>` does: every element gets the stroke and its width. */
function iconSvg(elements) {
  const children = elements.map(([tag, attrs]) => {
    const merged = { ...attrs, stroke: "currentColor", strokeWidth: FILE_STROKE };
    delete merged.key;
    const text = Object.entries(merged)
      .map(([key, value]) => `${attrName(key)}="${escape(value)}"`)
      .join(" ");
    return `  <${tag} ${text}/>`;
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${FILE_STROKE}">`,
    ...children,
    "</svg>",
    "",
  ].join("\n");
}

/** A provider mark in its brand colours, as ProviderLogo.tsx draws it (48px canvas so 24px@2x stays sharp). */
function logoSvg(provider, logos) {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24">`;
  if (provider === "claude") return [open, `  <path d="${logos.CLAUDE_LOGO.d}" fill="${logos.CLAUDE_LOGO.fill}"/>`, "</svg>", ""].join("\n");
  if (provider === "kiro")
    return [open, `  <path d="${logos.KIRO_LOGO.d}" fill="${logos.KIRO_LOGO.fill}" fill-rule="evenodd" clip-rule="evenodd"/>`, "</svg>", ""].join("\n");
  if (provider === "codex") {
    const stops = logos.CODEX_LOGO.stops.map((stop) => `      <stop offset="${stop.offset}" stop-color="${stop.color}"/>`);
    return [
      open,
      "  <defs>",
      `    <linearGradient id="codex" gradientUnits="userSpaceOnUse" x1="12" x2="12" y1="0" y2="24">`,
      ...stops,
      "    </linearGradient>",
      "  </defs>",
      `  <path d="${logos.CODEX_LOGO.d}" fill="url(#codex)" fill-rule="evenodd" clip-rule="evenodd"/>`,
      "</svg>",
      "",
    ].join("\n");
  }
  const { ANTIGRAVITY_LOGO: arch } = logos;
  const filters = arch.blobs.map((blob) => {
    const [x, y, width, height] = blob.region;
    return [
      `    <filter id="${blob.id}" filterUnits="userSpaceOnUse" x="${x}" y="${y}" width="${width}" height="${height}" color-interpolation-filters="sRGB">`,
      `      <feGaussianBlur stdDeviation="${blob.blur}"/>`,
      "    </filter>",
    ].join("\n");
  });
  return [
    open,
    "  <defs>",
    `    <mask id="arch" maskUnits="userSpaceOnUse" x="0" y="1" width="24" height="23">`,
    `      <path d="${arch.d}" fill="#fff"/>`,
    "    </mask>",
    ...filters,
    "  </defs>",
    `  <g mask="url(#arch)">`,
    ...arch.blobs.map((blob) => `    <path d="${blob.d}" fill="${blob.fill}" filter="url(#${blob.id})"/>`),
    "  </g>",
    "</svg>",
    "",
  ].join("\n");
}

/** The one-colour mark: the outline the desktop's "simplified" provider icons draw. */
function monoSvg(provider, logos) {
  const d = logos.providerLogoPath(provider);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">`,
    `  <path d="${d}" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"/>`,
    "</svg>",
    "",
  ].join("\n");
}

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function listFiles(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const full = path.join(dir, entry);
      return statSync(full).isDirectory() ? listFiles(full) : [full];
    });
}

async function main() {
  const source = hugeiconsDir();
  const pkg = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
  const hugeicons = await import(pathToFileURL(path.join(source, "dist/esm/index.js")).href);
  const logos = await import(pathToFileURL(path.join(repo, "packages/shared/src/provider-logos.ts")).href);

  const iconsDir = path.join(crate, "assets/hugeicons");
  rmSync(iconsDir, { recursive: true, force: true });
  for (const name of ICONS) {
    const elements = hugeicons[`${name}Icon`];
    if (!Array.isArray(elements)) throw new Error(`@hugeicons/core-free-icons has no ${name}Icon`);
    write(path.join(iconsDir, `${kebab(name)}.svg`), iconSvg(elements));
  }
  write(
    path.join(iconsDir, "LICENSE.md"),
    `The SVG files in this folder are generated by tools/gen-icons.mjs from ${pkg.name} ${pkg.version} (${pkg.homepage}).\n\n` +
      readFileSync(path.join(source, "LICENSE.md"), "utf8"),
  );

  const logosDir = path.join(crate, "assets/logos");
  rmSync(logosDir, { recursive: true, force: true });
  for (const provider of PROVIDERS) {
    write(path.join(logosDir, `${provider}.svg`), logoSvg(provider, logos));
    write(path.join(logosDir, `${provider}-mono.svg`), monoSvg(provider, logos));
  }
  write(
    path.join(logosDir, "README.md"),
    "Provider marks generated by tools/gen-icons.mjs from packages/shared/src/provider-logos.ts, the shapes the desktop and\n" +
      "phone apps draw. That file takes them from Lobe Icons (`@lobehub/icons-static-svg` 1.95.1, MIT). The marks are\n" +
      "their owners' trademarks, used to name each provider.\n",
  );

  const variants = ICONS.map((name) => {
    const file = `hugeicons/${kebab(name)}.svg`;
    return `    (IconName::${name}, "${name}", ["${file}@1.6", "${file}", "${file}@2"]),`;
  });
  write(
    path.join(crate, "src/ui/icon_name.rs"),
    [
      `// @generated by tools/gen-icons.mjs from ${pkg.name} ${pkg.version} (MIT). Do not edit by hand:`,
      "// add the name to ICONS in that script and run it again.",
      "",
      "/// A Hugeicons glyph, named as the desktop app imports it (`Search01Icon` is `IconName::Search01`).",
      "#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]",
      "pub enum IconName {",
      ...ICONS.map((name) => `    ${name},`),
      "}",
      "",
      "/// Each icon, its Hugeicons name, and its asset path per stroke: 1.6 (12px), 1.8 (14 and 16px), 2 (18px).",
      "pub(crate) const ICONS: &[(IconName, &str, [&str; 3])] = &[",
      ...variants,
      "];",
      "",
    ].join("\n"),
  );

  const assets = listFiles(path.join(crate, "assets")).filter((file) => /\.(svg|png)$/.test(file));
  write(
    path.join(crate, "src/assets/embedded.rs"),
    [
      "// @generated by tools/gen-icons.mjs: every file under assets/, embedded in the binary. Do not edit by hand.",
      "",
      "pub(super) const FILES: &[(&str, &[u8])] = &[",
      ...assets.map((file) => {
        const rel = path.relative(path.join(crate, "assets"), file).split(path.sep).join("/");
        return `    ("${rel}", include_bytes!("../../assets/${rel}")),`;
      }),
      "];",
      "",
    ].join("\n"),
  );
  console.log(`Wrote ${ICONS.length} icons, ${PROVIDERS.length * 2} logos, ${assets.length} embedded files (${pkg.name} ${pkg.version}).`);
}

await main();
