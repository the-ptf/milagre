import { useEffect, useRef, useState } from "react";
import { ArrowLeft01Icon, LibraryIcon, MoreHorizontalIcon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import type { DesignLibraryPage as LibraryPage } from "@milagre/shared/artifact";
import type { DesignLibraryTarget } from "../../lib/design-library-page";
import { IconButton } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { MenuRow, Popover } from "../primitives/Popover";
import { ScrollArea } from "../primitives/ScrollArea";
import { Tabs } from "../primitives/Tabs";
import { SettingsModal } from "../settings/SettingsModal";
import { useDesignLibrary } from "../agents/design-library";
import { DESIGN_DELETED, type DesignDeleted } from "../agents/design-events";
import { LibraryCard } from "./LibraryCard";
import { LibraryActionDialog, type LibraryAction } from "./LibraryDialogs";
import { LibraryDesignView } from "./LibraryDesignView";

const ALL = "all";

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * A Project's Design library: its library pages as tabs after All, a card per design, and one design open large on
 * the canvas. Reads the library by the Project, so it opens without a Chat and follows every change from any Chat.
 */
export function DesignLibraryPage({ target, onClose }: { target: DesignLibraryTarget; onClose: () => void }) {
  const { projectKey } = target;
  const library = useDesignLibrary(projectKey);
  const pages = library?.pages ?? [];
  const [tab, setTab] = useState(ALL);
  const [openId, setOpenId] = useState<string | null>(null);
  const [action, setAction] = useState<LibraryAction | null>(null);
  const now = useNow();
  const page = pages.find((item) => item.id === tab);
  const shownTab = page ? tab : ALL;
  const all = pages.flatMap((item) => item.designs.map((design) => ({ design, pageName: item.name })));
  const cards = page ? page.designs.map((design) => ({ design, pageName: undefined })) : all;
  const opened = all.find((item) => item.design.id === openId)?.design;
  useEffect(() => {
    const deleted = (event: Event) => {
      const detail = (event as CustomEvent<DesignDeleted>).detail;
      if (detail.chatId === projectKey) setOpenId((current) => (current === detail.id ? null : current));
    };
    window.addEventListener(DESIGN_DELETED, deleted);
    return () => window.removeEventListener(DESIGN_DELETED, deleted);
  }, [projectKey]);
  return (
    <SettingsModal label="Design library" onClose={onClose}>
      <div className="flex h-full min-h-0 flex-col" data-slot="design-library-page">
        <header className="flex shrink-0 items-center gap-2 border-b border-line py-3 pr-14 pl-5">
          {opened && <IconButton data-slot="library-back" label="All designs" icon={ArrowLeft01Icon} size={28} onClick={() => setOpenId(null)} />}
          <div className="min-w-0 flex-1">
            <div className="truncate text-12 text-ink-3">{opened ? `${target.name} · Design library` : target.name}</div>
            <h1 className="truncate text-17 font-semibold" data-slot="library-heading">
              {opened ? opened.title : "Design library"}
            </h1>
          </div>
        </header>
        {opened ? (
          <LibraryDesignView key={opened.id} projectKey={projectKey} design={opened} />
        ) : (
          <>
            {pages.length > 0 && (
              <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
                <Tabs
                  label="Library pages"
                  dataKey="library-page"
                  value={shownTab}
                  className="min-w-0 flex-1 overflow-x-auto"
                  options={[
                    { value: ALL, label: "All", count: all.length },
                    ...pages.map((item) => ({ value: item.id, label: item.name, count: item.designs.length })),
                  ]}
                  onChange={setTab}
                />
                {page && <PageMenu page={page} onRename={() => setAction({ kind: "rename-page", page })} />}
              </div>
            )}
            {library && !pages.length ? (
              <EmptyState icon={LibraryIcon} title="No designs in this Project's library yet" size="page" data-slot="library-empty">
                Add one from a design's ⋯ menu in a Chat's Artifact panel, choosing Add to Project library, or ask an agent to add it. Every Chat in this
                Project can then open it.
              </EmptyState>
            ) : (
              <ScrollArea as="ul" className="grid flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 p-5">
                {cards.map(({ design, pageName }) => (
                  <LibraryCard
                    key={design.id}
                    projectKey={projectKey}
                    design={design}
                    pageName={pageName}
                    now={now}
                    onOpen={() => setOpenId(design.id)}
                    onAction={setAction}
                  />
                ))}
              </ScrollArea>
            )}
          </>
        )}
      </div>
      {action && <LibraryActionDialog projectKey={projectKey} pages={pages} action={action} onClose={() => setAction(null)} />}
    </SettingsModal>
  );
}

function PageMenu({ page, onRename }: { page: LibraryPage; onRename: () => void }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <span ref={anchor} className="flex shrink-0">
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
