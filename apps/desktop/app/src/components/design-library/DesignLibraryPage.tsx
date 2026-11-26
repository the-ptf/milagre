import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LibraryIcon, MoreHorizontalIcon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import {
  DESIGNS_COPY,
  libraryCardLine,
  libraryRecent,
  libraryRecentLine,
  type DesignLibraryEntry,
  type DesignLibraryPage as LibraryPage,
} from "@milagre/shared/artifact";
import type { DesignLibraryTarget } from "../../lib/design-library-page";
import { IconButton } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { MenuRow, Popover } from "../primitives/Popover";
import { ScrollArea } from "../primitives/ScrollArea";
import { SectionLabel } from "../primitives/SectionLabel";
import { useControlsClearance } from "../../lib/window-chrome";
import { libraryRefs, useDesignLibrary } from "../agents/design-library";
import { LibraryActionDialog, type LibraryAction } from "./LibraryDialogs";
import { LibraryBoard } from "./LibraryBoard";
import { DesignSystemPanel } from "./DesignSystemPanel";
import { DesignChatsPanel } from "./DesignChatsPanel";

const ALL = "all";
type Section = "system" | "library" | "chats";
const RECENT = 6;

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function TopBar({ title }: { title: string }) {
  const { bar, inset } = useControlsClearance<HTMLDivElement>(true);
  return (
    <div ref={bar} style={inset} data-slot="library-top-bar" className="absolute inset-x-3 top-[var(--window-chrome-top)] z-[55] flex h-8 items-center gap-1.5">
      <span data-slot="library-title" className="min-w-0 truncate text-13 font-medium text-ink select-none">
        {title}
      </span>
    </div>
  );
}

/**
 * A Project's Design library, a page of the window's main area: its library pages and its most recent edits down the
 * left, and the chosen page's designs side by side on the canvas, All laying out one row per page. Reads the library by
 * the Project, so it opens without a Chat and follows every change from any Chat.
 */
export function DesignLibraryPage({ target }: { target: DesignLibraryTarget }) {
  const { projectKey } = target;
  const library = useDesignLibrary(projectKey);
  const pages = useMemo(() => library?.pages ?? [], [library]);
  const [section, setSection] = useState<Section>("system");
  const [tab, setTab] = useState(ALL);
  const [focus, setFocus] = useState<{ id: string | null; nonce: number }>({ id: null, nonce: 0 });
  const [action, setAction] = useState<LibraryAction | null>(null);
  const now = useNow();
  const page = pages.find((item) => item.id === tab);
  const designs = useMemo(
    () => (page ? libraryRefs(page) : pages.flatMap((item) => libraryRefs(item).map((ref) => ({ ...ref, group: item.name })))),
    [page, pages],
  );
  const entries = useMemo(() => new Map(pages.flatMap((item) => item.designs.map((design) => [design.id, design] as const))), [pages]);
  const show = (next: string, id: string | null = null) => {
    setSection("library");
    setTab(next);
    setFocus((current) => ({ id, nonce: current.nonce + 1 }));
  };
  return (
    <section data-slot="design-library-page" aria-label={`${target.name} · ${DESIGNS_COPY.title}`} className="relative flex min-h-0 flex-1 flex-col">
      <TopBar title={`${target.name} · ${DESIGNS_COPY.title}`} />
      <div className="flex min-h-0 flex-1 pt-[var(--window-chrome-height)]">
        <aside data-slot="library-rail" aria-label="Design system, library pages and Chats" className="relative flex w-60 shrink-0 flex-col">
          <span
            aria-hidden
            data-slot="library-rail-edge"
            className="pointer-events-none absolute inset-y-0 right-0 w-px bg-[linear-gradient(to_bottom,transparent,var(--color-line)_96px,var(--color-line)_calc(100%-96px),transparent)]"
          />
          <ScrollArea className="flex-1 pb-4">
            <nav aria-label="Designs sections" className="mt-3">
              <RailRow section="system" active={section === "system"} label={DESIGNS_COPY.designSystem} onClick={() => setSection("system")} />
            </nav>
            <nav aria-label="Library pages">
              <RailHeading>Library</RailHeading>
              <RailRow
                active={section === "library" && !page}
                label="All designs"
                count={pages.reduce((sum, item) => sum + item.designs.length, 0)}
                onClick={() => show(ALL)}
              />
              {pages.map((item) => (
                <RailRow
                  key={item.id}
                  page={item.id}
                  active={section === "library" && page?.id === item.id}
                  label={item.name}
                  count={item.designs.length}
                  onClick={() => show(item.id)}
                  menu={<PageMenu page={item} onRename={() => setAction({ kind: "rename-page", page: item })} />}
                />
              ))}
            </nav>
            <RecentEdits library={library} now={now} onOpen={(design) => show(page && page.id !== design.page ? design.page : (page?.id ?? ALL), design.id)} />
            <nav aria-label="Chats">
              <RailHeading>{DESIGNS_COPY.chats}</RailHeading>
              <RailRow section="chats" active={section === "chats"} label="All Chats" onClick={() => setSection("chats")} />
            </nav>
          </ScrollArea>
        </aside>
        {section === "system" && <DesignSystemPanel projectKey={projectKey} now={now} />}
        {section === "chats" && <DesignChatsPanel projectKey={projectKey} library={library} />}
        {section === "library" && !pages.length && library && (
          <EmptyState icon={LibraryIcon} title="No designs in this Project's library yet" size="page" data-slot="library-empty">
            Add one from a design's ⋯ menu in a Chat's Artifact panel or from Chats here, or ask an agent to add it. Every Chat in this Project can then open
            it.
          </EmptyState>
        )}
        {section === "library" && pages.length > 0 && (
          <LibraryBoard
            key={page?.id ?? ALL}
            projectKey={projectKey}
            designs={designs}
            focus={focus}
            onEdit={(ref, kind) => {
              const design = entries.get(ref.id);
              if (design) setAction({ kind, design });
            }}
          />
        )}
      </div>
      {action && <LibraryActionDialog projectKey={projectKey} pages={pages} action={action} onClose={() => setAction(null)} />}
    </section>
  );
}

