import { ContextSettings } from "./ContextSettings";
import { outbox, useOutbox } from "../lib/outbox";
import { NotificationScheduleSetting } from "./NotificationScheduleSetting";
import { DesignPageShareDialog } from "./agents/DesignPageShareDialog";
import { useBots } from "../lib/bots-store";
import { useRemoteDelegationEnabled } from "../lib/remote-delegation";
import { PRIVACY_URL, SUPPORT_URL } from "@milagre/shared/site-links";
import { showUpdateNotice } from "./UpdateNotice";
import { ProjectAccountsGroup, ProjectAccountsSettings } from "./ProjectAccountsSettings";
import { AccountsSettings } from "./AccountsSettings";
import { SkillsSettings } from "./SkillsSettings";
import { McpSettings } from "./McpSettings";
import { SettingCheckbox } from "./primitives/Checkbox";
import { LocalMcpSettings } from "./LocalMcpSettings";
import { MilagreMark } from "./MilagreMark";
import { ipcErrorMessage } from "@milagre/shared/result";
import {
  LINEAR_ADD_WORKSPACE,
  LINEAR_ADD_WORKSPACE_HINT,
  LINEAR_CONNECTING,
  LINEAR_CONNECTING_WINDOW,
  LINEAR_HINT,
  LINEAR_MOVE_TO_STARTED_HINT,
  LINEAR_MOVE_TO_STARTED_TITLE,
  LINEAR_SIGN_IN_REPLACED,
  LINEAR_USE_BROWSER,
  LINEAR_TITLE,
  linearReadOnlyHint,
  linearStatusLine,
  linearWorkspaces,
  type LinearStatus,
} from "@milagre/shared/linear";
import { PROVIDERS, providerName } from "@milagre/shared/providers";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  BookOpen01Icon,
  BubbleChatIcon,
  KeyboardIcon,
  ConnectIcon,
  FlaskConicalIcon,
  FolderKeyIcon,
  Globe02Icon,
  InformationCircleIcon,
  LaptopIcon,
  LaptopPhoneSyncIcon,
  Notification01Icon,
  PaintBoardIcon,
  Plug01Icon,
  RepeatIcon,
  SecurityCheckIcon,
  Settings01Icon,
  SmartphoneIcon,
  UserCircleIcon,
  VolumeHighIcon,
} from "@hugeicons/core-free-icons";
import { DOT_COLOR, computerTone, routeLine, seenAgo, useComputers, useHiddenComputers } from "../lib/computers";
import type {
  ComputerView,
  FilesToCopy as FilesToCopyResult,
  MilagreBridge,
  PairedDevice,
  PhoneStatus,
  ReleaseChannel,
  UpdateState,
  WorktreeSetupSettings,
} from "../electron";
import { DEFAULT_FILES_TO_COPY, parsePatterns, previewSentence } from "../lib/files-to-copy";
import { PERMISSION_MODES } from "../model";
import type { ModelOption, PermissionMode } from "../model";
import { providerForId, resolveModel } from "../lib/models";
import { getSettings, updateSettings, useSettings } from "../lib/settings";
import { useWindowChrome } from "../lib/window-chrome";
import type { ClaudeReplies, OpenLinksIn, UsageDisplay } from "../lib/settings";
import { DICTATION_LANGUAGES } from "@milagre/shared/dictation";
import type { ChatOrder } from "../lib/chat-list";
import { useEditors } from "../lib/editors";
import { bridgeFor, bridgeForKey, isRemoteKey } from "../lib/computer-bridge";
import { isRemoteScopeHidden, setComputerHidden, setRemoteScopeHidden } from "../lib/hidden-projects";
import { cloudflarePhonesNote, pairingWindow, phoneLanLine, phoneQrSrc, phoneStatusLine } from "../lib/phone";
import { deviceName, deviceSeenLine, devicesByKind, newDeviceKeys, removeDeviceQuestion } from "../lib/devices";
import { GlideGroup, RailButton } from "./SidebarNav";
import { Select } from "./primitives/Select";
import { Group, Row } from "./settings/SettingsGroup";
import { useDoneSettings } from "../lib/done-settings";
import { DONE_RETENTION_OPTIONS, retentionLabel } from "@milagre/shared/done";
import { ComputerResourceList, type ResourceComputer } from "./settings/ComputerResources";
import { BabysitPrsRow, BabysitPrsSettings } from "./settings/BabysitPrsSettings";
import { SimlockSettings } from "./settings/SimlockSettings";
import { ComputerUseSettings } from "./settings/ComputerUseSettings";
import { ModeControl, ThemePicker } from "./settings/ThemePicker";
import { CustomThemeEditor } from "./settings/CustomThemeEditor";
import { AppearanceWindowPreview, type PreviewArea } from "./settings/AppearanceWindowPreview";
import {
  CHAT_SIZES,
  CHAT_WIDTHS,
  CODE_SIZES,
  DIFF_PAIRS,
  clampChatWidth,
  MONO_FONTS,
  MOTION_SPEEDS,
  SIDEBAR_SIZES,
  SIDEBAR_USAGE_MODES,
  PROVIDER_ICON_STYLES,
  UI_FONTS,
  type FontOption,
} from "@milagre/shared/appearance";
import { isFontInstalled, withBundledNames } from "../lib/appearance";
import { DEFAULT_THEME_ID, seedsFrom } from "@milagre/shared/themes";
import { NOTIFICATION_CHIMES, type NotificationChime } from "@milagre/shared/notification-chimes";
import { ChatListChoice, DictationActionChoice, ReasoningChoice, ToolCallChoice } from "./settings/ChatDisplayChoices";
import { KeybindingsSettings } from "./settings/KeybindingsSettings";
import { HostUpdateRow } from "./settings/HostUpdateRow";
import { playNotificationChime } from "../lib/notification-chime";
import { ProviderLogo } from "./ProviderLogo";
import { ScrollArea } from "./primitives/ScrollArea";
import { WorkspaceIcon } from "./WorkspaceIcon";
import { RemoveProjectDialog } from "./RemoveProjectDialog";
import { RECENT_PROJECTS_CHANGED, projectInitial, projectRows } from "../lib/project-list";
import type { RecentProject } from "../lib/project-list";
import { setProjectImage, useProjectImages } from "../lib/project-images";
import { AUTO_UPDATE_HINT, AUTO_UPDATE_TITLE } from "@milagre/shared/auto-update";
import { updateDescription } from "@milagre/shared/app-update";
import { MAIN_SYNC_HINT, MAIN_SYNC_TITLE, choiceOf, mainSyncChoices, mainSyncStatusLine, overrideOf } from "@milagre/shared/main-sync";
import type { MainSyncChoice, MainSyncSettings } from "@milagre/shared/main-sync";
import { computerNoun, thisComputer } from "../lib/shortcut-hints";

type IconData = Parameters<typeof HugeiconsIcon>[0]["icon"];

function Icon({ icon, size = 18 }: { icon: IconData; size?: number }) {
  return <HugeiconsIcon icon={icon} size={size} strokeWidth={1.8} color="currentColor" />;
}

export type SettingsSection =
  | "general"
  | "project-accounts"
  | "accounts"
  | "appearance"
  | "chat"
  | "keybindings"
  | "browser"
  | "notifications"
  | "routines"
  | "connections"
  | "skills"
  | "mcp"
  | "local-mcp"
  | "devices"
  | "experimental"
  | "about"
  | "project"
  | "computer";

const SECTIONS: Array<{
  key: SettingsSection;
  label: string;
  icon: ReactNode;
}> = [
  { key: "general", label: "General", icon: <Icon icon={Settings01Icon} /> },
  { key: "accounts", label: "Accounts", icon: <Icon icon={UserCircleIcon} /> },
  { key: "project-accounts", label: "Project Accounts", icon: <Icon icon={FolderKeyIcon} /> },
  { key: "appearance", label: "Appearance", icon: <Icon icon={PaintBoardIcon} /> },
  { key: "chat", label: "Chat", icon: <Icon icon={BubbleChatIcon} /> },
  { key: "keybindings", label: "Keybindings", icon: <Icon icon={KeyboardIcon} /> },
  { key: "browser", label: "Browser", icon: <Icon icon={Globe02Icon} /> },
  { key: "notifications", label: "Notifications", icon: <Icon icon={Notification01Icon} /> },
  { key: "routines", label: "Routines", icon: <Icon icon={RepeatIcon} /> },
  { key: "connections", label: "Connections", icon: <Icon icon={ConnectIcon} /> },
  { key: "skills", label: "Skills", icon: <Icon icon={BookOpen01Icon} /> },
  { key: "mcp", label: "MCP", icon: <Icon icon={Plug01Icon} /> },
  { key: "local-mcp", label: "Milagre", icon: <MilagreMark /> },
  { key: "devices", label: "Devices", icon: <Icon icon={LaptopPhoneSyncIcon} /> },
  { key: "experimental", label: "Experimental", icon: <Icon icon={FlaskConicalIcon} /> },
  { key: "about", label: "About", icon: <Icon icon={InformationCircleIcon} /> },
];

export type SettingsProject = { path: string; name: string };

export function SettingsNav({
  section,
  project,
  current,
  computerId,
  onSelect,
  onSelectComputer,
  onSelectProject,
  onBack,
  showProjectSettings = true,
}: {
  showProjectSettings?: boolean;
  computerId?: string;
  onSelectComputer?: (id: string) => void;
  section: SettingsSection;
  project?: SettingsProject;
  current?: SettingsProject;
  onSelect: (section: SettingsSection) => void;
  onSelectProject: (project: SettingsProject) => void;
  onBack: () => void;
}) {
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const chrome = useWindowChrome();
  const { thisMac, computers } = useComputers();
  useEffect(() => {
    window.milagre.listRecentProjects().then(
      (list) => setRecent(list ?? []),
      () => {},
    );
  }, []);
  const rows = current ? projectRows({ recent, currentPath: current.path, currentName: current.name }) : [];
  const imageOf = useProjectImages(rows.map((row) => row.path));
  return (
    <aside aria-label="Settings navigation" className="relative flex h-full w-[224px] shrink-0 flex-col">
      {/* Back and the title sit in the window's top bar beside its controls, where the sidebar keeps its toggle. */}
      <div
        className="absolute top-[calc(var(--window-chrome-top)-var(--window-chrome-height))] z-[60] flex h-8 items-center gap-1"
        style={{ left: chrome.sidebarLeft - 12 }}
      >
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          className="flex size-8 items-center justify-center rounded-[8px] text-ink-2 transition-[background-color,color,transform] duration-150 hover:bg-hover-2 hover:text-ink active:scale-[0.96] [-webkit-app-region:no-drag]"
        >
          <Icon icon={ArrowLeft01Icon} size={18} />
        </button>
        <h2 className="text-[14px] font-semibold text-ink">Settings</h2>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-window bg-surface pt-2 shadow-card">
        <GlideGroup>
          {SECTIONS.map((item) => (
            <RailButton key={item.key} icon={item.icon} label={item.label} active={section === item.key} onClick={() => onSelect(item.key)} />
          ))}
        </GlideGroup>
        {computers.length > 0 && (
          <div data-settings-computers>
            <div className="mx-2 mt-2 flex h-8 items-center px-2 text-[12.5px] font-medium text-ink-3">Computers</div>
            <GlideGroup>
              <RailButton icon={<ComputerDot tone="online" />} label={thisMac} active={false} onClick={() => onSelect("devices")} />
              {computers.map((computer) => (
                <RailButton
                  key={computer.id}
                  icon={<ComputerDot tone={computerTone(computer)} />}
                  label={computer.name}
                  active={section === "computer" && computerId === computer.id}
                  onClick={() => onSelectComputer?.(computer.id)}
                />
              ))}
            </GlideGroup>
          </div>
        )}
        {showProjectSettings && (
          <>
            <div className="mx-2 mt-2 flex h-8 shrink-0 items-center px-2 text-[12.5px] font-medium text-ink-3">Projects</div>
            <ScrollArea className="min-h-0 flex-1 pb-2">
              <GlideGroup>
                {rows.map((row) => (
                  <RailButton
                    key={row.path}
                    icon={
                      <span className="flex size-[18px] items-center justify-center overflow-hidden rounded-[5px] bg-ink text-[10px] font-semibold text-surface">
                        <WorkspaceIcon src={imageOf(row.path)} fallback={row.initial} />
                      </span>
                    }
                    label={row.name}
                    active={section === "project" && project?.path === row.path}
                    onClick={() => onSelectProject({ path: row.path, name: row.name })}
                  />
                ))}
              </GlideGroup>
            </ScrollArea>
          </>
        )}
      </div>
    </aside>
  );
}

