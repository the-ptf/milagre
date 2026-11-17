import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { IconSvgElement } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  Clock01Icon,
  FilterIcon,
  Folder01Icon,
  GitBranchIcon,
  GitPullRequestIcon,
  LaptopIcon,
  PlusMinus01Icon,
  Search01Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { CHAT_ROW_FIELDS, type ChatRowField, type ChatRowShow } from "@milagre/shared/chat-row";
import Tooltip from "@/components/primitives/Tooltip";
import { CheckboxBox } from "../primitives/Checkbox";
import { FieldGroup } from "../primitives/Field";
import { Icon } from "../primitives/Icon";
import { MenuLabel, MenuRow } from "../primitives/Popover";
import { ProjectAvatar } from "../primitives/ProjectAvatar";
import { ScrollArea } from "../primitives/ScrollArea";
import { LinearLogo } from "../ProviderLogo";
import { useDismiss } from "../../lib/use-dismiss";
import { bySection, type ComputerSection } from "../../lib/computer-scopes";
import { ThisComputer } from "../../lib/shortcut-hints";
import { computerTone, useComputers, useHiddenComputers } from "../../lib/computers";
import { useSettings } from "../../lib/settings";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { matchesProjectQuery } from "@milagre/shared/project-list";
import { ComputersMenu } from "./ComputersMenu";

export type PickerProject = { path: string; name: string; initial: string; current: boolean; shown: boolean; listed: boolean; computerId: string };

const FIELD_ICONS: Record<ChatRowField, ReactNode> = {
  computer: <Icon icon={LaptopIcon} />,
  pullRequests: <Icon icon={GitPullRequestIcon} />,
  linearIssue: <LinearLogo size={14} />,
  branch: <Icon icon={GitBranchIcon} />,
  diff: <Icon icon={PlusMinus01Icon} />,
  lastActivity: <Icon icon={Clock01Icon} />,
};

type Sub = "computers" | "projects" | "show";
const SUB_WIDTH: Record<Sub, number> = { computers: 272, projects: 256, show: 208 };
const MAIN_WIDTH = 232;
const PANEL = "fixed z-50 flex flex-col overflow-hidden rounded-card bg-surface shadow-raised";
const rowsOf = (panel: HTMLElement | null) => [...(panel?.querySelectorAll<HTMLElement>("[data-menu-row]:not(:disabled)") ?? [])];

