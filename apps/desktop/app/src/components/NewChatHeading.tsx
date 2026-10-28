import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { LOCAL_COMPUTER, computerOfKey } from "@milagre/shared/chat-scopes";
import { PickerPanel, PickerRow } from "./primitives/Picker";
import { WorkspaceIcon } from "./WorkspaceIcon";
import { useDismiss } from "../lib/use-dismiss";
import { useComputers, useHiddenComputers } from "../lib/computers";
import { useComputerScopes } from "../lib/computer-scopes";
import { useProjectImages } from "../lib/project-images";
import { projectInitial, RECENT_PROJECTS_CHANGED, type RecentProject } from "../lib/project-list";

/** A Project a new Chat can start in: this Mac's, or another computer's (`computer` names it). */
type ProjectChoice = { key: string; name: string; computer?: string };

/**
 * "Start building in [Computer / Project ▾]" over a new Chat. The Project is a dropdown listing every Project this window
 * can start a Chat in, the sidebar's other computers included; picking one moves the new Chat there.
 */
export function NewChatHeading({
  projectKey,
  projectName,
  onProjectChange,
}: {
  projectKey: string;
  projectName: string;
  onProjectChange?: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { thisMac, computers } = useComputers();
  const computerId = computerOfKey(projectKey);
  const computer = computerId === LOCAL_COMPUTER ? thisMac : (computers.find((item) => item.id === computerId)?.name ?? "Computer");
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
              currentKey={projectKey}
              currentName={projectName}
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

/** Mounted only while open, so other computers are asked for their Projects only when the list is wanted. */
function ProjectPicker({
  currentKey,
  currentName,
  onPick,
  onClose,
}: {
  currentKey: string;
  currentName: string;
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const choices = useProjectChoices(currentKey, currentName);
  const image = useProjectImages(choices.map((choice) => choice.key));
  const search = query.trim().toLowerCase();
  const rows = choices.filter((choice) => choice.name.toLowerCase().includes(search) || choice.computer?.toLowerCase().includes(search));
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
      {rows.map((choice) => (
        <PickerRow
          key={choice.key}
          icon={
            <span className="flex size-4 items-center justify-center overflow-hidden rounded-[4px] bg-ink text-[9px] font-semibold text-surface">
              <WorkspaceIcon src={image(choice.key)} fallback={projectInitial(choice.name)} />
            </span>
          }
          label={choice.name}
          trailing={choice.computer}
          selected={choice.key === currentKey}
          onClick={() => onPick(choice.key)}
        />
      ))}
    </PickerPanel>
  );
}

/** The open Project first, then all this Mac's recent Projects, then other computers' by name. Sidebar visibility does not limit where a Chat can start. */
function useProjectChoices(currentKey: string, currentName: string): ProjectChoice[] {
  const [recent, setRecent] = useState<RecentProject[]>([]);
  useEffect(() => {
    let live = true;
    const read = () =>
      window.milagre?.listRecentProjects?.().then(
        (list) => live && setRecent(Array.isArray(list) ? list : []),
        () => {},
      );
    void read();
    window.addEventListener(RECENT_PROJECTS_CHANGED, read);
    return () => {
      live = false;
      window.removeEventListener(RECENT_PROJECTS_CHANGED, read);
    };
  }, []);
  const { computers } = useComputers();
  const hiddenComputers = useHiddenComputers();
  const remote = useComputerScopes(computers);
  const computerName = (key: string) => {
    if (computers.length === 0) return undefined;
    const id = computerOfKey(key);
    if (id === LOCAL_COMPUTER) return undefined;
    return computers.find((computer) => computer.id === id)?.name ?? "Computer";
  };
  const seen = new Set<string>([currentKey]);
  const choices: ProjectChoice[] = [{ key: currentKey, name: currentName, computer: computerName(currentKey) }];
  for (const project of recent) {
    if (seen.has(project.path) || hiddenComputers.has(computerOfKey(project.path))) continue;
    seen.add(project.path);
    choices.push({ key: project.path, name: project.name, computer: computerName(project.path) });
  }
  const others = remote.projects
    .filter((scope) => !scope.path.startsWith("milagre-link:") && !seen.has(scope.path) && !hiddenComputers.has(scope.computerId))
    .toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  for (const scope of others) {
    seen.add(scope.path);
    choices.push({ key: scope.path, name: scope.name, computer: computerName(scope.path) });
  }
  return choices;
}
