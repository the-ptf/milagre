import { ProjectAccountsSettings } from "./ProjectAccountsSettings";
import { AccountsSettings } from "./AccountsSettings";
import { SkillsSettings } from "./SkillsSettings";
import { McpSettings } from "./McpSettings";
import { LocalMcpSettings } from "./LocalMcpSettings";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  BookOpen01Icon,
  BubbleChatIcon,
  ChartColumnIcon,
  KeyboardIcon,
  ConnectIcon,
  ChurchIcon,
  ComputerIcon,
  Globe02Icon,
  InformationCircleIcon,
  LaptopIcon,
  FolderTreeIcon,
  Mic01Icon,
  AiBrain01Icon,
  Notification01Icon,
  PaintBoardIcon,
  Plug01Icon,
  Settings01Icon,
  SmartphoneIcon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";
import { DOT_COLOR, computerTone, useComputers } from "../lib/computers";
import type { UpdateState } from "../electron";
import type { ModelOption } from "../model";
import { GlideGroup } from "./sidebar/GlideGroup";
import { WorktreeCleanup } from "./settings/WorktreeCleanup";
import { CLEANUP_INTRO, CLEANUP_TITLE } from "@milagre/shared/storage";
import { lazyView } from "../lib/lazy-view";
import { SECTION_KEYWORDS, SECTION_TITLES, SETTINGS_INDEX } from "../lib/settings-index";
import { findSetting } from "../lib/settings-find";
import { SettingsSearchField, SettingsSearchResults, useFoundRow, useSettingsSearch, type SettingsSearchItem } from "./settings/SettingsSearch";
import { Group, Row } from "./settings/SettingsGroup";
import { BabysitPrsRow, BabysitPrsSettings } from "./settings/BabysitPrsSettings";
import { KeybindingsSettings } from "./settings/KeybindingsSettings";
import { ScrollArea } from "./primitives/ScrollArea";
import { WorkspaceIcon } from "./WorkspaceIcon";
import { projectRows } from "../lib/project-list";
import type { RecentProject } from "../lib/project-list";
import { useProjectImages } from "../lib/project-images";
import { computerNoun } from "../lib/shortcut-hints";
import { Icon, ChoiceGroup, SECONDARY_BUTTON } from "./settings/settings-parts";
import { AboutSettings } from "./settings/AboutSettings";
import { PhoneSharingPage, ThisMacPage } from "./settings/DevicesSettings";
import { ComputerSettings } from "./settings/ComputerSettings";
import { AppearanceSettings } from "./settings/AppearanceSettings";
import { MainSyncDefaultSetting, DetectRepositoriesSetting } from "./settings/MainSyncSettings";
import { ProjectSettings } from "./settings/ProjectSettings";
import { LinearSettings } from "./settings/LinearSettings";
import { LimitAutoSwitchSetting } from "./settings/LimitAutoSwitchSetting";
import { ChatSettings } from "./settings/ChatSettings";
import { ExperimentalSettings } from "./settings/ExperimentalSettings";
import { NotificationsSettings } from "./settings/NotificationsSettings";
import { VoiceSettings } from "./settings/VoiceSettings";
import { BrowserSettings } from "./settings/BrowserSettings";
import { GeneralSettings } from "./settings/GeneralSettings";
import { ModelsSettings } from "./settings/ModelsSettings";

export type SettingsSection =
  | "general"
  | "appearance"
  | "chat"
  | "voice"
  | "notifications"
  | "keybindings"
  | "models"
  | "accounts"
  | "usage"
  | "skills"
  | "mcp"
  | "browser"
  | "worktrees"
  | "connections"
  | "devices"
  | "this-mac"
  | "experimental"
  | "about"
  | "project"
  | "computer";

/** The nav's groups, top to bottom; `null` has no heading. Computers and Projects follow; Church and About end the list. */
type SectionGroup = null | "Agents" | "Code" | "footer";