export function FiltersButton({
  projects,
  computerMenu,
  computers,
  imageOf,
  currentImage,
  onShowProject,
  show,
  offerComputer,
  onShowField,
  collapsed,
  className,
}: {
  projects: PickerProject[] | null;
  computerMenu?: { onAddComputer: () => void; onOpenSettings: (id: string | null) => void } | null;
  computers: ComputerSection[] | null;
  imageOf: (path: string) => string | null | undefined;
  currentImage?: string | null;
  onShowProject: (path: string, show: boolean) => void;
  show: ChatRowShow;
  offerComputer: boolean;
  onShowField: (field: ChatRowField, show: boolean) => void;
  collapsed: boolean;
  className: string;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ bottom: 0, left: 0 });
  const [sub, setSub] = useState<{ which: Sub; top: number; bottom: number; focus: boolean } | null>(null);
  const [subHeight, setSubHeight] = useState(0);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const hiddenCount = projects?.filter((project) => !project.shown).length ?? 0;
  const { otherComputers } = useSettings();
  const { computers: paired } = useComputers();
  const hiddenComputers = useHiddenComputers();
  const offerComputers = otherComputers && !!computerMenu;
  const hiddenComputerCount = offerComputers ? [LOCAL_COMPUTER, ...paired.map((computer) => computer.id)].filter((id) => hiddenComputers.has(id)).length : 0;
  const anyAway = offerComputers && paired.some((computer) => computerTone(computer) !== "online");
  const filtering = hiddenCount > 0 || hiddenComputerCount > 0;
  const [now, setNow] = useState(0);
  const fields = CHAT_ROW_FIELDS.filter((field) => field.id !== "computer" || offerComputer);

  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return false;
    setPosition(
      collapsed ? { bottom: window.innerHeight - rect.bottom, left: rect.right + 8 } : { bottom: window.innerHeight - rect.top + 6, left: rect.left },
    );
    return true;
  };
  const clearSearch = () => setQuery("");
  const close = () => {
    setOpen(false);
    setSub(null);
    clearSearch();
  };
  useDismiss(open, close, (target) => !!target.closest("[data-filters], [data-filters-panel]"), place);
  useLayoutEffect(() => {
    if (open) rowsOf(panelRef.current)[0]?.focus();
  }, [open]);
  useLayoutEffect(() => {
    if (!sub?.focus) return;
    if (sub.which === "projects") searchRef.current?.focus();
    else rowsOf(subRef.current)[0]?.focus();
  }, [sub]);
  const subPanelRef = useCallback((panel: HTMLDivElement | null) => {
    subRef.current = panel;
    if (!panel) return;
    setSubHeight(panel.offsetHeight);
    const observer = new ResizeObserver(() => setSubHeight(panel.offsetHeight));
    observer.observe(panel);
    return () => {
      observer.disconnect();
      subRef.current = null;
    };
  }, []);

  const openSub = (which: Sub, row: HTMLElement, focus: boolean) => {
    const rect = row.getBoundingClientRect();
    if (sub?.which !== which) clearSearch();
    setSub((current) => (current?.which === which && !focus ? current : { which, top: rect.top - 6, bottom: window.innerHeight - rect.bottom - 6, focus }));
  };
  const step = (event: ReactKeyboardEvent, rows: HTMLElement[]) => {
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    rows[(index + delta + rows.length) % rows.length]?.focus();
  };
  const mainKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const active = document.activeElement as HTMLElement | null;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      step(event, rowsOf(panelRef.current));
    } else if (event.key === "ArrowRight" && active?.dataset.sub) {
      event.preventDefault();
      openSub(active.dataset.sub as Sub, active, true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
      buttonRef.current?.focus();
    } else if (event.key === "Tab") event.preventDefault();
  };
  const subKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const searching = event.target === searchRef.current;
    if (sub?.which === "projects" && searchKeys(event, searchRef.current, query, clearSearch)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      step(event, rowsOf(subRef.current));
    } else if ((event.key === "ArrowLeft" && !searching) || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const which = sub?.which;
      setSub(null);
      panelRef.current?.querySelector<HTMLElement>(`[data-sub="${which}"]`)?.focus();
    } else if (event.key === "Tab") event.preventDefault();
  };
  const upward = sub?.which === "projects" && sub.top > window.innerHeight / 2;

  const subRow = (which: Sub, icon: IconSvgElement, label: string, detail?: string, dot?: boolean) => (
    <MenuRow
      data-sub={which}
      aria-haspopup="menu"
      aria-expanded={sub?.which === which}
      onPointerEnter={(event) => openSub(which, event.currentTarget, false)}
      onClick={(event) => openSub(which, event.currentTarget, true)}
      className={sub?.which === which ? "bg-hover-2" : ""}
      icon={icon}
      title={label}
      trailing={
        <>
          {dot && <span aria-hidden data-filters-away className="size-1.5 shrink-0 rounded-full bg-orange" />}
          {detail && <span className="shrink-0 text-11 font-normal text-ink-3">{detail}</span>}
          <Icon icon={ArrowRight01Icon} size={14} className="shrink-0 text-ink-3" />
        </>
      }
    />
  );

  return (
    <>
      <Tooltip label={filtersLabel(hiddenComputerCount, hiddenCount)} side="bottom" asChild>
        <button
          ref={buttonRef}
          type="button"
          aria-label="Filters"
          aria-haspopup="menu"
          aria-expanded={open}
          data-filters
          data-filters-active={filtering || undefined}
          data-computers-on={offerComputers || undefined}
          onClick={() => {
            if (open) return close();
            setNow(Date.now());
            if (place()) setOpen(true);
          }}
          className={`${className} relative ${open ? "bg-hover-2 text-ink" : filtering ? "text-ink" : ""}`}
        >
          <Icon icon={FilterIcon} size={16} />
          {(anyAway || filtering) && (
            <span
              aria-hidden
              data-filters-dot={anyAway ? "away" : "filtering"}
              className={`absolute top-1 right-1 size-1.5 rounded-full ${anyAway ? "bg-orange" : "bg-accent"}`}
            />
          )}
        </button>
      </Tooltip>
      {open &&
        createPortal(
          <>
            <div
              ref={panelRef}
              role="menu"
              aria-label="Filters"
              onKeyDown={mainKeys}
              data-filters-panel
              className={`${PANEL} p-1.5`}
              style={{
                width: MAIN_WIDTH,
                bottom: position.bottom,
                left: position.left,
                animation: "pop-in var(--duration-base) var(--ease-enter) backwards",
                transformOrigin: "bottom left",
              }}
            >
              <div className="flex flex-col gap-px">
                {offerComputers && subRow("computers", LaptopIcon, "Computers", hiddenComputerCount ? `${hiddenComputerCount} hidden` : undefined, anyAway)}
                {projects && subRow("projects", Folder01Icon, "Projects", hiddenCount ? `${hiddenCount} hidden` : undefined)}
                {subRow("show", ViewIcon, "Show")}
              </div>
            </div>
            {sub && (
              <div
                ref={subPanelRef}
                role="menu"
                aria-label={sub.which === "computers" ? "Computers in the sidebar" : sub.which === "projects" ? "Projects in the sidebar" : "Show on chats"}
                onKeyDown={subKeys}
                data-filters-panel
                data-filters-sub={sub.which}
                className={`${PANEL} max-h-[min(420px,calc(100vh-16px))]`}
                style={{
                  width: SUB_WIDTH[sub.which],
                  ...(upward
                    ? { bottom: Math.max(8, sub.bottom), maxHeight: Math.min(420, window.innerHeight - Math.max(8, sub.bottom) - 8) }
                    : { top: Math.max(8, Math.min(sub.top, window.innerHeight - 8 - subHeight)) }),
                  left: position.left + MAIN_WIDTH + 6,
                  animation: "pop-in var(--duration-fast) var(--ease-enter) backwards",
                  transformOrigin: upward ? "bottom left" : "top left",
                }}
              >
                {sub.which === "projects" ? (
                  <ProjectsMenu
                    projects={projects ?? []}
                    computers={computers}
                    query={query}
                    onQuery={setQuery}
                    searchAt={upward ? "bottom" : "top"}
                    searchRef={searchRef}
                    imageOf={imageOf}
                    currentImage={currentImage}
                    onShowProject={onShowProject}
                  />
                ) : (
                  <ScrollArea className="p-1.5">
                    <div className="flex flex-col gap-px">
                      {sub.which === "computers" && computerMenu ? (
                        <ComputersMenu now={now} onAddComputer={computerMenu.onAddComputer} onOpenSettings={computerMenu.onOpenSettings} onPicked={close} />
                      ) : (
                        fields.map((field) => (
                          <MenuRow
                            key={field.id}
                            data-show-field={field.id}
                            checked={show[field.id]}
                            onClick={() => onShowField(field.id, !show[field.id])}
                            icon={FIELD_ICONS[field.id]}
                            title={field.label}
                          />
                        ))
                      )}
                    </div>
                  </ScrollArea>
                )}
              </div>
            )}
          </>,
          document.body,
        )}
    </>
  );
}