function ComputerDot({ tone }: { tone: keyof typeof DOT_COLOR }) {
  return <span aria-hidden className="mx-[5px] block size-2 rounded-full" style={{ background: DOT_COLOR[tone] }} />;
}

/** The pill beside a route: the one carrying the connection now, one that would, or one there is none of. */
function RoutePill({ state }: { state: "In use" | "Ready" | "Not available" }) {
  return (
    <span
      data-connection-state
      className="rounded-full px-2 py-0.5 text-[11.5px]"
      style={state === "In use" ? { background: "var(--green-tint)", color: "var(--green-ink)" } : { background: "var(--hover)", color: "var(--ink-3)" }}
    >
      {state}
    </span>
  );
}

/**
 * A paired computer's settings (design computer-settings v1): its name on this Mac, how it is reached, what lives there,
 * and Remove. The gear in the computers popover opens it.
 */
function ComputerSettings({ id, onRemoved }: { id: string; onRemoved: () => void }) {
  const { computers } = useComputers();
  const hiddenComputers = useHiddenComputers();
  const computer = computers.find((item) => item.id === id);
  const [name, setName] = useState(computer?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // "seen 2h ago" keeps counting while the section stays open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const [about, setAbout] = useState<{
    version: string | null;
    projects: string[];
  } | null>(null);
  useEffect(() => setName(computer?.name ?? ""), [computer?.name]);
  useEffect(() => {
    setConfirming(false);
    setError(null);
    setAbout(null);
  }, [id]);
  // What lives there: asked while it is online, kept while it is away.
  useEffect(() => {
    if (computer?.state !== "online") return;
    let live = true;
    void Promise.all([
      window.milagre.computers.invoke(id, "daemon:status").catch(() => null),
      window.milagre.computers.invoke(id, "project:recent").catch(() => []),
    ]).then(([status, recent]) => {
      if (!live) return;
      const projects = (Array.isArray(recent) ? recent : []).filter((project) => !project?.hidden).map((project) => String(project.name));
      setAbout({ version: typeof status?.version === "string" ? status.version : null, projects });
    });
    return () => {
      live = false;
    };
  }, [id, computer?.state]);
  const waiting = useOutbox().items.filter((item) => item.computerId === id && item.status !== "sent");
  if (!computer) return <p className="mt-6 text-[13px] text-ink-3">This computer was removed.</p>;

  const paired = computer.addedAt ? `paired ${new Date(computer.addedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : null;
  const status = [computer.state === "online" ? "Connected" : routeLine(computer, now), about?.version ? `Milagre ${about.version}` : null, paired]
    .filter(Boolean)
    .join(" · ");
  const lanState = computer.state === "online" && computer.route === "lan" ? "In use" : computer.lanRoutes.length > 0 ? "Ready" : "Not available";
  const relayState = computer.state === "online" && computer.route === "relay" ? "In use" : "Ready";
  const rename = async () => {
    const next = name.trim();
    if (!next || next === computer.name) {
      setName(computer.name);
      return;
    }
    try {
      await window.milagre.computers.rename(computer.id, next);
      setError(null);
    } catch (cause) {
      setError(ipcErrorMessage(cause));
      setName(computer.name);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await window.milagre.computers.remove(computer.id);
      // Nothing can deliver them now; the confirmation said they go.
      await Promise.allSettled(waiting.map((item) => outbox.remove(item.id)));
      // A computer paired again comes back shown.
      setComputerHidden(computer.id, false);
      onRemoved();
    } catch (cause) {
      setError(ipcErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-computer-settings>
      <p data-computer-status className="mt-1 text-[13px] text-ink-3">
        {status}
      </p>
      <Group title="General">
        <Row label="Name" description={`Shown on its chats in the sidebar. Only on ${thisComputer}.`}>
          <input
            aria-label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            className="h-[30px] w-[220px] rounded-[8px] bg-field px-2.5 text-[13px] text-ink outline-none ring-1 ring-line-strong focus-visible:ring-accent"
          />
        </Row>
        <div data-computer-show-in-sidebar>
          <Row label="Show in sidebar" description={`${computer.name}'s Projects in the sidebar on ${thisComputer}. It stays connected while hidden.`}>
            <SettingCheckbox label="Show in sidebar" checked={!hiddenComputers.has(computer.id)} onChange={(show) => setComputerHidden(computer.id, !show)} />
          </Row>
        </div>
      </Group>
      <Group title="Connection">
        <div data-connection="lan">
          <Row
            label="Same network"
            description={computer.lanRoutes[0] ? `${computer.lanRoutes[0]}, end-to-end encrypted` : "Not reached on a shared network yet"}
          >
            <RoutePill state={lanState} />
          </Row>
        </div>
        <div data-connection="relay">
          <Row label="Relay" description={`${computer.relayHost}, used away from that network`}>
            <RoutePill state={relayState} />
          </Row>
        </div>
      </Group>
      <Group title={`On ${computer.name}`}>
        <div data-computer-projects>
          {computer.state === "online" ? (
            <Row
              label={about ? `${about.projects.length} ${about.projects.length === 1 ? "Project" : "Projects"}` : "Reading…"}
              description={
                about ? `${about.projects.length ? `${about.projects.join(", ")}. ` : ""}Accounts and simulators stay on ${computer.name}.` : undefined
              }
            >
              {null}
            </Row>
          ) : (
            <Row
              label={`${computer.name} is offline`}
              description={seenAgo(computer.lastSeen, now) ? `Last seen ${seenAgo(computer.lastSeen, now)}.` : undefined}
            >
              {null}
            </Row>
          )}
        </div>
        <ComputerResourceList computers={[resourceComputer(computer, now)]} initiallyOpen={computer.id} />
        {computer.state === "online" && <HostUpdateRow key={`update-${id}`} bridge={bridgeFor(id)} name={computer.name} />}
        {computer.state === "online" && (
          <div data-computer-auto-update>
            <AutoUpdateRow key={id} bridge={bridgeFor(id)} />
          </div>
        )}
      </Group>
      {computer.state === "online" && (
        <section data-computer-mcp className="mt-6">
          <h2 className="px-1 text-[12px] font-medium text-ink-3">MCP servers</h2>
          <McpSettings key={id} bridge={bridgeFor(id)} remote />
          <LocalMcpSettings key={`local-${id}`} bridge={bridgeFor(id)} />
        </section>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-red-ink">
          {error}
        </p>
      )}
      <Group title="Remove">
        <Row
          label={`Remove ${computer.name}`}
          description={`Its chats leave this sidebar and ${thisComputer} forgets its keys. Nothing changes on ${computer.name}; pair again with a new link.${
            waiting.length ? ` ${waiting.length === 1 ? "1 message" : `${waiting.length} messages`} waiting on ${thisComputer} for it will be discarded.` : ""
          }`}
        >
          {confirming ? (
            <span className="flex gap-2">
              <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" data-computer-remove-confirm className={DANGER_BUTTON} disabled={busy} onClick={() => void remove()}>
                Remove {computer.name}
              </button>
            </span>
          ) : (
            <button type="button" data-computer-remove className={DANGER_BUTTON} onClick={() => setConfirming(true)}>
              Remove
            </button>
          )}
        </Row>
      </Group>
    </div>
  );
}

/** A setting chosen from side-by-side picture cards, under its group title and outside the rows' card. */
function ChoiceGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 px-1 text-[12px] font-medium text-ink-3">{title}</h2>
      {children}
    </section>
  );
}

/** The custom chat width: digits right-aligned with a px suffix. Enter or blur saves the clamped value, Escape restores the saved one. */
function ChatWidthField({ value, onCommit, onFocusChange }: { value: number; onCommit: (px: number) => void; onFocusChange?: (focused: boolean) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    // An empty field is not a width: put the saved one back.
    if (text.trim() === "") {
      setText(String(value));
      return;
    }
    const px = clampChatWidth(text);
    setText(String(px));
    if (px !== value) onCommit(px);
  };
  return (
    <label className="flex h-8 items-center gap-1.5 rounded-control border border-line bg-surface pr-2.5 pl-3 text-[13px] font-medium text-ink focus-within:border-ink-3">
      <input
        aria-label="Custom chat width in pixels"
        inputMode="numeric"
        value={text}
        onChange={(event) => setText(event.target.value.replace(/[^0-9]/g, ""))}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => {
          commit();
          onFocusChange?.(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          else if (event.key === "Escape") {
            // Reverting is all Escape does here; App's Escape handler would otherwise leave Settings.
            event.preventDefault();
            event.stopPropagation();
            setText(String(value));
          }
        }}
        className="w-12 bg-transparent text-right outline-none tabular-nums"
      />
      <span className="text-ink-3">px</span>
    </label>
  );
}

function NotificationChimeSetting() {
  const { notificationChime } = useSettings();
  return (
    <Row label="Notification chime" description="Plays when a Chat finishes or needs you. Picking one plays it.">
      <div className="flex items-center gap-1.5">
        {notificationChime !== "system" && (
          <button
            type="button"
            aria-label="Play notification chime"
            title="Play"
            data-chime-play
            className="flex size-7 items-center justify-center rounded-[7px] border border-line text-ink-2 hover:bg-hover"
            onClick={() => playNotificationChime(notificationChime)}
          >
            <Icon icon={VolumeHighIcon} size={14} />
          </button>
        )}
        <Select<NotificationChime>
          label="Notification chime"
          width={200}
          value={notificationChime}
          onChange={(chime) => {
            updateSettings({ notificationChime: chime });
            playNotificationChime(chime);
          }}
          options={NOTIFICATION_CHIMES.map((chime) => ({ value: chime.id, label: chime.label }))}
        />
      </div>
    </Row>
  );
}

