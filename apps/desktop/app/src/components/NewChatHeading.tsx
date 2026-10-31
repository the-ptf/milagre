import { Fragment, useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, BubbleChatIcon } from "@hugeicons/core-free-icons";
import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import { CHATS_GROUP_KEY, NO_PROJECT_LABEL, type ChatsHome, type ProjectKind } from "@milagre/shared/chats-home";
import { PickerPanel, PickerRow } from "./primitives/Picker";
import { WorkspaceIcon } from "./WorkspaceIcon";
import { useDismiss } from "../lib/use-dismiss";
import { useComputers } from "../lib/computers";
import { pickedProjectKey, projectPickerRows, type ProjectGroup } from "../lib/project-copies";
import { newChatLook } from "../lib/new-chat-look";
import { useProjectImages } from "../lib/project-images";
import { projectInitial } from "../lib/project-list";

/**
 * "Start building in [Computer / Project ▾]" over a new Chat. The Project is a dropdown listing every Project this window
 * can start a Chat in, the sidebar's other computers included, one row per repository; picking one moves the new Chat
 * there. The composer's computer chip names the computer, so the heading drops it; only a Project not yet found in the
 * lists (no chip yet) keeps "Computer /" here.
 * No project, first in the list, moves it to a Chats home: "Just chat [No project ▾]", the computer left to the chip too.
 */
export function NewChatHeading({
  projectKey,
  projectName,
  projectKind,
  groups,
  noProject,
  onProjectChange,
  onOpenChange,
}: {
  projectKey: string;
  projectName: string;
  projectKind?: ProjectKind;
  groups: ProjectGroup[];
  /** The No project row: each computer's Chats home. */
  noProject?: ProjectGroup;
  /** `home`: the key is a Chats home, and whether that computer has made it yet. */
  onProjectChange?: (key: string, home?: Pick<ChatsHome, "exists">) => void;
  /** The picker opened or closed, so the caller can raise the heading above the composer only while it is open. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    onOpenChange?.(open);
    // Unmounting with the picker open must not leave the caller believing it still is.
    return () => onOpenChange?.(false);
  }, [open, onOpenChange]);
  const { thisMac, computers } = useComputers();
  const chats = projectKind === "chats";
  const computerId = computerOfKey(projectKey);
  const chipped = groups.some((group) => group.copies.some((copy) => copy.key === projectKey));
  const computer = chats || chipped ? "" : computerId === LOCAL_COMPUTER ? thisMac : (computers.find((item) => item.id === computerId)?.name ?? "Computer");
  const name = chats ? NO_PROJECT_LABEL : projectName;
  const place = (
    <>
      {computer && <span className="min-w-0 shrink truncate text-ink-3">{computer} /</span>}
      <span className="max-w-[300px] shrink-0 truncate">{name}</span>
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
      <h1 className="font-medium">{newChatLook(projectKind).heading}</h1>
      {onProjectChange ? (
        <span className="relative">
          <button
            ref={trigger}
            type="button"
            data-new-chat-project
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={`Project: ${computer ? `${computer} / ` : ""}${name}`}
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
              noProject={noProject}
              currentKey={projectKey}
              onPick={(key, home) => {
                close();
                if (key !== projectKey) onProjectChange(key, home);
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
  noProject,
  currentKey,
  onPick,
  onClose,
}: {
  groups: ProjectGroup[];
  noProject?: ProjectGroup;
  currentKey: string;
  onPick: (key: string, home?: Pick<ChatsHome, "exists">) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const image = useProjectImages(groups.map((group) => group.key));
  const rows = projectPickerRows({ groups, noProject, query });
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
      {rows.map((group, index) => {
        const current = group.copies.some((copy) => copy.key === currentKey);
        if (group.key === CHATS_GROUP_KEY)
          return (
            <Fragment key={group.key}>
              <PickerRow
                icon={
                  <span className="flex size-4 items-center justify-center rounded-[5px] bg-ink text-surface">
                    <HugeiconsIcon icon={BubbleChatIcon} size={11} strokeWidth={2} color="currentColor" />
                  </span>
                }
                label={group.name}
                selected={current}
                // The Chats home of the computer the chip shows: This Mac's unless the draft is already on another's.
                onClick={() => {
                  const key = pickedProjectKey(group, currentKey);
                  onPick(key, { exists: group.copies.find((copy) => copy.key === key)?.exists ?? false });
                }}
              />
              {index < rows.length - 1 && <div className="mx-1.5 my-1 h-px bg-line" />}
            </Fragment>
          );
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
            onClick={() => onPick(pickedProjectKey(group, currentKey))}
          />
        );
      })}
    </PickerPanel>
  );
}
