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
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { CHAT_ROW_FIELDS, type ChatRowField, type ChatRowShow } from "@milagre/shared/chat-row";
import Tooltip from "@/components/primitives/Tooltip";
import { CheckboxBox } from "../primitives/Checkbox";
import { Icon } from "../primitives/Icon";
import { MenuLabel, MenuRow } from "../primitives/Popover";
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
// Popover's panel (primitives/Popover), placed by hand: above the button, with its submenu beside it.
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

  const subRow = (which: Sub, icon: IconSvgElement, label: string, detail?: string) => (
    <MenuRow
      data-sub={which}
      aria-haspopup="menu"
      aria-expanded={sub?.which === which}
      onPointerEnter={(event) => openSub(which, event.currentTarget, false)}
      onClick={(event) => openSub(which, event.currentTarget, true)}
      // The row whose submenu is open keeps the highlight.
      className={sub?.which === which ? "bg-hover-2" : ""}
      icon={icon}
      title={label}
      trailing={
        <>
          {detail && <span className="shrink-0 text-11 font-normal text-ink-3">{detail}</span>}
          <Icon icon={ArrowRight01Icon} size={14} className="shrink-0 text-ink-3" />
        </>
      }
    />
  );

  const projectRow = (project: PickerProject) => (
    <Tooltip key={project.path} label={project.current && !project.shown ? "Shown while it's the open Project" : project.path} wrap asChild>
      <MenuRow
        data-project-choice={project.path}
        role="menuitemcheckbox"
        aria-checked={project.shown}
        disabled={!project.listed}
        onClick={() => onShowProject(project.path, !project.shown)}
        // The row itself is the checkbox (CheckboxBox draws it), so a nested control would be one too many.
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

  return (
    <>
      <Tooltip label={hiddenCount ? `Filters (${hiddenCount} Projects hidden)` : "Filters"} side="bottom" asChild>
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
              <div className="flex flex-col gap-px">
                {projects && subRow("projects", Folder01Icon, "Projects", hiddenCount ? `${hiddenCount} hidden` : undefined)}
                {subRow("show", ViewIcon, "Show")}
              </div>
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
                  <div className="flex flex-col gap-px">
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
                                <div data-project-section-header className={index > 0 ? "mt-1.5" : ""}>
                                  <MenuLabel>
                                    <span className="block truncate">{section.local ? `${section.name} · This Mac` : section.name}</span>
                                  </MenuLabel>
                                </div>
                              )}
                              {section.rows.map(projectRow)}
                            </div>
                          ),
                        )
                      : fields.map((field) => (
                          <MenuRow
                            key={field.id}
                            data-show-field={field.id}
                            checked={show[field.id]}
                            onClick={() => onShowField(field.id, !show[field.id])}
                            icon={FIELD_ICONS[field.id]}
                            title={field.label}
                          />
                        ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </>,
          document.body,
        )}
    </>
  );
}
