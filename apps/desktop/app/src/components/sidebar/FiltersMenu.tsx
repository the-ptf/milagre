import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { IconSvgElement } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  Clock01Icon,
  FilterHorizontalIcon,
  Folder01Icon,
  GitBranchIcon,
  GitPullRequestIcon,
  LaptopIcon,
  PlusMinus01Icon,
  Tick02Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { CHAT_ROW_FIELDS, type ChatRowField, type ChatRowShow } from "@milagre/shared/chat-row";
import GlideMenu from "@/components/primitives/GlideMenu";
import Tooltip from "@/components/primitives/Tooltip";
import { Icon } from "../primitives/Icon";
import { ProjectAvatar } from "../primitives/ProjectAvatar";
import { ScrollArea } from "../primitives/ScrollArea";
import { LinearLogo } from "../ProviderLogo";
import { useDismiss } from "../../lib/use-dismiss";
import { bySection, type ComputerSection } from "../../lib/computer-scopes";

type HugeIconData = IconSvgElement;

/** One Project in the chooser, under its computer's section once there are two or more computers. */
export type PickerProject = { path: string; name: string; initial: string; current: boolean; shown: boolean; listed: boolean; computerId: string };

const FIELD_ICONS: Record<ChatRowField, ReactNode> = {
  computer: <Icon icon={LaptopIcon} />,
  pullRequests: <Icon icon={GitPullRequestIcon} />,
  linearIssue: <LinearLogo size={14} />,
  branch: <Icon icon={GitBranchIcon} />,
  diff: <Icon icon={PlusMinus01Icon} />,
  lastActivity: <Icon icon={Clock01Icon} />,
};

// FilterHorizontalIcon with its two knobs filled: the button's look while a filter is on (the free set has no filled style).
const FilterHorizontalFilledIcon: HugeIconData = FilterHorizontalIcon.map(([tag, attrs]) =>
  attrs.key === "4" || attrs.key === "5" ? [tag, { ...attrs, fill: "currentColor" }] : [tag, attrs],
) as HugeIconData;

type Sub = "projects" | "show";
const ROW =
  "relative z-10 flex h-9 w-full items-center gap-2 rounded-control px-2 text-left focus-visible:bg-hover-2 focus-visible:-outline-offset-2 disabled:opacity-40";
const PANEL = "fixed z-50 flex flex-col overflow-hidden rounded-card bg-surface shadow-raised";
const rowsOf = (panel: HTMLElement | null) => [...(panel?.querySelectorAll<HTMLElement>("[data-menu-row]:not(:disabled)") ?? [])];

/**
 * The sidebar's Filters: which Projects and Links this Mac's sidebar lists and what a chat row's second line shows
 * (both kept per Mac). Projects › and Show › open beside the menu.
 */