/** Every public link to a design or artifact this computer published, revocable even after its Chat is deleted. */
function PublishedPagesSettings() {
  const [publishedPages, setPublishedPages] = useState(false);
  return (
    <div data-slot="published-pages-setting">
      <Row label="Published pages" description="Manage public links to designs and artifacts, including pages from deleted Chats.">
        <button type="button" className="rounded-[8px] border border-line px-3 py-1.5 text-[12px] hover:bg-hover" onClick={() => setPublishedPages(true)}>
          Manage
        </button>
      </Row>
      {publishedPages && <DesignPageShareDialog onClose={() => setPublishedPages(false)} />}
    </div>
  );
}

function RemoteDelegationSettings() {
  const setting = useRemoteDelegationEnabled();
  return (
    <div data-slot="remote-delegation-setting">
      <Row
        label="Delegate to other computers"
        description="A Chat's agent can hand work to a Project on another paired computer. That computer runs the turn, and this Chat shows it as it runs. Needs Drive other computers on in Settings > Devices."
      >
        <SettingCheckbox
          label="Delegate to other computers"
          checked={setting.enabled}
          disabled={!setting.ready || setting.saving}
          onChange={(enabled) => void setting.save(enabled)}
        />
      </Row>
      {setting.error && (
        <p role="alert" className="px-4 pb-3 text-[12px] text-red-ink">
          {setting.error}
        </p>
      )}
    </div>
  );
}

function BotsSettings() {
  const bots = useBots();
  return (
    <div data-slot="bots-setting">
      <Row label="Bots" description="Named bots that work for you and ask before anything irreversible.">
        <SettingCheckbox label="Bots" checked={bots.enabled} disabled={!bots.ready || bots.saving} onChange={(enabled) => void bots.setEnabled(enabled)} />
      </Row>
      {bots.error && (
        <p role="alert" className="px-4 pb-3 text-[12px] text-red-ink">
          {bots.error}
        </p>
      )}
    </div>
  );
}

/** How long a Chat waits in the sidebar's Done list before this Mac archives it. */
function DoneRetentionSetting() {
  const { settings, save } = useDoneSettings();
  return (
    <Group title="Done">
      <Row label="Archive Done chats after">
        <Select
          label="Archive Done chats after"
          width={140}
          value={String(settings.retentionHours)}
          options={DONE_RETENTION_OPTIONS.map((hours) => ({ value: String(hours), label: retentionLabel(hours) }))}
          onChange={(value) => void save({ retentionHours: Number(value) }).catch(() => {})}
        />
      </Row>
    </Group>
  );
}

function ChatSettings() {
  const settings = useSettings();
  return (
    <>
      <ContextSettings />
      <ChoiceGroup title="Chat list">
        <ChatListChoice value={settings.chatList} onChange={(chatList) => updateSettings({ chatList })} />
      </ChoiceGroup>
      <DoneRetentionSetting />
      <ChoiceGroup title="Reasoning">
        <ReasoningChoice expanded={settings.expandReasoning} onChange={(expandReasoning) => updateSettings({ expandReasoning })} />
      </ChoiceGroup>
      <ChoiceGroup title="Tool calls">
        <ToolCallChoice value={settings.toolCallDisplay} onChange={(toolCallDisplay) => updateSettings({ toolCallDisplay })} />
      </ChoiceGroup>
      <Group title="Replies">
        <Row
          label="TLDR writing"
          description="Shape Claude, Codex and Antigravity updates and replies with /tldr. Applies on the next turn after the current reply finishes."
        >
          <SettingCheckbox label="TLDR writing" checked={settings.tldrEnabled} onChange={(tldrEnabled) => updateSettings({ tldrEnabled })} />
        </Row>
        <Row label="Claude replies">
          <Select<ClaudeReplies>
            label="Claude replies"
            value={settings.claudeReplies}
            onChange={(claudeReplies) => updateSettings({ claudeReplies })}
            options={[
              { value: "concise", label: "Concise" },
              { value: "normal", label: "Normal" },
            ]}
          />
        </Row>
      </Group>
      <ChoiceGroup title="Dictation">
        <p className="mb-2 px-1 text-14 font-semibold text-ink">When dictation finishes</p>
        <DictationActionChoice value={settings.dictationAction} onChange={(dictationAction) => updateSettings({ dictationAction })} />
        <div className="mt-4 overflow-hidden rounded-card bg-surface shadow-card">
          <Row
            label="Language"
            description="The mic in the composer transcribes on this computer. Detect automatically handles accents and mixed languages; pick one if it guesses wrong."
          >
            <Select
              label="Dictation language"
              value={settings.dictationLanguage}
              onChange={(dictationLanguage) => updateSettings({ dictationLanguage })}
              options={DICTATION_LANGUAGES.map((language) => ({ value: language.code, label: language.name }))}
            />
          </Row>
        </div>
      </ChoiceGroup>
    </>
  );
}

const MOD_KEY = /Mac/.test(navigator.userAgent) ? "⌘" : "Ctrl";

function BrowserSettings() {
  const settings = useSettings();
  return (
    <Group
      title="Links"
      footer={`Hold ${MOD_KEY} when you click a link to open it in the other place: your default browser instead of the Browser panel, or the other way round.`}
    >
      <Row label="Open links in" description="Where web links open when you click them: links in the agent's replies and the servers the Chat runs.">
        <Select<OpenLinksIn>
          label="Open links in"
          value={settings.openLinksIn}
          onChange={(openLinksIn) => updateSettings({ openLinksIn })}
          options={[
            { value: "milagre", label: "Milagre's Browser panel" },
            { value: "external", label: "Your default browser" },
          ]}
        />
      </Row>
    </Group>
  );
}

function ExperimentalSettings({ title }: { title?: string }) {
  const settings = useSettings();
  // Babysit PRs opens as a page of its own inside Experimental, with its own title row and a way back.
  const [page, setPage] = useState<"experimental" | "babysit-prs">("experimental");
  if (page === "babysit-prs") return <BabysitPrsSettings onBack={() => setPage("experimental")} />;
  return (
    <>
      <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">{title}</h1>
      <Group title="Beta">
        <Row
          label="Floating inbox"
          description="A thin bar attached to the screen edge. Drag its grip to show docking targets over a dimmed desktop. Drop left, right, or bottom; release elsewhere to return. The bottom bar is horizontal. Hover a dot to preview its Chat."
        >
          <SettingCheckbox label="Floating inbox" checked={settings.floatingInbox} onChange={(floatingInbox) => updateSettings({ floatingInbox })} />
        </Row>
        {settings.floatingInbox && (
          <div className="ml-4 border-l border-line pl-4">
            <Row
              label="Show chat activity"
              description="Include working chats with a progress summary and finished updates. Off: only questions and permission requests."
            >
              <SettingCheckbox
                label="Show chat activity"
                checked={settings.floatingInboxActivity}
                onChange={(floatingInboxActivity) => updateSettings({ floatingInboxActivity })}
              />
            </Row>
          </div>
        )}
        <Row
          label="Ultracode Fatality"
          description="Turning Ultracode on darkens the window, slams ULTRACODE across it Mortal Kombat style, and an announcer says it out loud."
        >
          <SettingCheckbox
            label="Ultracode Fatality"
            checked={settings.ultracodeFatality}
            onChange={(ultracodeFatality) => updateSettings({ ultracodeFatality })}
          />
        </Row>
        <BotsSettings />
        <RemoteDelegationSettings />
        <SimlockSettings />
        <ComputerUseSettings />
        <BabysitPrsRow onOpen={() => setPage("babysit-prs")} />
      </Group>
    </>
  );
}

function GeneralSettings({ models }: { models: ModelOption[] }) {
  const settings = useSettings();
  const { editors, editor } = useEditors();
  return (
    <>
      <Group title="Agents">
        <Row label="Default model" description="Used for new chats; remembers your last selection">
          <Select
            label="Default model"
            width={280}
            value={resolveModel(models, settings.defaultModelId, providerForId(settings.defaultModelId)).id}
            onChange={(defaultModelId) => updateSettings({ defaultModelId })}
            options={PROVIDERS.flatMap((provider) =>
              models
                .filter((model) => model.provider === provider)
                .map((model) => ({
                  value: model.id,
                  label: model.name,
                  icon: <ProviderLogo provider={provider} size={14} />,
                  group: providerName(provider),
                })),
            )}
          />
        </Row>
        <Row label="Default permission" description="Used for new chats; remembers your last selection">
          <Select<PermissionMode>
            label="Default permission"
            width={340}
            value={settings.defaultPermissionMode}
            onChange={(defaultPermissionMode) => updateSettings({ defaultPermissionMode })}
            options={PERMISSION_MODES.map((mode) => ({
              value: mode.id,
              label: mode.name,
              description: mode.description,
              icon: (
                <span className={`flex shrink-0 ${mode.id === "full" ? "text-ink" : mode.id === "auto" ? "text-green-ink" : "text-accent-ink"}`}>
                  <Icon icon={SecurityCheckIcon} size={14} />
                </span>
              ),
            }))}
          />
        </Row>
      </Group>
      <Group title="Sidebar">
        <Row label="Chat order" description="Newest chat first keeps chats in place as replies arrive">
          <Select<ChatOrder>
            label="Chat order"
            value={settings.chatOrder}
            onChange={(chatOrder) => updateSettings({ chatOrder })}
            options={[
              { value: "created", label: "Newest chat first" },
              { value: "recent", label: "Latest message first" },
            ]}
          />
        </Row>
      </Group>
      <Group title="Editor">
        <Row
          label="Open files in"
          description={
            editors && editors.length === 0
              ? "Install Cursor, VS Code, Zed or another editor to open files and folders"
              : "Used by file links in replies and tool rows, and by Open in <editor> in the chat menu"
          }
        >
          {editors && editors.length === 0 ? (
            <span className="text-ink-3">No editor found</span>
          ) : (
            <Select
              label="Open files in"
              value={editor?.id ?? ""}
              onChange={(editorId) => updateSettings({ editorId })}
              options={(editors ?? []).map((item) => ({ value: item.id, label: item.name }))}
            />
          )}
        </Row>
      </Group>
      <Group title="Worktrees">
        <MainSyncDefaultSetting />
      </Group>
      <Group title="System">
        <Row
          label={`Keep the ${computerNoun} awake`}
          description="While Milagre runs, so your phone and other computers can reach it. The screen can still turn off. Plugged in, it stays awake with the lid closed; on battery, closing the lid sleeps it."
        >
          <SettingCheckbox label={`Keep the ${computerNoun} awake`} checked={settings.keepAwake} onChange={(keepAwake) => updateSettings({ keepAwake })} />
        </Row>
      </Group>
      <Group title="Plan usage">
        <Row label="Show" description="Claude, Codex and Antigravity plan limits">
          <Select<UsageDisplay>
            label="Show usage as"
            value={settings.usageDisplay}
            onChange={(usageDisplay) => updateSettings({ usageDisplay })}
            options={[
              { value: "used", label: "Used" },
              { value: "remaining", label: "Remaining" },
            ]}
          />
        </Row>
        <Row label="Show in sidebar" description="Hover a provider for its limits and reset times">
          <SettingCheckbox
            label="Show usage in sidebar"
            checked={settings.showUsageInSidebar}
            onChange={(showUsageInSidebar) => updateSettings({ showUsageInSidebar })}
          />
        </Row>
      </Group>
    </>
  );
}