const SECTIONS: Array<{
  key: SettingsSection;
  label: string;
  icon: ReactNode;
  group: SectionGroup;
}> = [
  { key: "general", label: SECTION_TITLES.general, icon: <Icon icon={Settings01Icon} />, group: null },
  { key: "appearance", label: SECTION_TITLES.appearance, icon: <Icon icon={PaintBoardIcon} />, group: null },
  { key: "chat", label: SECTION_TITLES.chat, icon: <Icon icon={BubbleChatIcon} />, group: null },
  { key: "voice", label: SECTION_TITLES.voice, icon: <Icon icon={Mic01Icon} />, group: null },
  { key: "notifications", label: SECTION_TITLES.notifications, icon: <Icon icon={Notification01Icon} />, group: null },
  { key: "keybindings", label: SECTION_TITLES.keybindings, icon: <Icon icon={KeyboardIcon} />, group: null },
  { key: "models", label: SECTION_TITLES.models, icon: <Icon icon={AiBrain01Icon} />, group: "Agents" },
  { key: "accounts", label: SECTION_TITLES.accounts, icon: <Icon icon={UserCircleIcon} />, group: "Agents" },
  { key: "usage", label: SECTION_TITLES.usage, icon: <Icon icon={ChartColumnIcon} />, group: "Agents" },
  { key: "skills", label: SECTION_TITLES.skills, icon: <Icon icon={BookOpen01Icon} />, group: "Agents" },
  { key: "mcp", label: SECTION_TITLES.mcp, icon: <Icon icon={Plug01Icon} />, group: "Agents" },
  { key: "browser", label: SECTION_TITLES.browser, icon: <Icon icon={Globe02Icon} />, group: "Agents" },
  { key: "worktrees", label: SECTION_TITLES.worktrees, icon: <Icon icon={FolderTreeIcon} />, group: "Code" },
  { key: "connections", label: SECTION_TITLES.connections, icon: <Icon icon={ConnectIcon} />, group: "Code" },
  { key: "experimental", label: SECTION_TITLES.experimental, icon: <Icon icon={ChurchIcon} />, group: "footer" },
  { key: "about", label: SECTION_TITLES.about, icon: <Icon icon={InformationCircleIcon} />, group: "footer" },
];

// Phone & sharing heads the Computers group, above This Mac's row and one row per paired computer.
const DEVICES_SECTION = { key: "devices" as const, label: SECTION_TITLES.devices, icon: <Icon icon={SmartphoneIcon} /> };
// This Mac's page; the nav names it after the computer, the search as This Mac.
const THIS_MAC_SECTION = { key: "this-mac" as const, label: SECTION_TITLES["this-mac"], icon: <Icon icon={LaptopIcon} /> };

const ALL_SECTIONS = [...SECTIONS, DEVICES_SECTION, THIS_MAC_SECTION];
const SELF_TITLED = new Set<SettingsSection>(["mcp", "connections", "devices", "this-mac", "experimental"]);
const sectionTitle = (page: string) => ALL_SECTIONS.find((item) => item.key === page)?.label ?? page;

export type SettingsProject = { path: string; name: string };

