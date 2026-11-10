import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Add01Icon,
  BubbleChatIcon,
  Bug01Icon,
  BubbleChatSearchIcon,
  ChartColumnIcon,
  CodeIcon,
  ComputerTerminal01Icon,
  Copy01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  Link04Icon,
  PencilEdit02Icon,
  Refresh01Icon,
  TimeScheduleIcon,
  FlowConnectionIcon,
  Search01Icon,
  Settings01Icon,
  HardDriveIcon,
} from "@hugeicons/core-free-icons";
import { filterCommands, type Command } from "../lib/commands";
import { recentCommandIds, recentCommands, rememberCommand, rememberedId } from "../lib/recent-commands";
import { useShortcutHints } from "../lib/shortcut-hints";
import { shortcutCommand, useShortcutLabel } from "../lib/keybindings";
import type { KeybindingCommandId } from "@milagre/shared/keybindings";
import { ScrollArea } from "./primitives/ScrollArea";
import { ShortcutKeys } from "./primitives/ShortcutKeys";
import { Icon } from "./primitives/Icon";
import { EmptyState } from "./primitives/EmptyState";
import { MenuLabel } from "./primitives/Popover";
import { DURATION, EASE_OUT } from "../lib/ease";

/** `--duration-fast` and `--ease-enter` from styles.css, for the Web Animations API. */
const DURATION_FAST = DURATION.fast * 1000;
const EASE_ENTER = `cubic-bezier(${EASE_OUT.join(", ")})`;

const icons = {
  add: Add01Icon,
  chat: BubbleChatIcon,
  folder: FolderOpenIcon,
  settings: Settings01Icon,
  git: GitBranchIcon,
  editor: CodeIcon,
  copy: Copy01Icon,
  unread: BubbleChatIcon,
  search: Search01Icon,
  message: BubbleChatSearchIcon,
  reload: Refresh01Icon,
  routines: TimeScheduleIcon,
  canvas: FlowConnectionIcon,
  usage: ChartColumnIcon,
  newChat: PencilEdit02Icon,
  triage: Bug01Icon,
  storage: HardDriveIcon,
  terminal: ComputerTerminal01Icon,
  link: Link04Icon,
  pullRequest: GitPullRequestIcon,
  folderAdd: FolderAddIcon,
};

/** A row's shortcut, right-aligned in 11 ink-3: always shown as plain keys, keycaps while ⌘ is held. */
function CommandKeys({ command, hints }: { command: KeybindingCommandId; hints: boolean }) {
  const label = useShortcutLabel(command);
  if (!label) return null;
  return hints ? <ShortcutKeys shortcut={label} /> : <ShortcutKeys shortcut={label} plain className="min-w-12 justify-end text-ink-3" />;
}

function Label({ command }: { command: Command }) {
  if (!command.highlight) return command.label;
  const [start, end] = command.highlight;
  return (
    <>
      {command.label.slice(0, start)}
      <mark className="bg-transparent font-semibold text-ink">{command.label.slice(start, end)}</mark>
      {command.label.slice(end)}
    </>
  );
}

/**
 * `searchMessages` runs only when no command, chat or project matches, so a chat's own words are the fallback.
 * `searchMessagesAsync` does the same through the host, for a window that holds no messages.
 * When nothing matches at all, `onStartChat` offers one row that starts a new Chat with the search as its draft.
 */