function NotificationsSettings() {
  const settings = useSettings();
  return (
    <>
      <Group title="Alerts">
        <Row label="Notify when finished" description="When a turn finishes or fails while you are outside the chat">
          <SettingCheckbox
            label="Notify when finished"
            checked={settings.notifyOnCompletion}
            onChange={(notifyOnCompletion) => updateSettings({ notifyOnCompletion })}
          />
        </Row>
        <Row label="Dock badge" description="Count chats with unread replies or waiting for your input">
          <SettingCheckbox label="Dock badge" checked={settings.showDockBadge} onChange={(showDockBadge) => updateSettings({ showDockBadge })} />
        </Row>
        <Row label="Notify when waiting" description="When a chat needs an approval or an answer and Milagre is in the background">
          <SettingCheckbox
            label="Notify when waiting"
            checked={settings.notifyWhenWaiting}
            onChange={(notifyWhenWaiting) => updateSettings({ notifyWhenWaiting })}
          />
        </Row>
        <Row label="Attention button" description="Top right, when a chat in another project needs an approval or an answer">
          <SettingCheckbox
            label="Attention button"
            checked={settings.showAttentionButton}
            onChange={(showAttentionButton) => updateSettings({ showAttentionButton })}
          />
        </Row>
      </Group>
      <Group title="Schedule">
        <NotificationScheduleSetting />
      </Group>
      <Group title="Sound">
        <NotificationChimeSetting />
      </Group>
    </>
  );
}

/** Settings › Routines: whether this Mac nudges about unread Runs (the top bar's Routines button and the Routines' rows). */
function RoutinesSettings() {
  const settings = useSettings();
  return (
    <Group title="Nudges">
      <Row label="Unread Runs dot" description="On the Routines button and each Routine's row, while a Run's Chat has a result you haven't opened">
        <SettingCheckbox label="Unread Runs dot" checked={settings.routineNudges} onChange={(routineNudges) => updateSettings({ routineNudges })} />
      </Row>
    </Group>
  );
}

/** Two dots, additions then deletions, in the pair's colors (the default pair shows the theme's own green and red). */
function DiffDots({ pair }: { pair: (typeof DIFF_PAIRS)[number] }) {
  const colors = (document.documentElement.classList.contains("dark") ? pair.dark : pair.light) ?? { add: "var(--green)", remove: "var(--red)" };
  return (
    <span data-diff-dots className="flex gap-1" aria-hidden>
      <span className="size-2.5 rounded-full" style={{ background: colors.add }} />
      <span className="size-2.5 rounded-full" style={{ background: colors.remove }} />
    </span>
  );
}

function fontOptions(list: readonly FontOption[]) {
  return list
    .filter((font) => font.bundled || isFontInstalled(font.label))
    .map((font) => ({
      value: font.id,
      label: font.label,
      description: font.id === "system" ? "default" : undefined,
      style: { fontFamily: withBundledNames(font.stack) },
    }));
}

/** A saved font that is no longer installed reads as the default; the saved value stays. */
function shownFont(list: readonly FontOption[], id: string) {
  const font = list.find((candidate) => candidate.id === id);
  return font && (font.bundled || isFontInstalled(font.label)) ? id : (list[0]?.id ?? "system");
}

function pxOptions<T extends string>(list: readonly { id: T; px: number }[]) {
  return list.map((size) => ({ value: size.id, label: `${size.px} px`, description: size.id === "default" ? "default" : undefined }));
}

// The window's stripes (as on body, pinned to the viewport), so a strip painted with them is invisible over the page.
const STRIPES = {
  backgroundColor: "var(--stripe-bg)",
  backgroundImage: "repeating-linear-gradient(-45deg, transparent 0, transparent 7px, var(--stripe) 7px, var(--stripe) 8px)",
  backgroundAttachment: "fixed",
} as const;
// A change keeps its area highlighted this long after the menu closes.
const PREVIEW_HOLD_MS = 1500;

/** A state update that drops `area` and keeps anything else. */
const unlessArea = (area: PreviewArea) => (current: PreviewArea | null) => (current === area ? null : current);

/**
 * What the Appearance window preview highlights: an open menu (or the focused px field) first, then the area just
 * changed (held 1.5 s), then the row under the pointer. Moving onto another row drops the held one.
 */
function usePreviewHighlight() {
  const [hovered, setHovered] = useState<PreviewArea | null>(null);
  const [menu, setMenu] = useState<PreviewArea | null>(null);
  const [held, setHeld] = useState<PreviewArea | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return {
    highlight: menu ?? held ?? hovered,
    row: (area: PreviewArea) => ({
      onEnter: () => {
        setHovered(area);
        setHeld((current) => (current === area ? current : null));
      },
      onLeave: () => setHovered(unlessArea(area)),
    }),
    menu: (area: PreviewArea) => (open: boolean) => setMenu(open ? area : unlessArea(area)),
    /** Holds `area` for 1.5 s; null drops a held area at once. */
    hold: (area: PreviewArea | null) => {
      setHeld(area);
      window.clearTimeout(timer.current);
      if (area) timer.current = window.setTimeout(() => setHeld(null), PREVIEW_HOLD_MS);
    },
  };
}

function AppearanceSettings() {
  const settings = useSettings();
  const { appearance } = settings;
  const setAppearance = (patch: Partial<typeof appearance>) => updateSettings({ appearance: { ...getSettings().appearance, ...patch } });
  const preview = usePreviewHighlight();
  const [playMotion, setPlayMotion] = useState(0);
  const change = (area: PreviewArea, patch: Partial<typeof appearance>) => {
    setAppearance(patch);
    preview.hold(area);
  };
  return (
    <>
      <Group title="Mode">
        <Row label="Mode" description="System follows macOS. Every theme has a light and a dark version. ⌘⇧T switches.">
          <ModeControl value={settings.theme} onChange={(theme) => updateSettings({ theme })} />
        </Row>
      </Group>
      <section className="mt-6">
        <ThemePicker />
      </section>
      <Group title="Custom theme">
        <Row label="Custom theme" description={'Build a theme from a few colors. It shows up as "Custom" with the Milagre themes.'}>
          <SettingCheckbox
            label="Custom theme"
            checked={settings.customThemeEnabled}
            onChange={(customThemeEnabled) => {
              if (!customThemeEnabled) {
                updateSettings({ customThemeEnabled, ...(settings.colorTheme === "custom" ? { colorTheme: DEFAULT_THEME_ID } : {}) });
              } else {
                const from = settings.colorTheme === "custom" ? DEFAULT_THEME_ID : settings.colorTheme;
                updateSettings({ customThemeEnabled, customTheme: settings.customTheme ?? seedsFrom(from), colorTheme: "custom" });
              }
            }}
          />
        </Row>
        {settings.customThemeEnabled && <CustomThemeEditor />}
      </Group>
      <div>
        {/* Sticky over the rows below it; the strip above the card repaints the window's stripes so rows vanish under it. */}
        <div className="sticky top-0 z-20 -mx-6 px-6 pt-7" style={STRIPES}>
          <AppearanceWindowPreview highlight={preview.highlight} playMotion={playMotion} />
        </div>
        <Group title="Typography">
          <Row label="Interface font" description="Used across the app." preview={preview.row("ui")}>
            <Select
              label="Interface font"
              width={260}
              searchable
              value={shownFont(UI_FONTS, appearance.uiFont)}
              onChange={(uiFont) => change("ui", { uiFont })}
              onOpenChange={preview.menu("ui")}
              options={fontOptions(UI_FONTS)}
            />
          </Row>
          <Row label="Monospace font" description="Code, diffs and the terminal." preview={preview.row("code")}>
            <Select
              label="Monospace font"
              width={260}
              searchable
              value={shownFont(MONO_FONTS, appearance.monoFont)}
              onChange={(monoFont) => change("code", { monoFont })}
              onOpenChange={preview.menu("code")}
              options={fontOptions(MONO_FONTS)}
            />
          </Row>
          <Row label="Sidebar size" description="Project and chat names in the sidebar." preview={preview.row("sidebar")}>
            <Select
              label="Sidebar size"
              width={160}
              value={appearance.sidebarSize}
              onChange={(sidebarSize) => change("sidebar", { sidebarSize })}
              onOpenChange={preview.menu("sidebar")}
              options={pxOptions(
                SIDEBAR_SIZES.map((size) => ({
                  id: size.id,
                  px: 13 + size.delta,
                })),
              )}
            />
          </Row>
          <Row label="Chat size" description="Messages and the composer." preview={preview.row("chat")}>
            <Select
              label="Chat size"
              width={160}
              value={appearance.chatSize}
              onChange={(chatSize) => change("chat", { chatSize })}
              onOpenChange={preview.menu("chat")}
              options={pxOptions(CHAT_SIZES)}
            />
          </Row>
          <Row label="Code size" description="Code blocks, diffs and the terminal." preview={preview.row("code")}>
            <Select
              label="Code size"
              width={160}
              value={appearance.codeSize}
              onChange={(codeSize) => change("code", { codeSize })}
              onOpenChange={preview.menu("code")}
              options={pxOptions(CODE_SIZES)}
            />
          </Row>
        </Group>
        <Group title="Layout">
          <Row label="Chat width" description="How wide messages and the composer grow on large screens." preview={preview.row("width")}>
            <div className="flex items-center gap-2">
              {appearance.chatWidth === "custom" && (
                <ChatWidthField
                  value={appearance.chatWidthPx}
                  onCommit={(chatWidthPx) => change("width", { chatWidthPx })}
                  onFocusChange={preview.menu("width")}
                />
              )}
              <Select
                label="Chat width"
                width={200}
                value={appearance.chatWidth}
                onChange={(chatWidth) => change("width", { chatWidth })}
                onOpenChange={preview.menu("width")}
                options={CHAT_WIDTHS.map((width) => ({ value: width.id, label: width.label }))}
              />
            </div>
          </Row>
          <Row label="Provider icons" description="Original colors, or black and white to match the mode." preview={preview.row("ui")}>
            <Select
              label="Provider icons"
              width={200}
              value={appearance.providerIcons}
              onChange={(providerIcons) => change("ui", { providerIcons })}
              onOpenChange={preview.menu("ui")}
              options={PROVIDER_ICON_STYLES.map((style) => ({ value: style.id, label: style.label }))}
            />
          </Row>
          <Row label="Sidebar usage" description="One row per provider, or provider icons in one line." preview={preview.row("usage")}>
            <Select
              label="Sidebar usage"
              width={200}
              value={appearance.sidebarUsage}
              onChange={(sidebarUsage) => change("usage", { sidebarUsage })}
              onOpenChange={preview.menu("usage")}
              options={SIDEBAR_USAGE_MODES.map((mode) => ({ value: mode.id, label: mode.label }))}
            />
          </Row>
        </Group>
        <Group title="Diffs">
          <Row label="Diff colors" description="Additions and deletions, including change counts." preview={preview.row("diff")}>
            <Select
              label="Diff colors"
              width={220}
              value={appearance.diffColors}
              onChange={(diffColors) => change("diff", { diffColors })}
              onOpenChange={preview.menu("diff")}
              options={DIFF_PAIRS.map((pair) => ({
                value: pair.id,
                label: pair.label,
                icon: <DiffDots pair={pair} />,
              }))}
            />
          </Row>
        </Group>
        <Group title="Motion">
          <Row label="Panel animations" description="How fast panels open and close. macOS Reduce Motion turns them off.">
            <Select
              label="Panel animations"
              width={160}
              value={appearance.motion}
              onChange={(motion) => {
                setAppearance({ motion });
                // The replay is the feedback here, so a highlight still held from another row goes.
                preview.hold(null);
                setPlayMotion((count) => count + 1);
              }}
              options={MOTION_SPEEDS.map((speed) => ({ value: speed.id, label: speed.label }))}
            />
          </Row>
        </Group>
      </div>
    </>
  );
}