export function SettingsNav({
  section,
  project,
  current,
  computerId,
  onSelect,
  onSelectComputer,
  onSelectProject,
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
}) {
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const { thisMac, computers } = useComputers();
  useEffect(() => {
    window.milagre.listRecentProjects().then(
      (list) => setRecent(list ?? []),
      () => {},
    );
  }, []);
  const currentPath = current?.path;
  const currentName = current?.name;
  const rows = useMemo(() => (currentPath ? projectRows({ recent, currentPath, currentName }) : []), [recent, currentPath, currentName]);
  const imageOf = useProjectImages(rows.map((row) => row.path));
  const [query, setQuery] = useState("");
  // Everything the search can open: the sections, each row in them, then the computers and Projects this nav lists.
  const items = useMemo<SettingsSearchItem[]>(
    () => [
      ...ALL_SECTIONS.map((item) => ({
        key: `section:${item.key}`,
        page: item.key,
        title: item.label,
        keywords: SECTION_KEYWORDS[item.key],
        icon: item.icon,
        open: () => onSelect(item.key),
      })),
      ...SETTINGS_INDEX.map((entry) => ({
        ...entry,
        key: `row:${entry.page}:${entry.group ?? ""}:${entry.title}`,
        open: () => {
          onSelect(entry.page);
          findSetting(entry.page, entry.title);
        },
      })),
      ...computers.map((computer) => ({
        key: `computer:${computer.id}`,
        page: "computer",
        title: computer.name,
        keywords: "computer mac",
        icon: <ComputerDot tone={computerTone(computer)} />,
        open: () => onSelectComputer?.(computer.id),
      })),
      ...(showProjectSettings ? rows : []).map((row) => ({
        key: `project:${row.path}`,
        page: "project",
        title: row.name,
        keywords: "project worktree setup git branch naming template prefix base upstream tracking conventions",
        icon: (
          <span className="flex size-[18px] items-center justify-center overflow-hidden rounded-chip bg-ink text-10 font-semibold text-surface">
            <WorkspaceIcon src={imageOf(row.path)} fallback={row.initial} />
          </span>
        ),
        open: () => onSelectProject({ path: row.path, name: row.name }),
      })),
    ],
    [onSelect, onSelectComputer, onSelectProject, computers, rows, showProjectSettings, imageOf],
  );
  const pageTitle = useCallback((page: string) => (page === "computer" ? "Computers" : page === "project" ? "Projects" : sectionTitle(page)), []);
  const search = useSettingsSearch(items, query, pageTitle);
  const searching = query.trim().length > 0;
  return (
    <aside aria-label="Settings navigation" className="flex h-full w-[248px] shrink-0 flex-col border-r border-line bg-page pt-3">
      <SettingsSearchField
        query={query}
        onQuery={setQuery}
        onMove={search.move}
        onOpen={() => {
          const hit = search.hits[search.active];
          if (hit) (hit.entry as SettingsSearchItem).open();
        }}
      />
      {searching ? (
        <SettingsSearchResults hits={search.hits} active={search.active} pageTitle={pageTitle} onHover={search.setActive} />
      ) : (
        <>
          <ScrollArea className="min-h-0 flex-1 pb-2 [scrollbar-gutter:stable]">
            {([null, "Agents", "Code"] as const).map((group) => (
              <div key={group ?? "top"}>
                {group && <NavHeading>{group}</NavHeading>}
                <GlideGroup>
                  {SECTIONS.filter((item) => item.group === group).map((item) => (
                    <NavRow key={item.key} icon={item.icon} label={item.label} active={section === item.key} onClick={() => onSelect(item.key)} />
                  ))}
                </GlideGroup>
              </div>
            ))}
            <div data-settings-computers>
              <NavHeading>Computers & devices</NavHeading>
              <GlideGroup>
                <NavRow icon={DEVICES_SECTION.icon} label={DEVICES_SECTION.label} active={section === "devices"} onClick={() => onSelect("devices")} />
                <NavRow
                  icon={<ComputerDot tone="online" />}
                  // "This Mac" names itself; a named computer ("Ana's MacBook") still says which one this is.
                  label={thisMac.trim().toLowerCase() === `this ${computerNoun}`.toLowerCase() ? thisMac : `${thisMac} (this ${computerNoun})`}
                  active={section === "this-mac"}
                  onClick={() => onSelect("this-mac")}
                />
                {computers.map((computer) => (
                  <NavRow
                    key={computer.id}
                    icon={<ComputerDot tone={computerTone(computer)} />}
                    label={computer.name}
                    active={section === "computer" && computerId === computer.id}
                    onClick={() => onSelectComputer?.(computer.id)}
                  />
                ))}
              </GlideGroup>
            </div>
            {showProjectSettings && rows.length > 0 && (
              <>
                <NavHeading>Projects</NavHeading>
                <GlideGroup>
                  {rows.map((row) => (
                    <NavRow
                      key={row.path}
                      icon={
                        <span className="flex size-4 items-center justify-center overflow-hidden rounded-inline bg-ink text-10 font-semibold text-surface">
                          <WorkspaceIcon src={imageOf(row.path)} fallback={row.initial} />
                        </span>
                      }
                      label={row.name}
                      active={section === "project" && project?.path === row.path}
                      onClick={() => onSelectProject({ path: row.path, name: row.name })}
                    />
                  ))}
                </GlideGroup>
              </>
            )}
            {/* Church and About end the list rather than sit pinned under it: a pinned footer cut the list short, so a
                group heading could rest on the fold with its rows hidden under the divider. */}
            <div data-settings-footer className="mx-4 mt-3 mb-1 border-t border-line" />
            <GlideGroup>
              {SECTIONS.filter((item) => item.group === "footer").map((item) => (
                <NavRow key={item.key} icon={item.icon} label={item.label} active={section === item.key} onClick={() => onSelect(item.key)} />
              ))}
            </GlideGroup>
          </ScrollArea>
        </>
      )}
    </aside>
  );
}