/** The Projects submenu's search keys: Enter toggles the first match, Escape clears the query, typing on a row searches. */
function searchKeys(event: ReactKeyboardEvent<HTMLDivElement>, input: HTMLInputElement | null, query: string, clear: () => void): boolean {
  if (event.target === input) {
    if (event.key === "Enter" && query.trim() && !event.nativeEvent.isComposing) {
      event.preventDefault();
      rowsOf(event.currentTarget)
        .find((row) => row !== input)
        ?.click();
      return true;
    }
    if (event.key === "Escape" && query) {
      event.preventDefault();
      event.stopPropagation();
      clear();
      return true;
    }
    return false;
  }
  if (event.key.length !== 1 || event.key === " " || event.metaKey || event.ctrlKey || event.altKey) return false;
  input?.focus();
  return true;
}

function ProjectsMenu({
  projects,
  computers,
  query,
  onQuery,
  searchAt,
  searchRef,
  imageOf,
  currentImage,
  onShowProject,
}: {
  projects: PickerProject[];
  computers: ComputerSection[] | null;
  query: string;
  onQuery: (query: string) => void;
  searchAt: "top" | "bottom";
  searchRef: RefObject<HTMLInputElement | null>;
  imageOf: (path: string) => string | null | undefined;
  currentImage?: string | null;
  onShowProject: (path: string, show: boolean) => void;
}) {
  const matching = projects.filter((project) => matchesProjectQuery(query, [project.name, project.path]));
  const projectRow = (project: PickerProject) => (
    <Tooltip key={project.path} label={project.current && !project.shown ? "Shown while it's the open Project" : project.path} wrap asChild>
      <MenuRow
        data-project-choice={project.path}
        role="menuitemcheckbox"
        aria-checked={project.shown}
        disabled={!project.listed}
        onClick={() => onShowProject(project.path, !project.shown)}
        icon={<CheckboxBox checked={project.shown} />}
        title={
          <span className="flex min-w-0 items-center gap-2">
            <ProjectAvatar name={project.name} initial={project.initial} src={project.current ? currentImage : imageOf(project.path)} />
            <span className={`min-w-0 truncate ${project.shown ? "" : "text-ink-3"}`}>{project.name}</span>
          </span>
        }
        trailing={project.current ? "Open" : undefined}
      />
    </Tooltip>
  );

  const search = (
    <div className={`shrink-0 px-1.5 ${searchAt === "top" ? "pt-1.5" : "pb-1.5"}`}>
      <FieldGroup
        ref={searchRef}
        size={32}
        fill="bare"
        className="pl-[7px]"
        data-menu-row
        data-project-search
        aria-label="Search Projects"
        placeholder="Search Projects"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        leading={<Icon icon={Search01Icon} size={14} className="shrink-0 text-ink-3" />}
      />
    </div>
  );

  return (
    <>
      {searchAt === "top" && search}
      <ScrollArea className="p-1.5">
        <div className="flex flex-col gap-px">
          {!matching.length && query.trim() && (
            <div data-project-search-empty className="px-2 py-4 text-center text-12 text-ink-3">
              No Projects match “{query.trim()}”
            </div>
          )}
          {(computers ? bySection(matching, computers) : [{ id: "", name: "", local: false, rows: matching }]).map((section, index) => (
            <div
              key={section.id}
              role="group"
              aria-label={computers ? section.name : undefined}
              data-project-section={section.id || undefined}
              className="flex flex-col gap-px"
            >
              {computers && (
                <div data-project-section-header className={index > 0 ? "mt-1.5" : ""}>
                  <MenuLabel>
                    <span className="block truncate">{section.local ? `${section.name} · ${ThisComputer}` : section.name}</span>
                  </MenuLabel>
                </div>
              )}
              {section.rows.map(projectRow)}
            </div>
          ))}
        </div>
      </ScrollArea>
      {searchAt === "bottom" && search}
    </>
  );
}

function filtersLabel(computers: number, projects: number): string {
  const parts = [
    computers ? `${computers} ${computers === 1 ? "computer" : "computers"} hidden` : "",
    projects ? `${projects} ${projects === 1 ? "Project" : "Projects"} hidden` : "",
  ].filter(Boolean);
  return parts.length ? `Filters (${parts.join(", ")})` : "Filters";
}