/** Settings › Devices: memory and disk on this Mac and on every computer it drives, Milagre's share marked. */
/** A paired computer as a memory and disk row: its route while it answers, else when it was last seen. */
function resourceComputer(computer: ComputerView, now: number): ResourceComputer {
  const online = computer.state === "online";
  const seen = seenAgo(computer.lastSeen, now);
  return {
    id: computer.id,
    name: computer.name,
    detail: online ? routeLine(computer, now) : "Offline",
    bridge: bridgeFor(computer.id),
    online,
    seen: seen ? `Seen ${seen}` : null,
  };
}

/** Settings › Devices: memory and disk on this Mac and on every computer it drives. */
function DeviceResources() {
  const { otherComputers } = useSettings();
  const { thisMac, computers } = useComputers();
  // "Seen 2h ago" keeps counting while the page stays open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const rows: ResourceComputer[] = [
    { id: "this-mac", name: thisMac, detail: "This Mac", bridge: window.milagre, online: true },
    ...(otherComputers ? computers.map((computer) => resourceComputer(computer, now)) : []),
  ];
  return (
    <Group>
      <ComputerResourceList computers={rows} />
    </Group>
  );
}

function OtherComputersSetting({ onAddComputer }: { onAddComputer?: () => void }) {
  const { otherComputers } = useSettings();
  return (
    <Group>
      <Row label="Drive other computers" description="Drive the chats of other computers running Milagre from this window. Their Projects join the sidebar.">
        <SettingCheckbox label="Drive other computers" checked={otherComputers} onChange={(next) => updateSettings({ otherComputers: next })} />
      </Row>
      {otherComputers && onAddComputer && (
        <Row
          label="Add computer"
          description="Pair with another computer using the link from its Settings › Devices. The laptop button in the sidebar adds one too."
        >
          <button type="button" data-settings-add-computer onClick={onAddComputer} className={SECONDARY_BUTTON}>
            Add computer…
          </button>
        </Row>
      )}
    </Group>
  );
}

/* ─────────────────────────────────────────────────────────
 * DEVICES
 * The host runs the bridge the Milagre phone app talks to.
 * Turning it on shows a QR code that carries the access token;
 * resetting makes a new token, so every paired device pairs again.
 * Below it, the phones and computers paired to this Mac.
 * ───────────────────────────────────────────────────────── */
function usePhoneStatus() {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let pushed = false;
    // An update that arrives while the first read is in flight is newer than that read.
    const off = window.milagre.onPhoneStatus((next) => {
      pushed = true;
      setStatus(next);
    });
    window.milagre.getPhoneStatus().then(
      (next) => {
        // oxlint-disable-next-line promise/no-callback-in-promise -- the handler receives the resolved value, not a Node-style callback
        if (live && !pushed) setStatus(next);
      },
      (error) => {
        if (live) setLoadError(`Couldn't read device access: ${ipcErrorMessage(error)}`);
      },
    );
    return () => {
      live = false;
      off();
    };
  }, []);
  return { status, setStatus, loadError };
}

/**
 * The paired devices. A pairing, a removal or a reset arrives as a phone status, which reads the list again; a device
 * connecting or leaving doesn't, so it is also read every 15 seconds while the section is open.
 * `fresh`: phones that paired since the owner last looked (a phone may pair while Milagre is closed). They stay marked
 * New while the section is open; the host hears at once that they were shown, so the next visit doesn't mark them.
 */
function usePairedDevices() {
  const [list, setList] = useState<PairedDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const show = useCallback((devices: PairedDevice[]) => {
    setList(devices);
    setError(null);
    setNow(Date.now());
    const keys = newDeviceKeys(devices);
    if (!keys.length) return;
    setFresh((current) => (keys.every((key) => current.has(key)) ? current : new Set([...current, ...keys])));
    // Only the keys shown here: a phone that pairs after this read stays New until it is shown too.
    void window.milagre.acknowledgeDevices(keys).catch(() => {});
  }, []);
  useEffect(() => {
    let live = true;
    const read = () => {
      window.milagre.listDevices().then(
        (devices) => {
          if (live) show(devices);
        },
        (failure) => {
          if (live) setError(`Couldn't read paired devices: ${ipcErrorMessage(failure)}`);
        },
      );
    };
    read();
    const off = window.milagre.onPhoneStatus(read);
    const timer = window.setInterval(read, 15_000);
    return () => {
      live = false;
      off();
      window.clearInterval(timer);
    };
  }, [show]);
  // `replace`: a list the caller already has (a removal's answer), shown at once; an earlier read error no longer applies.
  return { list, replace: show, error, now, fresh };
}

const SECONDARY_BUTTON =
  "rounded-control border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:border-line-strong hover:bg-hover disabled:cursor-default disabled:opacity-50";
const DANGER_BUTTON =
  "rounded-control border border-red/30 bg-red/5 px-3 py-1.5 text-[12px] font-medium text-red-ink transition-colors hover:bg-red/10 disabled:cursor-default disabled:opacity-50";