function NavHeading({ children }: { children: ReactNode }) {
  return <div className="mx-2 mt-3 mb-0.5 flex h-6 items-center px-2 text-11 font-semibold text-ink-3">{children}</div>;
}

/** A Settings nav row: denser than the sidebar's, so every group fits in the modal without scrolling. */
function NavRow({ icon, label, active, onClick }: { icon: ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      data-row
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={`relative z-10 mx-2 flex h-8 w-[calc(100%-16px)] items-center gap-2.5 rounded-control px-2 text-left transition-[background-color,color] duration-fast active:bg-hover-2 ${
        active ? "bg-hover-2 text-ink group-hover/glide:bg-transparent" : "text-ink-2"
      }`}
    >
      <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4">{icon}</span>
      <span data-settings-nav-label className="min-w-0 flex-1 truncate text-13 font-medium">
        {label}
      </span>
    </button>
  );
}

/**
 * A computer's nav glyph: the computer (16, in the row's glyph colour) like every other row's, with its presence dot on
 * the bottom-right corner, cut out of the glyph by a ring in the nav's own page colour.
 */
function ComputerDot({ tone }: { tone: keyof typeof DOT_COLOR }) {
  return (
    <span aria-hidden className="relative flex size-4">
      <Icon icon={ComputerIcon} size={16} />
      <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-page" style={{ background: DOT_COLOR[tone] }} />
    </span>
  );
}

/** Integrations: services Milagre signs in to, and Babysit PRs, which opens its own page. */
function IntegrationsSettings({ title }: { title?: string }) {
  const [page, setPage] = useState<"integrations" | "babysit-prs">("integrations");
  if (page === "babysit-prs") return <BabysitPrsSettings onBack={() => setPage("integrations")} />;
  return (
    <>
      <h1 className="text-22 font-semibold tracking-[-0.01em] text-ink">{title}</h1>
      <p className="mt-1 text-13 text-ink-2">Services Milagre signs in to, so Chats can start from their issues and follow their pull requests.</p>
      <Group title="Issue trackers">
        <LinearSettings />
      </Group>
      <Group title="Pull requests">
        <BabysitPrsRow onOpen={() => setPage("babysit-prs")} />
      </Group>
    </>
  );
}

/** Worktrees on every Project: how they follow main, and cleaning up the ones no Chat uses. Each Project's page sets its own. */
function WorktreesSettings() {
  const [cleaning, setCleaning] = useState(false);
  return (
    <>
      <Group title="Main branch">
        <MainSyncDefaultSetting />
      </Group>
      <Group title="Add Project">
        <DetectRepositoriesSetting />
      </Group>
      <Group title="Storage" footer="Each Project's page sets how its new Worktrees are named and set up.">
        <Row label={CLEANUP_TITLE} description={CLEANUP_INTRO}>
          <button type="button" data-worktrees-cleanup onClick={() => setCleaning(true)} className={SECONDARY_BUTTON}>
            Review
          </button>
        </Row>
      </Group>
      {cleaning && <WorktreeCleanup bridge={window.milagre} computerName={null} onClose={() => setCleaning(false)} />}
    </>
  );
}