export function FiltersButton({
  projects,
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
  /** Null when the sidebar lists only the open Project, so there is nothing to choose. */
  projects: PickerProject[] | null;
  /** With other computers, the sections Projects are listed under; null with this Mac alone. A hidden computer's Projects aren't passed. */
  computers: ComputerSection[] | null;
  imageOf: (path: string) => string | null | undefined;
  currentImage?: string | null;
  onShowProject: (path: string, show: boolean) => void;
  show: ChatRowShow;
  /** Two or more computers: the computer is something a row can show. */
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
  const [sub, setSub] = useState<{ which: Sub; top: number; focus: boolean } | null>(null);
  const hiddenCount = projects?.filter((project) => !project.shown).length ?? 0;
  const fields = CHAT_ROW_FIELDS.filter((field) => field.id !== "computer" || offerComputer);

  // Above the button, at the foot of the sidebar; collapsed, beside the rail.
  const place = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return false;
    setPosition(
      collapsed ? { bottom: window.innerHeight - rect.bottom, left: rect.right + 8 } : { bottom: window.innerHeight - rect.top + 6, left: rect.left },
    );
    return true;
  };
  const close = () => {
    setOpen(false);
    setSub(null);
  };
  useDismiss(open, close, (target) => !!target.closest("[data-filters], [data-filters-panel]"), place);
  useLayoutEffect(() => {
    if (open) rowsOf(panelRef.current)[0]?.focus();
  }, [open]);
  useLayoutEffect(() => {
    if (sub?.focus) rowsOf(subRef.current)[0]?.focus();
  }, [sub]);

  const openSub = (which: Sub, row: HTMLElement, focus: boolean) => {
    const top = row.getBoundingClientRect().top - 6;
    setSub((current) => (current?.which === which && !focus ? current : { which, top, focus }));
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
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      step(event, rowsOf(subRef.current));
    } else if (event.key === "ArrowLeft" || event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const which = sub?.which;
      setSub(null);
      panelRef.current?.querySelector<HTMLElement>(`[data-sub="${which}"]`)?.focus();
    } else if (event.key === "Tab") event.preventDefault();
  };

  const subRow = (which: Sub, icon: ReactNode, label: string, detail?: string) => (
    <button
      data-menu-row
      data-sub={which}
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={sub?.which === which}
      onPointerEnter={(event) => openSub(which, event.currentTarget, false)}
      onClick={(event) => openSub(which, event.currentTarget, true)}
      className={`${ROW} ${sub?.which === which ? "bg-hover-2" : ""}`}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-ink-2">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-13 text-ink">{label}</span>
      {detail && <span className="shrink-0 text-12 text-ink-3">{detail}</span>}
      <span className="flex shrink-0 text-ink-3">
        <Icon icon={ArrowRight01Icon} size={14} />
      </span>
    </button>
  );

  const projectRow = (project: PickerProject) => (
    <Tooltip key={project.path} label={project.current && !project.shown ? "Shown while it's the open project" : project.path} wrap className="w-full">
      <button
        data-menu-row
        data-project-choice={project.path}
        role="menuitemcheckbox"
        aria-checked={project.shown}
        type="button"
        disabled={!project.listed}
        onClick={() => onShowProject(project.path, !project.shown)}
        className={ROW}
      >
        {/* The Checkbox primitive's look: the row itself is the checkbox, so a nested control would be one too many. */}
        <span
          aria-hidden
          className={`flex size-4 shrink-0 items-center justify-center rounded-inline border transition-colors duration-fast ${project.shown ? "border-ink bg-ink text-on-ink" : "border-ink-3"}`}
        >
          {project.shown && <Icon icon={Tick02Icon} size={14} />}
        </span>
        <ProjectAvatar name={project.name} initial={project.initial} src={project.current ? currentImage : imageOf(project.path)} />
        <span className={`min-w-0 flex-1 truncate text-13 ${project.shown ? "text-ink" : "text-ink-3"}`}>{project.name}</span>
        {project.current && <span className="shrink-0 text-11 text-ink-3">Open</span>}
      </button>
    </Tooltip>
  );

  return (
    <>
      <Tooltip label={hiddenCount ? `Filters (${hiddenCount} projects hidden)` : "Filters"} side="bottom">
        <button
          ref={buttonRef}
          type="button"
          aria-label="Filters"
          aria-haspopup="menu"
          aria-expanded={open}
          data-filters
          data-filters-active={hiddenCount > 0 || undefined}
          onClick={() => (open ? close() : place() && setOpen(true))}
          className={`${className} relative ${open ? "bg-hover-2 text-ink" : hiddenCount > 0 ? "text-ink" : ""}`}
        >
          {/* A filter on fills the icon's knobs; off, they stay outlined. */}
          <Icon icon={hiddenCount > 0 ? FilterHorizontalFilledIcon : FilterHorizontalIcon} size={16} />
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
              className={`${PANEL} w-52 p-1.5`}
              style={{
                bottom: position.bottom,
                left: position.left,
                animation: "pop-in var(--duration-base) var(--ease-enter) both",
                transformOrigin: "bottom left",
              }}
            >
              <GlideMenu
                className="flex flex-col gap-px"
                rowSelector="[data-menu-row]:not(:disabled)"
                highlightClassName="inset-x-0 rounded-control bg-hover-2"
              >
                {projects && subRow("projects", <Icon icon={Folder01Icon} />, "Projects", hiddenCount ? `${hiddenCount} hidden` : undefined)}
                {subRow("show", <Icon icon={ViewIcon} />, "Show")}
              </GlideMenu>
            </div>
            {sub && (
              <div
                ref={subRef}
                role="menu"
                aria-label={sub.which === "projects" ? "Projects in the sidebar" : "Show on chats"}
                onKeyDown={subKeys}
                data-filters-panel
                data-filters-sub={sub.which}
                className={`${PANEL} max-h-[min(420px,calc(100vh-16px))] ${sub.which === "projects" ? "w-64" : "w-52"}`}
                style={{
                  top: Math.max(8, Math.min(sub.top, window.innerHeight - 16 - (sub.which === "projects" ? 420 : 260))),
                  left: position.left + 208 + 6,
                  animation: "pop-in var(--duration-fast) var(--ease-enter) both",
                  transformOrigin: "top left",
                }}
              >
                <ScrollArea className="p-1.5">
                  <GlideMenu
                    className="flex flex-col gap-px"
                    rowSelector="[data-menu-row]:not(:disabled)"
                    highlightClassName="inset-x-0 rounded-control bg-hover-2"
                  >
                    {sub.which === "projects"
                      ? (computers ? bySection(projects ?? [], computers) : [{ id: "", name: "", local: false, rows: projects ?? [] }]).map(
                          (section, index) => (
                            <div
                              key={section.id}
                              role="group"
                              aria-label={computers ? section.name : undefined}
                              data-project-section={section.id || undefined}
                              className="flex flex-col gap-px"
                            >
                              {computers && (
                                <div
                                  data-project-section-header
                                  className={`flex h-7 items-center px-2 text-11 font-medium text-ink-3 ${index > 0 ? "mt-1.5" : ""}`}
                                >
                                  <span className="min-w-0 truncate">{section.local ? `${section.name} · This Mac` : section.name}</span>
                                </div>
                              )}
                              {section.rows.map(projectRow)}
                            </div>
                          ),
                        )
                      : fields.map((field) => (
                          <button
                            key={field.id}
                            data-menu-row
                            data-show-field={field.id}
                            role="menuitemcheckbox"
                            aria-checked={show[field.id]}
                            type="button"
                            onClick={() => onShowField(field.id, !show[field.id])}
                            className={ROW}
                          >
                            <span className="flex size-5 shrink-0 items-center justify-center text-ink-2">{FIELD_ICONS[field.id]}</span>
                            <span className="min-w-0 flex-1 truncate text-13 text-ink">{field.label}</span>
                            {show[field.id] && (
                              <span className="flex shrink-0 text-ink-2">
                                <Icon icon={Tick02Icon} size={14} />
                              </span>
                            )}
                          </button>
                        ))}
                  </GlideMenu>
                </ScrollArea>
              </div>
            )}
          </>,
          document.body,
        )}
    </>
  );
}