function DeviceGroup({
  devices,
  fresh,
  now,
  busy,
  empty,
  error,
  footer,
  onRemove,
}: {
  devices: PairedDevice[];
  /** Keys marked New. */
  fresh: ReadonlySet<string>;
  now: number;
  busy: boolean;
  empty?: string;
  error?: string | null;
  footer?: string | null;
  onRemove: (key: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <Group>
      {error ? (
        <p data-devices-error className="break-words px-4 py-3 text-[12px] text-red-ink">
          {error}
        </p>
      ) : (
        devices.length === 0 &&
        empty && (
          <p data-devices-empty className="px-4 py-3 text-[12px] text-ink-3">
            {empty}
          </p>
        )
      )}
      {devices.map((device) => {
        const asking = confirming === device.key;
        return (
          <div key={device.key} data-device-row={device.kind} data-device-key={device.key} className="flex min-h-[52px] items-center gap-3 px-4 py-2">
            <span className="relative flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-hover text-ink-2">
              <Icon icon={device.kind === "computer" ? LaptopIcon : SmartphoneIcon} size={15} />
              <span
                aria-hidden
                className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-surface ${device.route ? "bg-green" : "bg-ink-3"}`}
              />
            </span>
            <div className="grid min-w-0 flex-1 gap-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[13.5px] font-medium text-ink">{deviceName(device)}</span>
                {fresh.has(device.key) && (
                  <span
                    data-device-new
                    title="Paired since you last looked"
                    className="shrink-0 rounded-full bg-accent-tint px-1.5 py-px text-[10.5px] font-semibold text-accent-ink"
                  >
                    New
                  </span>
                )}
              </span>
              <span data-device-line className="text-[12px] text-ink-3">
                {asking ? removeDeviceQuestion(device) : deviceSeenLine(device, now)}
              </span>
            </div>
            {asking ? (
              <span className="flex shrink-0 items-center gap-2">
                <button type="button" onClick={() => setConfirming(null)} className={SECONDARY_BUTTON}>
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  data-device-remove-confirm
                  onClick={() => {
                    setConfirming(null);
                    onRemove(device.key);
                  }}
                  className={DANGER_BUTTON}
                >
                  Remove
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={busy}
                data-device-remove
                onClick={() => setConfirming(device.key)}
                className="shrink-0 rounded-control px-2 py-1 text-[12.5px] text-red-ink transition-colors hover:bg-red/5 disabled:cursor-default disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
        );
      })}
      {footer && (
        <p data-devices-note className="px-4 py-3 text-[12px] text-ink-3">
          {footer}
        </p>
      )}
    </Group>
  );
}

function DevicesSettings({ onAddComputer }: { onAddComputer?: () => void }) {
  const { status, setStatus, loadError } = usePhoneStatus();
  const paired = usePairedDevices();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [pairingRoute, setPairingRoute] = useState("automatic");
  const pairingOption = status?.pairingOptions?.find((option) => option.id === pairingRoute) ?? status?.pairingOptions?.[0];
  const copyTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const run = (action: () => Promise<PhoneStatus>) => {
    setBusy(true);
    setError(null);
    action()
      .then(setStatus, (failure) => setError(ipcErrorMessage(failure)))
      .finally(() => setBusy(false));
  };
  const removeDevice = (key: string) => {
    setBusy(true);
    setError(null);
    window.milagre
      .removeDevice(key)
      .then(paired.replace, (failure) => setError(ipcErrorMessage(failure)))
      .finally(() => setBusy(false));
  };
  const copyLink = () => {
    const link = pairingOption?.link ?? status?.computerLink ?? status?.pairingLink;
    if (!link) return;
    void navigator.clipboard.writeText(link).then(
      () => {
        setCopied(true);
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
      },
      () => {},
    );
  };

  const on = status?.state === "on" && status.qrSvg && status.pairingLink;
  // Showing the QR is what invites a new device to pair, so it opens the window; a status that arrives later keeps the countdown honest.
  const showingQr = Boolean(on) && status?.pairingUntil !== undefined;
  useEffect(() => {
    if (!showingQr) return;
    let live = true;
    window.milagre.openPhonePairing().then(
      (next) => {
        // oxlint-disable-next-line promise/no-callback-in-promise -- the handler receives the resolved value, not a Node-style callback
        if (live) setStatus(next);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [showingQr, setStatus]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!showingQr) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [showingQr, status?.pairingUntil]);
  const pairing = pairingWindow(status, now);
  const { computers, phones } = devicesByKind(paired.list ?? []);
  return (
    <>
      <p className="mt-1 text-[13px] text-ink-2">Phones and other computers that can see and drive {thisComputer}'s chats.</p>
      <DeviceResources />
      <Group>
        <Row label="Allow devices to connect" description={loadError ?? phoneStatusLine(status)}>
          <SettingCheckbox
            label="Allow devices to connect"
            checked={status?.enabled === true}
            onChange={(enabled) => {
              if (!busy && status) run(() => window.milagre.setPhoneEnabled(enabled));
            }}
          />
        </Row>
        {status?.enabled && status.lan && (
          <Row label="Allow on local network" description={phoneLanLine(status) ?? ""}>
            <SettingCheckbox
              label="Allow on local network"
              checked={status.lan.enabled}
              onChange={(enabled) => {
                if (!busy) run(() => window.milagre.setPhoneLan(enabled));
              }}
            />
          </Row>
        )}
        {status?.state === "on" && status.remote === "none" && (
          <p data-phone-local-only className="px-4 py-3 text-[12px] text-ink-3">
            Only a phone simulator on {thisComputer} can connect. Set up a Cloudflare tunnel with npm run mobile:cloudflare to reach {thisComputer} from any
            network.
          </p>
        )}
        {status?.state === "error" && status.error && (
          <p data-phone-error className="break-words px-4 py-3 text-[12px] text-red-ink">
            {status.error}
          </p>
        )}
        {error && (
          <p data-phone-action-error className="break-words px-4 py-3 text-[12px] text-red-ink">
            Couldn't change device access: {error}
          </p>
        )}
      </Group>
      {on && (
        <Group>
          {(status.pairingOptions?.length ?? 0) > 1 && (
            <Row
              label="Connect through"
              description="Automatic tries LAN and Tailscale before the remote connection. Private pairing needs both devices on the same network or tailnet."
            >
              <Select
                label="Pairing connection"
                value={pairingOption?.id ?? "automatic"}
                options={status.pairingOptions!.map(({ id, label }) => ({
                  value: id,
                  label,
                }))}
                onChange={setPairingRoute}
              />
            </Row>
          )}
          <div className="flex items-start gap-5 px-4 py-4">
            <img
              data-phone-qr
              src={phoneQrSrc(pairingOption?.qrSvg ?? status.qrSvg!)}
              alt="QR code to pair your phone"
              width={176}
              height={176}
              className="size-44 shrink-0 rounded-[10px] bg-white"
            />
            <div className="grid min-w-0 gap-3">
              <div className="grid gap-0.5">
                <span className="text-[13.5px] font-medium text-ink">Scan with the Milagre app</span>
                <span className="text-[12px] text-ink-3">Open the app on your phone and point its camera at this code.</span>
              </div>
              <div>
                <button type="button" onClick={copyLink} className={SECONDARY_BUTTON}>
                  {copied ? "Copied" : "Copy link"}
                </button>
              </div>
              <p data-phone-warning className="text-[12px] text-ink-2">
                This code gives access to your agents. Don't share it or post a screenshot of it.
              </p>
              <p className="flex gap-4 text-[12px] underline underline-offset-4">
                <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
                  Privacy policy
                </a>
                <a href={SUPPORT_URL} target="_blank" rel="noreferrer">
                  Support
                </a>
              </p>
              {pairing && (
                <div data-phone-pairing={pairing.open ? "open" : "closed"} className="flex flex-wrap items-center gap-3">
                  <span className="text-[12px] text-ink-3">
                    {pairing.open
                      ? `New devices can pair for ${pairing.minutes} more ${pairing.minutes === 1 ? "minute" : "minutes"}`
                      : "Pairing is closed to new devices."}
                  </span>
                  {!pairing.open && (
                    <button
                      type="button"
                      disabled={busy}
                      data-phone-allow-pairing
                      onClick={() => run(() => window.milagre.openPhonePairing())}
                      className={SECONDARY_BUTTON}
                    >
                      Allow pairing again
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </Group>
      )}
      <OtherComputersSetting onAddComputer={onAddComputer} />
      {computers.length > 0 && <DeviceGroup devices={computers} fresh={paired.fresh} now={paired.now} busy={busy} onRemove={removeDevice} />}
      <DeviceGroup
        devices={phones}
        fresh={paired.fresh}
        now={paired.now}
        busy={busy}
        empty={paired.list === null ? undefined : "No phones yet"}
        error={paired.error}
        footer={cloudflarePhonesNote(status)}
        onRemove={removeDevice}
      />
      {status?.enabled && (
        <Group>
          <Row
            label="Reset access"
            description={
              confirmReset
                ? "Devices that already paired stop working and must pair again. This can't be undone."
                : "Make a new code. Devices that already paired pair again."
            }
          >
            {confirmReset ? (
              <span className="flex items-center gap-2">
                <button type="button" onClick={() => setConfirmReset(false)} className={SECONDARY_BUTTON}>
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  data-phone-reset-confirm
                  onClick={() => {
                    setConfirmReset(false);
                    run(() => window.milagre.resetPhoneAccess());
                  }}
                  className={DANGER_BUTTON}
                >
                  Reset and disconnect
                </button>
              </span>
            ) : (
              <button type="button" disabled={busy || status.state === "starting"} onClick={() => setConfirmReset(true)} className={SECONDARY_BUTTON}>
                Reset access
              </button>
            )}
          </Row>
        </Group>
      )}
    </>
  );
}

/**
 * Auto update, kept by the host it reaches: this Mac's (Settings › About, then the update state carries it too) or a
 * paired computer's (its Computer page). Hidden until the host answers; an older one never does.
 */
function AutoUpdateRow({ bridge }: { bridge: Pick<MilagreBridge, "readAutoUpdate" | "saveAutoUpdate" | "onAutoUpdate"> }) {
  const [autoUpdate, setAutoUpdate] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    bridge.readAutoUpdate().then(
      (value) => live && setAutoUpdate(value?.autoUpdate === true),
      () => live && setAutoUpdate(null),
    );
    // Another device can change it meanwhile.
    const off = bridge.onAutoUpdate((value) => setAutoUpdate(value?.autoUpdate === true));
    return () => {
      live = false;
      off();
    };
  }, [bridge]);
  if (autoUpdate === null) return null;
  const change = async (next: boolean) => {
    setError("");
    setAutoUpdate(next);
    try {
      setAutoUpdate((await bridge.saveAutoUpdate(next)).autoUpdate);
    } catch (cause) {
      setAutoUpdate(!next);
      setError(ipcErrorMessage(cause));
    }
  };
  return (
    <Row label={AUTO_UPDATE_TITLE} description={error || AUTO_UPDATE_HINT}>
      <SettingCheckbox label={AUTO_UPDATE_TITLE} checked={autoUpdate} onChange={(next) => void change(next)} />
    </Row>
  );
}

export function AboutSettings({ update }: { update: UpdateState | null }) {
  const [version, setVersion] = useState<string | null>(null);
  const [channel, setChannel] = useState<ReleaseChannel | null>(null);
  useEffect(() => {
    void window.milagre.getAppVersion().then(setVersion);
    void window.milagre.getReleaseChannel().then(setChannel);
  }, []);
  const electron = navigator.userAgent.match(/Electron\/([\d.]+)/)?.[1];
  const chrome = navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1];
  return (
    <Group title="Milagre">
      <Row label="Version">
        <span className="tabular-nums">{version ?? "…"}</span>
      </Row>
      <Row
        label="Release channel"
        description={
          channel === "beta"
            ? "Beta gets a build most days main changes. Switch back to Stable any time; you keep the version you have until the next stable release."
            : "Stable gets releases after they have run on Beta."
        }
      >
        <Select<ReleaseChannel>
          label="Release channel"
          value={channel ?? "stable"}
          onChange={(next) => {
            setChannel(next);
            void window.milagre.setReleaseChannel(next);
          }}
          options={[
            { value: "stable", label: "Stable" },
            { value: "beta", label: "Beta" },
          ]}
        />
      </Row>
      <Row label="Updates" description={updateDescription(update)}>
        <button
          type="button"
          disabled={update?.status === "checking" || update?.status === "downloading" || update?.status === "unavailable" || update?.status === "installing"}
          onClick={() => void (update?.status === "downloaded" ? showUpdateNotice() : window.milagre.checkForUpdates())}
          className="rounded-control border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:border-line-strong hover:bg-hover disabled:cursor-default disabled:opacity-50"
        >
          {update?.status === "installing" ? "Restarting…" : update?.status === "downloaded" ? "Install & restart" : "Check for updates"}
        </button>
      </Row>
      <AutoUpdateRow bridge={window.milagre} />
      {electron && (
        <Row label="Runtime">
          <span className="tabular-nums">
            Electron {electron} · Chromium {chrome}
          </span>
        </Row>
      )}
      <Row label="License">MIT</Row>
      {[
        { label: "Privacy policy", url: PRIVACY_URL },
        { label: "Support", url: SUPPORT_URL },
      ].map(({ label, url }) => (
        <Row key={url} label={label}>
          <a href={url} target="_blank" rel="noreferrer" className="underline underline-offset-4">
            {url.replace("https://", "")}
          </a>
        </Row>
      ))}
    </Group>
  );
}

/* ─────────────────────────────────────────────────────────
 * FILES TO COPY
 * Ignored files (env files, local secrets) a new worktree gets from
 * the project's main checkout. .gitignore syntax; .worktreeinclude
 * at the repo root wins. The preview runs the same matching.
 * ───────────────────────────────────────────────────────── */
function FilesToCopy({ projectPath }: { projectPath: string }) {
  const [text, setText] = useState<string | null>(null);
  const [found, setFound] = useState<FilesToCopyResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const current = useRef("");
  const saveTimer = useRef<number | null>(null);
  const previewTimer = useRef<number | null>(null);
  const previewSeq = useRef(0);

  const flush = () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next === null) return;
    bridgeForKey(projectPath)
      .saveFilesToCopy(projectPath, parsePatterns(next))
      .then(
        () => setSaveError(null),
        (error) => setSaveError(ipcErrorMessage(error)),
      );
  };

  // The preview runs shortly after typing stops; only the latest answer is shown.
  const refreshPreview = () => {
    const seq = ++previewSeq.current;
    void bridgeForKey(projectPath)
      .previewFilesToCopy(projectPath, parsePatterns(current.current))
      .then(
        (next) => {
          // oxlint-disable-next-line promise/no-callback-in-promise -- the handler receives the resolved value, not a Node-style callback
          if (seq === previewSeq.current) setFound(next);
        },
        () => {},
      );
  };

  // .worktreeinclude can change in an editor while Settings is open.
  useEffect(() => {
    const onFocus = () => refreshPreview();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [projectPath]);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setFound(null);
    setLoadError(null);
    bridgeForKey(projectPath)
      .readFilesToCopy(projectPath)
      .then(
        (saved) => {
          if (cancelled) return;
          current.current = saved.filesToCopy.join("\n");
          setText(current.current);
          setFound(saved);
        },
        (error) => {
          if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
        },
      );
    // Leaving Settings saves what was typed last.
    return () => {
      cancelled = true;
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
      flush();
    };
  }, [projectPath]);

  const edit = (value: string) => {
    setText(value);
    current.current = value;
    pending.current = value;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flush, 600);
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(refreshPreview, 300);
  };

  const locked = found?.source === "worktreeinclude";
  return (
    <div className="grid gap-2 px-4 py-3">
      <label htmlFor="files-to-copy" className="grid gap-0.5">
        <span className="text-[13.5px] font-medium text-ink">Files to copy</span>
        <span className="text-[12px] text-ink-3">
          Git-ignored files copied from the main checkout into each new worktree, such as env files. One pattern per line, .gitignore syntax. Leave empty for{" "}
          {DEFAULT_FILES_TO_COPY}.
        </span>
      </label>
      <textarea
        id="files-to-copy"
        rows={5}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        readOnly={locked}
        disabled={text === null && !loadError}
        value={locked ? (found.worktreeInclude ?? "") : (text ?? "")}
        placeholder={DEFAULT_FILES_TO_COPY}
        onChange={(event) => edit(event.target.value)}
        className={`w-full resize-y rounded-control border border-line px-3 py-2 font-mono text-[12.5px] leading-relaxed text-ink outline-none placeholder:text-ink-3 focus-visible:border-ink-3 ${locked ? "bg-field text-ink-2" : "bg-surface"}`}
      />
      {locked && (
        <p data-files-to-copy-locked className="text-[12px] text-ink-2">
          .worktreeinclude in the repo wins. Edit that file to change what is copied.
        </p>
      )}
      {loadError ? (
        <p className="text-[12px] text-red-ink">Couldn't read this project's files: {loadError}</p>
      ) : (
        <p data-files-to-copy-preview className="break-words text-[12px] text-ink-3">
          {found ? previewSentence(found.matches) : "Checking…"}
        </p>
      )}
      {saveError && (
        <p data-files-to-copy-error className="break-words text-[12px] text-red-ink">
          Couldn't save: {saveError}
        </p>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * SETUP COMMAND
 * Runs once in each new worktree, before the chat's first turn
 * (npm ci, uv sync). "setup" in .milagre/worktree.json at the
 * repo root wins, like .worktreeinclude does for the files.
 * ───────────────────────────────────────────────────────── */
function SetupCommand({ projectPath }: { projectPath: string }) {
  const [text, setText] = useState<string | null>(null);
  const [resolved, setResolved] = useState<WorktreeSetupSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const saveTimer = useRef<number | null>(null);

  const flush = () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next === null) return;
    bridgeForKey(projectPath)
      .saveWorktreeSetup(projectPath, next)
      .then(
        (saved) => {
          setResolved(saved);
          setError(null);
        },
        (failure) => setError(`Couldn't save: ${ipcErrorMessage(failure)}`),
      );
  };

  // .milagre/worktree.json can change in an editor while Settings is open.
  useEffect(() => {
    const onFocus = () =>
      void bridgeForKey(projectPath)
        .readWorktreeSetup(projectPath)
        .then(setResolved, () => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [projectPath]);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setResolved(null);
    setError(null);
    bridgeForKey(projectPath)
      .readWorktreeSetup(projectPath)
      .then(
        (saved) => {
          if (cancelled) return;
          setText(saved.setupCommand);
          setResolved(saved);
        },
        (failure) => {
          if (!cancelled) setError(`Couldn't read the setup command: ${ipcErrorMessage(failure)}`);
        },
      );
    // Leaving Settings saves what was typed last.
    return () => {
      cancelled = true;
      flush();
    };
  }, [projectPath]);

  const edit = (value: string) => {
    setText(value);
    pending.current = value;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flush, 600);
  };

  const locked = resolved?.source === "repo";
  return (
    <div className="grid gap-2 px-4 py-3">
      <label htmlFor="setup-command" className="grid gap-0.5">
        <span className="text-[13.5px] font-medium text-ink">Setup command</span>
        <span className="text-[12px] text-ink-3">Runs once in each new worktree before the agent starts, e.g. npm ci.</span>
      </label>
      <input
        id="setup-command"
        type="text"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        readOnly={locked}
        disabled={text === null && !error}
        value={locked ? (resolved.command ?? "") : (text ?? "")}
        placeholder={locked ? "Nothing runs" : "npm ci"}
        onChange={(event) => edit(event.target.value)}
        className={`h-9 w-full rounded-control border border-line px-3 font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus-visible:border-ink-3 ${locked ? "bg-field text-ink-2" : "bg-surface"}`}
      />
      {locked && (
        <p data-setup-command-locked className="text-[12px] text-ink-2">
          .milagre/worktree.json in the repo wins. Edit its "setup" to change the command.
        </p>
      )}
      {resolved?.note && (
        <p data-setup-command-note className="break-words text-[12px] text-red-ink">
          {resolved.note}
        </p>
      )}
      {error && (
        <p data-setup-command-error className="break-words text-[12px] text-red-ink">
          {error}
        </p>
      )}
    </div>
  );
}

// Icons are scaled down before saving: the phone gets the same image, and a full-size app icon would not fit.
async function iconDataUrl(file: File) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/png");
}

function ProjectIconSetting({ project }: { project: SettingsProject }) {
  const imageOf = useProjectImages([project.path]);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(icon: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    try {
      setProjectImage(project.path, await bridgeForKey(project.path).setProjectIcon(project.path, await icon()));
    } catch (failure) {
      setError(failure instanceof DOMException ? "This file isn't an image Milagre can read." : ipcErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-2 px-4 py-3">
      <div className="flex items-center gap-4">
        <span
          data-project-icon-preview
          className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-ink text-[16px] font-semibold text-surface"
        >
          <WorkspaceIcon src={imageOf(project.path)} fallback={projectInitial(project.name)} />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-[13.5px] font-medium text-ink">Icon</span>
          <span className="text-[12px] text-ink-3">
            Shown in the sidebar, the project switcher and on your phone. Reset goes back to the repository's own icon.
          </span>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          data-project-icon-input
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void save(() => iconDataUrl(file));
          }}
        />
        <button type="button" disabled={busy} data-project-icon-choose onClick={() => input.current?.click()} className={SECONDARY_BUTTON}>
          Choose image
        </button>
        <button type="button" disabled={busy} data-project-icon-reset onClick={() => void save(async () => null)} className={SECONDARY_BUTTON}>
          Reset
        </button>
      </div>
      {error && (
        <p data-project-icon-error className="break-words text-[12px] text-red-ink">
          {error}
        </p>
      )}
    </div>
  );
}

// This Mac's sidebar visibility for the Project.
function ShowInSidebarSetting({ project }: { project: SettingsProject }) {
  const remote = isRemoteKey(project.path);
  const [hidden, setHidden] = useState<boolean | null>(() => (remote ? isRemoteScopeHidden(project.path) : null));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (remote) {
      setHidden(isRemoteScopeHidden(project.path));
      return;
    }
    window.milagre.listRecentProjects().then(
      (list) => setHidden(Boolean(list.find((item) => item.path === project.path)?.hidden)),
      () => setHidden(false),
    );
  }, [project.path, remote]);
  async function change(show: boolean) {
    setError(null);
    setHidden(!show);
    if (remote) {
      setRemoteScopeHidden(project.path, !show);
      return;
    }
    try {
      const list = await window.milagre.setProjectHidden(project.path, !show);
      setHidden(Boolean(list.find((item) => item.path === project.path)?.hidden));
      window.dispatchEvent(new Event(RECENT_PROJECTS_CHANGED));
    } catch (failure) {
      setHidden(show);
      setError(ipcErrorMessage(failure));
    }
  }
  return (
    <div data-show-in-sidebar>
      <Row label="Show in sidebar" description={`In the sidebar on ${thisComputer}. Filters › Projects chooses them all at once.`}>
        <SettingCheckbox label="Show in sidebar" checked={hidden === false} onChange={(show) => void change(show)} />
      </Row>
      {error && <p className="px-4 pb-3 break-words text-[12px] text-red-ink">{error}</p>}
    </div>
  );
}