export function CommandPalette({
  commands,
  searchMessages,
  searchMessagesAsync,
  onStartChat,
  onClose,
  onError,
}: {
  commands: Command[];
  searchMessages?: (query: string) => Command[];
  searchMessagesAsync?: (query: string) => Promise<Command[]>;
  onStartChat?: (query: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const showHints = useShortcutHints();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const executing = useRef(false);
  const animation = useRef<Animation | null>(null);
  const listId = useId();
  // Read once per opening, so a command run from this palette doesn't reshuffle the list under the pointer.
  const [recentIds] = useState(recentCommandIds);
  const typed = query.trim().length > 0;
  const matches = typed ? filterCommands(commands, query) : [...recentCommands(commands, recentIds), ...filterCommands(commands, query)];
  // Settings rows found by their words don't stand in for a Chat's: messages are still searched beside them.
  const commandMatches = matches.filter((command) => !command.searchOnly);
  const [found, setFound] = useState<{ query: string; commands: Command[] }>({ query: "", commands: [] });
  const searchHost = !commandMatches.length && !searchMessages && searchMessagesAsync && query.trim().length >= 2;
  useEffect(() => {
    if (!searchHost) return;
    let cancelled = false;
    // A short pause while typing, so each keystroke doesn't ask the host.
    const timer = setTimeout(() => {
      searchMessagesAsync(query).then(
        (commands) => !cancelled && setFound({ query, commands }),
        () => !cancelled && setFound({ query, commands: [] }),
      );
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchHost, query, searchMessagesAsync]);
  const messages = commandMatches.length || !typed ? [] : searchMessages ? searchMessages(query) : searchHost && found.query === query ? found.commands : [];
  const searched = [...matches, ...messages];
  // The host is still looking: nothing is offered until it answers, so the new-chat row doesn't flash in and out.
  const searching = !commandMatches.length && !searchMessages && searchHost && found.query !== query;
  const results: Command[] =
    searched.length || searching || !onStartChat || !query.trim()
      ? searched
      : [
          {
            id: "start-chat-with-search",
            label: "Start a new Chat with your search",
            group: "New Chat",
            icon: "newChat",
            run: () => onStartChat(query.trim()),
          },
        ];
  const selected = results.find((command) => command.id === selectedId) ?? results[0];
  const selectedIndex = selected ? results.indexOf(selected) : -1;

  useLayoutEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.showModal();
    animation.current = element.animate(
      [
        { opacity: 0, transform: `translate(-50%, ${reduced ? 0 : 6}px)` },
        { opacity: 1, transform: "translate(-50%, 0px)" },
      ],
      { duration: reduced ? 60 : DURATION_FAST, easing: EASE_ENTER },
    );
    input.current?.focus();
    return () => {
      animation.current?.cancel();
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected?.id, query]);

  function close(command?: Command) {
    if (executing.current) return;
    executing.current = true;
    const element = dialog.current!;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Start at the current frame when Escape interrupts the entrance.
    const { opacity, transform } = getComputedStyle(element);
    animation.current?.cancel();
    element.dataset.closing = "true";
    animation.current = element.animate(
      [
        { opacity, transform },
        { opacity: 0, transform: `translate(-50%, ${reduced ? 0 : 6}px)` },
      ],
      { duration: reduced ? 60 : DURATION_FAST, easing: EASE_ENTER, fill: "forwards" },
    );
    void animation.current.finished.then(
      () => {
        onClose();
        if (command && command.id !== "start-chat-with-search" && commands.some((item) => item.id === rememberedId(command)))
          rememberCommand(rememberedId(command));
        // Let focus restore before the action opens a new surface.
        if (command)
          window.setTimeout(() => {
            Promise.resolve()
              .then(command.run)
              .catch((error: unknown) => onError(error instanceof Error ? error.message : "Couldn't run this command."));
          }, 0);
      },
      () => {
        /* Unmount cancelled the animation. */
      },
    );
  }

  return createPortal(
    <dialog
      ref={dialog}
      aria-label="Command palette"
      className="command-palette fixed m-0 flex max-h-[min(560px,80vh)] w-[min(640px,calc(100vw-32px))] flex-col overflow-hidden rounded-window bg-surface p-0 text-ink shadow-overlay no-drag"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (executing.current) {
          event.preventDefault();
          return;
        }
        if (event.nativeEvent.isComposing) return;
        // Consume Escape before the app's stop-agent shortcut sees it.
        const pressed = shortcutCommand(event);
        if (event.key === "Escape" || pressed === "commandPalette.toggle") {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (pressed) {
          const command = commands.find((item) => item.keybinding === pressed);
          if (command) {
            event.preventDefault();
            close(command);
          }
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const next = results[(selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length];
          if (next) setSelectedId(next.id);
        } else if (event.key === "Enter") {
          event.preventDefault();
          if (selected) close(selected);
        } else if (event.key === "Tab") {
          event.preventDefault();
          input.current?.focus();
        }
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
        <Icon icon={Search01Icon} size={18} className="shrink-0 text-ink-3" />
        <input
          ref={input}
          role="combobox"
          aria-label="Search commands, Chats, Projects and messages"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={selected ? `${listId}-${selectedIndex}` : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedId(null);
          }}
          placeholder="Search commands, Chats and Projects…"
          className="min-w-0 flex-1 bg-transparent text-15 text-ink outline-none placeholder:text-ink-3"
        />
        {showHints && <ShortcutKeys shortcut="esc" />}
      </div>
      {/* A 16px edge fade: the 28px default washed out the last whole row, which then read as disabled. */}
      <ScrollArea id={listId} role="listbox" aria-label="Commands" className="pt-1.5 pr-0 pb-2 pl-1.5 [--scroll-fade-size:16px]">
        {Array.from(new Set(results.map((command) => command.group))).map((group) => (
          <div key={group} role="group" aria-label={group} className="pb-1.5 last:pb-0">
            <div aria-hidden="true">
              {/* On the commands' icon line: their 16px glyphs sit centred in 20px slots. */}
              <MenuLabel className="pl-2.5">{group}</MenuLabel>
            </div>
            {results
              .filter((command) => command.group === group)
              .map((command) => (
                <div
                  key={command.id}
                  id={`${listId}-${results.indexOf(command)}`}
                  role="option"
                  aria-selected={command.id === selected?.id}
                  onPointerMove={() => setSelectedId(command.id)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => close(command)}
                  // MenuRow's metrics; the highlight follows the selection (pointer or arrows), so there's no separate hover.
                  className={`flex min-h-8 w-full cursor-default items-center gap-2 rounded-inline px-2 text-13 font-medium text-ink active:bg-hover-2 ${command.id === selected?.id ? "bg-hover-2" : ""} ${command.hint && command.id === selected?.id ? "py-1.5" : ""}`}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center text-ink-2">
                    <Icon icon={icons[command.icon]} size={16} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">
                      <Label command={command} />
                    </span>
                    {/* A row's hint reads under its label while the row is highlighted: the right column is for keys. */}
                    {command.hint && command.id === selected?.id && <span className="truncate text-12 font-normal text-ink-3">{command.hint}</span>}
                  </span>
                  {command.detail && <span className="max-w-[45%] truncate text-11 text-ink-3">{command.detail}</span>}
                  {command.keybinding && <CommandKeys command={command.keybinding} hints={showHints} />}
                </div>
              ))}
          </div>
        ))}
        {!results.length && !searching && <EmptyState size="compact" title={`No results for “${query}”`} />}
      </ScrollArea>
      <div className={`flex shrink-0 gap-4 border-t border-line px-4 py-2 text-11 text-ink-3 ${showHints ? "" : "invisible"}`}>
        <span className="inline-flex items-center gap-1.5">{showHints ? <ShortcutKeys shortcut="↑↓" plain /> : "↑ ↓"}Navigate</span>
        <span className="inline-flex items-center gap-1.5">{showHints ? <ShortcutKeys shortcut="↵" plain /> : "↵"}Run</span>
        <span className="ml-auto inline-flex items-center gap-1.5">{showHints ? <ShortcutKeys shortcut="esc" plain /> : "esc"}Close</span>
      </div>
    </dialog>,
    document.body,
  );
}