function RailHeading({ children }: { children: ReactNode }) {
  return (
    <SectionLabel as="h2" className="mx-2 mt-3 mb-0.5 flex h-6 items-center px-2">
      {children}
    </SectionLabel>
  );
}

function RailRow({
  page,
  section,
  active,
  label,
  count,
  onClick,
  menu,
}: {
  page?: string;
  section?: string;
  active: boolean;
  label: string;
  count?: number;
  onClick: () => void;
  menu?: ReactNode;
}) {
  return (
    <div
      data-slot={section ? "designs-section-row" : "library-page-row"}
      data-page={section ?? page ?? ALL}
      className="group/row relative mx-2 flex items-center"
    >
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={onClick}
        className={`flex h-8 min-w-0 flex-1 items-center gap-2 rounded-control px-2 text-left transition-[background-color,color] duration-fast hover:bg-hover active:bg-hover-2 ${
          active ? "bg-hover-2 text-ink" : "text-ink-2"
        }`}
      >
        <span className="min-w-0 flex-1 truncate text-13 font-medium">{label}</span>
        <span className={`text-12 text-ink-3 tabular-nums ${menu ? "group-focus-within/row:opacity-0 group-hover/row:opacity-0" : ""}`}>{count}</span>
      </button>
      {menu && (
        <span className="absolute right-0.5 flex opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-[[aria-expanded=true]]:opacity-100">
          {menu}
        </span>
      )}
    </div>
  );
}

function RecentEdits({ library, now, onOpen }: { library: ReturnType<typeof useDesignLibrary>; now: number; onOpen: (design: DesignLibraryEntry) => void }) {
  const recent = libraryRecent(library, RECENT);
  if (!recent.length) return null;
  return (
    <section aria-label="Recent edits" data-slot="library-recent" className="mt-3">
      <RailHeading>Recent edits</RailHeading>
      <ul className="mx-2 flex flex-col">
        {recent.map(({ design, page }) => {
          const line = [page.name, libraryCardLine(design, now)].join(" · ");
          return (
            <li key={design.id}>
              <button
                type="button"
                data-slot="library-recent-edit"
                data-design={design.id}
                title={`${design.title} · ${line}`}
                aria-label={`Show ${design.title}. ${line}`}
                onClick={() => onOpen(design)}
                className="flex w-full flex-col gap-0.5 rounded-control px-2 py-1.5 text-left transition-colors duration-fast hover:bg-hover active:bg-hover-2"
              >
                <span className="truncate text-13 text-ink">{design.title}</span>
                <span className="truncate text-12 text-ink-3">{libraryRecentLine(design, now)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PageMenu({ page, onRename }: { page: LibraryPage; onRename: () => void }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <span ref={anchor} className="flex">
      <IconButton
        data-slot="library-page-more"
        label={`More actions for ${page.name}`}
        icon={MoreHorizontalIcon}
        size={28}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      />
      {open && (
        <Popover anchor={anchor} label={`${page.name} actions`} onClose={() => setOpen(false)}>
          <MenuRow
            data-slot="library-rename-page"
            icon={PencilEdit02Icon}
            title="Rename page…"
            onClick={() => {
              setOpen(false);
              onRename();
            }}
          />
        </Popover>
      )}
    </span>
  );
}