// Settings › Usage: the token usage page, loaded when it opens (its charts stay out of the rest of Settings).
const TokenUsagePage = lazyView(() => import("./token-usage/TokenUsagePage").then((module) => module.TokenUsagePage));

export function SettingsPanel({
  section,
  project,
  models,
  update,
  onSectionChange,
  accountScope,
  computerId,
  onAddComputer,
  onOpenUsageChat,
}: {
  /** Opens a Chat named on the Usage page, on the computer whose transcripts it reads. */
  onOpenUsageChat?: (computerId: string, projectPath: string, sessionId: number) => void;
  computerId?: string;
  /** Opens Add computer, from Settings › Phone & sharing. */
  onAddComputer?: () => void;
  onSectionChange?: (section: SettingsSection) => void;
  accountScope?: string;
  section: SettingsSection;
  project?: SettingsProject;
  models: ModelOption[];
  update: UpdateState | null;
}) {
  const { computers, thisMac } = useComputers();
  const title =
    section === "project"
      ? project?.name
      : section === "computer"
        ? (computers.find((computer) => computer.id === computerId)?.name ?? "Computer")
        : section === "this-mac"
          ? thisMac
          : sectionTitle(section);
  const content = useRef<HTMLDivElement>(null);
  // A search result's row lights up once this section shows it.
  useFoundRow(content, section);
  // Usage is a wide page with its own title, scroll and toolbar, so it fills the panel instead of the Settings column.
  if (section === "usage")
    return (
      <div ref={content} className="h-full">
        <TokenUsagePage onOpenChat={onOpenUsageChat} onManageAccounts={() => onSectionChange?.("accounts")} />
      </div>
    );
  return (
    <ScrollArea className="h-full">
      <div ref={content} className="mx-auto w-full max-w-[680px] px-8 pt-8 pb-10">
        {/* These pages draw their own title row: MCP with Refresh and Add server beside it, and the ones that open a sub-page
            (Babysit PRs, Computer use) swap it for that page's title. */}
        {!SELF_TITLED.has(section) && <h1 className="text-22 font-semibold tracking-[-0.01em] text-ink">{title}</h1>}
        {section === "general" && <GeneralSettings />}
        {section === "appearance" && <AppearanceSettings />}
        {section === "chat" && <ChatSettings />}
        {section === "voice" && <VoiceSettings onOpenKeybindings={onSectionChange ? () => onSectionChange("keybindings") : undefined} />}
        {section === "notifications" && <NotificationsSettings />}
        {section === "keybindings" && <KeybindingsSettings />}
        {section === "models" && <ModelsSettings models={models} />}
        {section === "accounts" && (
          <>
            <AccountsSettings />
            <LimitAutoSwitchSetting />
            <ChoiceGroup title="Per Project">
              <ProjectAccountsSettings projectPath={accountScope ?? project?.path} />
            </ChoiceGroup>
          </>
        )}
        {section === "skills" &&
          (project ? (
            <SkillsSettings key={project.path} projectPath={project.path} />
          ) : (
            <p className="mt-6 text-13 text-ink-3">Open a project to see its skills.</p>
          ))}
        {section === "mcp" && (
          <>
            <McpSettings title={title} />
            <h2 className="mt-8 px-1 text-12 font-medium text-ink-3">Milagre MCP</h2>
            <LocalMcpSettings bridge={window.milagre} />
          </>
        )}
        {section === "browser" && <BrowserSettings />}
        {section === "connections" && <IntegrationsSettings title={title} />}
        {section === "worktrees" && <WorktreesSettings />}
        {section === "devices" && <PhoneSharingPage title={title} />}
        {section === "this-mac" && <ThisMacPage title={title} onAddComputer={onAddComputer} />}
        {section === "experimental" && <ExperimentalSettings title={title} />}
        {section === "computer" && computerId && <ComputerSettings key={computerId} id={computerId} onRemoved={() => onSectionChange?.("devices")} />}
        {section === "about" && <AboutSettings update={update} />}
        {section === "project" && project && <ProjectSettings key={project.path} project={project} onManageAccounts={() => onSectionChange?.("accounts")} />}
      </div>
    </ScrollArea>
  );
}