// The global default for source branch sync; each Project can override it. Kept by the daemon, which runs the sync.
export function MainSyncDefaultSetting() {
  const [syncMain, setSyncMain] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Started inside a promise so a bridge without the command (an older host) reads as off instead of throwing.
    Promise.resolve()
      .then(() => window.milagre.readMainSyncDefault())
      .then(
        (value) => setSyncMain(value?.syncMain === true),
        () => setSyncMain(false),
      );
  }, []);
  async function change(next: boolean) {
    setError(null);
    setSyncMain(next);
    try {
      setSyncMain((await window.milagre.saveMainSyncDefault(next)).syncMain);
    } catch (failure) {
      setSyncMain(!next);
      setError(ipcErrorMessage(failure));
    }
  }
  return (
    <div data-main-sync-default>
      <Row label={MAIN_SYNC_TITLE} description={MAIN_SYNC_HINT}>
        <SettingCheckbox label={MAIN_SYNC_TITLE} checked={syncMain === true} onChange={(next) => void change(next)} />
      </Row>
      {error && <p className="px-4 pb-3 break-words text-[12px] text-red-ink">{error}</p>}
    </div>
  );
}

// Accounts > Switch accounts at usage limits: Mac-owned (core), so a Chat can switch while no window is open.
function LimitAutoSwitchSetting() {
  // null until read.
  const [autoSwitch, setAutoSwitch] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => window.milagre.readLimitAutoSwitch())
      .then(
        (value) => live && setAutoSwitch(value?.autoSwitch === true),
        () => live && setAutoSwitch(false),
      );
    return () => {
      live = false;
    };
  }, []);
  async function change(next: boolean) {
    setError(null);
    setAutoSwitch(next);
    try {
      setAutoSwitch((await window.milagre.saveLimitAutoSwitch(next)).autoSwitch);
    } catch (failure) {
      setAutoSwitch(!next);
      setError(ipcErrorMessage(failure));
    }
  }
  if (autoSwitch === null) return null;
  return (
    <Group title="Usage limits">
      <Row
        label="Switch accounts at usage limits"
        description={
          "When a Chat hits its plan's usage limit, move its Project to the next signed-in account and continue." + (error ? ` Could not save: ${error}` : "")
        }
      >
        <SettingCheckbox label="Switch accounts at usage limits" checked={autoSwitch} onChange={(next) => void change(next)} />
      </Row>
    </Group>
  );
}

