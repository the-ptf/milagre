import { useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import { PickerPanel, PickerRow } from "./primitives/Picker";
import { WorkspaceIcon } from "./WorkspaceIcon";
import { useDismiss } from "../lib/use-dismiss";
import { useComputers } from "../lib/computers";
import { preferredCopy, rememberProjectComputer, type ProjectGroup } from "../lib/project-copies";
import { useProjectImages } from "../lib/project-images";
import { projectInitial } from "../lib/project-list";

/**
 * "Start building in [Computer / Project ▾]" over a new Chat. The Project is a dropdown listing every Project this window
 * can start a Chat in, the sidebar's other computers included, one row per repository; picking one moves the new Chat
 * there. A Project on several computers leaves the computer to the composer's computer chip, so the heading drops it.
 */
export function NewChatHeading({
  projectKey,
  projectName,
  groups,
  onProjectChange,
}: {
  projectKey: string;
  projectName: string;
  groups: ProjectGroup[];
  onProjectChange?: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { thisMac, computers } = useComputers();
  const computerId = computerOfKey(projectKey);
  const onSeveral = (groups.find((group) => group.copies.some((copy) => copy.key === projectKey))?.copies.length ?? 0) > 1;
  const computer = onSeveral ? "" : computerId === LOCAL_COMPUTER ? thisMac : (computers.find((item) => item.id === computerId)?.name ?? "Computer");
  const place = (
    <>
      {computer && <span className="min-w-0 shrink truncate text-ink-3">{computer} /</span>}
      <span className="max-w-[300px] shrink-0 truncate">{projectName}</span>
    </>
  );
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(
    open,
    () => setOpen(false),
    (target) => !!target.closest("[data-new-chat-heading]"),
  );
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div data-new-chat-heading className="relative flex flex-wrap items-center justify-center gap-1.5 text-[17px] font-medium text-ink">
      <h1 className="font-medium">Start building in</h1>
      {onProjectChange ? (
        <span className="relative">
          <button
            ref={trigger}
            type="button"
            data-new-chat-project
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={`Project: ${computer ? `${computer} / ` : ""}${projectName}`}
            onClick={() => setOpen((current) => !current)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && !open) {
                event.preventDefault();
                setOpen(true);
              }
            }}
            className={`flex h-8 max-w-[480px] items-center gap-1 rounded-[8px] px-2 transition-colors hover:bg-hover ${open ? "bg-hover" : "bg-field"}`}
          >
            {place}
            <span className="shrink-0 text-ink-3">
              <HugeiconsIcon icon={ArrowDown01Icon} size={14} strokeWidth={1.8} color="currentColor" />
            </span>
          </button>
          {open && (
            <ProjectPicker
              groups={groups}
              currentKey={projectKey}
              onPick={(key) => {
                close();
                if (key !== projectKey) onProjectChange(key);
              }}
              onClose={close}
            />
          )}
        </span>
      ) : (
        <span className="flex h-8 max-w-[480px] items-center gap-1 rounded-[8px] bg-field px-2">{place}</span>
      )}
    </div>
  );
}

function ProjectPicker({
  groups,
  currentKey,
  onPick,
  onClose,
}: {
  groups: ProjectGroup[];
  currentKey: string;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const image = useProjectImages(groups.map((group) => group.key));
  const search = query.trim().toLowerCase();
  const rows = groups.filter((group) => group.name.toLowerCase().includes(search) || group.copies.some((copy) => copy.computer.toLowerCase().includes(search)));
  return (
    <PickerPanel
      query={query}
      onQueryChange={setQuery}
      placeholder="Search projects"
      emptyLabel="No projects found."
      isEmpty={rows.length === 0}
      className="absolute top-[calc(100%+0.375rem)] left-0 z-30 w-[300px] max-w-[calc(100vw-2rem)] text-left"
      style={{ transformOrigin: "top left" }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {rows.map((group) => {
        const current = group.copies.some((copy) => copy.key === currentKey);
        return (
          <PickerRow
            key={group.key}
            icon={
              <span className="flex size-4 items-center justify-center overflow-hidden rounded-[4px] bg-ink text-[9px] font-semibold text-surface">
                <WorkspaceIcon src={image(group.key)} fallback={projectInitial(group.name)} />
              </span>
            }
            label={group.name}
            trailing={group.copies.length > 1 ? `${group.copies.length} computers` : group.computerId === LOCAL_COMPUTER ? undefined : group.computer}
            selected={current}
            onClick={() => {
              if (current) return onPick(currentKey);
              const copy = preferredCopy(group.origin, [group, ...group.copies]);
              rememberProjectComputer(copy);
              onPick(copy.key);
            }}
          />
        );
      })}
    </PickerPanel>
  );
}