// Settings › Connections › Linear: the daemon keeps the switch (phones share it) and the Mac's connections, one per workspace.
function LinearSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  // null until read; a Mac that predates the switch sends none and has it on.
  const [moveToStarted, setMoveToStarted] = useState<boolean | null>(null);
  const [status, setStatus] = useState<LinearStatus | null>(null);
  // "window": Add workspace's own sign-in window; "browser": the first Connect, or the fallback from the window.
  const [connecting, setConnecting] = useState<false | "window" | "browser">(false);
  const [error, setError] = useState<string | null>(null);
  // Connect again replaces a waiting sign-in; only the latest attempt may update the row.
  const attempt = useRef(0);
  const known = useRef(0); // workspaces connected, to tell a finished sign-in from another workspace's disconnect
  known.current = linearWorkspaces(status).length;
  useEffect(() => {
    let live = true;
    // Started inside a promise so a bridge without the command (an older host) reads as off instead of throwing.
    Promise.resolve()
      .then(() => window.milagre.readLinearEnabled())
      .then(
        (value) => {
          if (!live) return;
          setEnabled(value?.enabled === true);
          setMoveToStarted(value?.moveToStarted !== false);
        },
        () => live && setEnabled(false),
      );
    Promise.resolve()
      .then(() => window.milagre.readLinearStatus())
      .then(
        (value) => live && setStatus(value),
        () => live && setStatus({ connected: false }),
      );
    const stop = window.milagre.onLinearStatusChanged?.((next) => {
      if (!live) return;
      const grew = linearWorkspaces(next).length > known.current;
      setStatus(next);
      if (grew) {
        // The sign-in finished: a connect still waiting is over, and a late failure of it must not show.
        attempt.current++;
        setConnecting(false);
        setError(null);
      }
    });
    return () => {
      live = false;
      stop?.();
    };
  }, []);
  async function changeEnabled(next: boolean) {
    setError(null);
    setEnabled(next);
    try {
      setEnabled((await window.milagre.saveLinearEnabled(next)).enabled);
    } catch (failure) {
      setEnabled(!next);
      setError(ipcErrorMessage(failure));
    }
  }
  async function changeMoveToStarted(next: boolean) {
    setError(null);
    setMoveToStarted(next);
    try {
      setMoveToStarted((await window.milagre.saveLinearMoveToStarted(next)).moveToStarted);
    } catch (failure) {
      setMoveToStarted(!next);
      setError(ipcErrorMessage(failure));
    }
  }
  async function connect(inWindow: boolean) {
    const id = ++attempt.current;
    setError(null);
    setConnecting(inWindow ? "window" : "browser");
    try {
      const next = await window.milagre.connectLinear(inWindow ? { window: true } : undefined);
      if (id === attempt.current) setStatus(next);
    } catch (failure) {
      // Closing the sign-in window ends it; the row going back to Add says enough.
      const message = ipcErrorMessage(failure);
      if (id === attempt.current && !message.includes(LINEAR_SIGN_IN_REPLACED)) setError(message);
    } finally {
      if (id === attempt.current) setConnecting(false);
    }
  }
  async function disconnect(workspace: string) {
    setError(null);
    try {
      setStatus(await window.milagre.disconnectLinear(workspace));
    } catch (failure) {
      setError(ipcErrorMessage(failure));
    }
  }
  return (
    <div data-linear-settings data-linear-connected={status?.connected ? "true" : "false"} className="divide-y divide-line">
      <Row label={LINEAR_TITLE} description={LINEAR_HINT}>
        <SettingCheckbox label={LINEAR_TITLE} checked={enabled === true} onChange={(next) => void changeEnabled(next)} />
      </Row>
      {enabled &&
        linearWorkspaces(status).map((workspace) => (
          <Row
            key={workspace.id}
            label={workspace.organization.name}
            description={`Signed in as ${workspace.viewer.name}` + (moveToStarted && workspace.canWrite === false ? `. ${linearReadOnlyHint("mac")}` : "")}
          >
            <button type="button" data-linear-workspace={workspace.id} className={SECONDARY_BUTTON} onClick={() => void disconnect(workspace.id)}>
              Disconnect
            </button>
          </Row>
        ))}
      {enabled && status?.connected && moveToStarted !== null && (
        <Row label={LINEAR_MOVE_TO_STARTED_TITLE} description={LINEAR_MOVE_TO_STARTED_HINT}>
          <SettingCheckbox label={LINEAR_MOVE_TO_STARTED_TITLE} checked={moveToStarted} onChange={(next) => void changeMoveToStarted(next)} />
        </Row>
      )}
      {enabled && status && (
        <Row
          label={status.connected ? LINEAR_ADD_WORKSPACE : linearStatusLine(status, "mac")}
          description={
            connecting === "window" ? LINEAR_CONNECTING_WINDOW : connecting ? LINEAR_CONNECTING : status.connected ? LINEAR_ADD_WORKSPACE_HINT : undefined
          }
        >
          <div className="flex shrink-0 items-center gap-2">
            {connecting === "window" && (
              <button type="button" data-linear-use-browser className={SECONDARY_BUTTON} onClick={() => void connect(false)}>
                {LINEAR_USE_BROWSER}
              </button>
            )}
            {/* Connecting the first workspace keeps the browser's Linear login; another one signs in afresh. Start again
                keeps whichever way the waiting sign-in went. */}
            <button
              type="button"
              data-linear-connect
              className={SECONDARY_BUTTON}
              onClick={() => void connect(connecting ? connecting === "window" : status.connected)}
            >
              {connecting ? "Start again" : status.connected ? "Add" : "Connect"}
            </button>
          </div>
        </Row>
      )}
      {error && <p className="px-4 pb-3 break-words text-[12px] text-red-ink">{error}</p>}
    </div>
  );
}

export function MainSyncSetting({ projectPath }: { projectPath: string }) {
  const [sync, setSync] = useState<MainSyncSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let live = true;
    // Started inside a promise, like the default above, so a bridge without the command shows an error, not a crash.
    Promise.resolve()
      .then(() => bridgeForKey(projectPath).readMainSync(projectPath))
      .then(
        (value) => live && setSync(value ?? null),
        (failure) => live && setError(ipcErrorMessage(failure)),
      );
    const stop = window.milagre.onMainSyncStatus?.((status) => {
      if (status.projectPath !== projectPath) return;
      setNow(Date.now());
      setSync((current) => (current ? { ...current, last: status.last } : current));
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [projectPath]);
  async function change(choice: MainSyncChoice) {
    setError(null);
    try {
      setSync(await bridgeForKey(projectPath).saveMainSync(projectPath, overrideOf(choice)));
    } catch (failure) {
      setError(ipcErrorMessage(failure));
    }
  }
  const title = MAIN_SYNC_TITLE;
  return (
    <div data-main-sync>
      <Row label={title} description={sync ? mainSyncStatusLine(sync.last, now) : undefined}>
        <Select<MainSyncChoice>
          label={title}
          value={choiceOf(sync?.override ?? null)}
          onChange={(choice) => void change(choice)}
          options={mainSyncChoices(sync?.defaultValue ?? false).map((choice) => ({ value: choice.value, label: choice.title }))}
        />
      </Row>
      {error && <p className="px-4 pb-3 break-words text-[12px] text-red-ink">{error}</p>}
    </div>
  );
}

function ProjectSettings({ project, onManageAccounts }: { project: SettingsProject; onManageAccounts: () => void }) {
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <Group title="Appearance">
        <ProjectIconSetting project={project} />
      </Group>
      <Group title="Sidebar">
        <ShowInSidebarSetting project={project} />
      </Group>
      {/* Accounts belong to the computer that runs the Project; only that Mac chooses them. */}
      {!isRemoteKey(project.path) && <ProjectAccountsGroup projectPath={project.path} onManageAccounts={onManageAccounts} />}
      <Group title="Worktrees">
        <MainSyncSetting projectPath={project.path} />
      </Group>
      <Group title="New worktrees">
        <FilesToCopy projectPath={project.path} />
        <SetupCommand projectPath={project.path} />
      </Group>
      <Group title="Remove Project">
        <Row label="Remove from Projects list" description="Files, Worktrees and saved Chats stay on disk. Add the Project again to bring it back.">
          <button type="button" data-project-remove className={DANGER_BUTTON} onClick={() => setRemoving(true)}>
            Remove Project
          </button>
        </Row>
      </Group>
      {removing && <RemoveProjectDialog project={project} onClose={() => setRemoving(false)} />}
    </>
  );
}

export function SettingsPanel({
  section,
  project,
  models,
  update,
  onSectionChange,
  accountScope,
  computerId,
  onAddComputer,
}: {
  computerId?: string;
  /** Opens Add computer, from Settings › Devices. */
  onAddComputer?: () => void;
  onSectionChange?: (section: SettingsSection) => void;
  accountScope?: string;
  section: SettingsSection;
  project?: SettingsProject;
  models: ModelOption[];
  update: UpdateState | null;
}) {
  const { computers } = useComputers();
  const title =
    section === "project"
      ? project?.name
      : section === "computer"
        ? (computers.find((computer) => computer.id === computerId)?.name ?? "Computer")
        : SECTIONS.find((item) => item.key === section)?.label;
  return (
    <ScrollArea className="h-full">
      <div className="mx-auto w-full max-w-[640px] px-6 pt-14 pb-10">
        {/* MCP draws its own title row, with Refresh and Add server beside it; Experimental swaps it for Babysit PRs' page title. */}
        {section !== "mcp" && section !== "experimental" && <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink">{title}</h1>}
        {section === "general" && <GeneralSettings models={models} />}
        {section === "accounts" && (
          <>
            <AccountsSettings />
            <LimitAutoSwitchSetting />
          </>
        )}
        {section === "project-accounts" && (
          <ProjectAccountsSettings projectPath={accountScope ?? project?.path} onManageAccounts={() => onSectionChange?.("accounts")} />
        )}
        {section === "appearance" && <AppearanceSettings />}
        {section === "chat" && <ChatSettings />}
        {section === "keybindings" && <KeybindingsSettings />}
        {section === "browser" && <BrowserSettings />}
        {section === "notifications" && <NotificationsSettings />}
        {section === "routines" && <RoutinesSettings />}
        {section === "connections" && (
          <>
            <p className="mt-1 text-[13px] text-ink-2">Services Milagre signs in to, so Chats can start from their issues.</p>
            <Group title="Issue trackers">
              <LinearSettings />
            </Group>
          </>
        )}
        {section === "skills" &&
          (project ? (
            <SkillsSettings key={project.path} projectPath={project.path} />
          ) : (
            <p className="mt-6 text-[13px] text-ink-3">Open a project to see its skills.</p>
          ))}
        {section === "mcp" && <McpSettings title={title} />}
        {section === "local-mcp" && (
          <>
            <Group title="Designs and artifacts">
              <PublishedPagesSettings />
            </Group>
            <h2 className="mt-6 px-1 text-[12px] font-medium text-ink-3">Milagre MCP</h2>
            <LocalMcpSettings bridge={window.milagre} />
          </>
        )}
        {section === "devices" && <DevicesSettings onAddComputer={onAddComputer} />}
        {section === "experimental" && <ExperimentalSettings title={title} />}
        {section === "computer" && computerId && <ComputerSettings key={computerId} id={computerId} onRemoved={() => onSectionChange?.("devices")} />}
        {section === "about" && <AboutSettings update={update} />}
        {section === "project" && project && <ProjectSettings key={project.path} project={project} onManageAccounts={() => onSectionChange?.("accounts")} />}
      </div>
    </ScrollArea>
  );
}
