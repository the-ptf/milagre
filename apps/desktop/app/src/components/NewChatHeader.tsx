import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { GithubIssue } from "@milagre/shared/github-issue";
import type { IconSvgElement } from "@hugeicons/react";
import { BubbleChatIcon, Folder01Icon, GitBranchIcon, GitForkIcon, ComputerIcon } from "@hugeicons/core-free-icons";
import { GithubLogo, LinearLogo } from "./ProviderLogo";
import type { Isolation } from "../model";
import { Icon } from "./primitives/Icon";
import { Chip } from "./primitives/Chip";
import { UI_COPY } from "@milagre/shared/model-copy";
import { PickerPanel, PickerRow } from "./primitives/Picker";
import { LinearIssuePicker } from "./LinearIssuePicker";
import { GithubIssuePicker } from "./GithubIssuePicker";
import { useGithubIssueProject } from "./useGithubIssues";
import { onGithubIssuePickerRequest } from "../lib/issue-picker-request";
import Tooltip from "./primitives/Tooltip";
import { LOCAL_COMPUTER } from "@milagre/shared/chat-scopes";
import { rememberProjectComputer, shortPath, type ProjectCopy } from "../lib/project-copies";
import { newChatLook } from "../lib/new-chat-look";
import { useDismiss } from "../lib/use-dismiss";
import { ThisComputer } from "../lib/shortcut-hints";
import type { ChatComposerProps } from "./composer/chat-composer-props";

type IconData = IconSvgElement;

type IsolationOption = { id: Isolation; name: string; description: string; icon: IconData };

const ISOLATIONS: [IsolationOption, ...IsolationOption[]] = [
  { id: "local", name: "This checkout", description: "Work in the selected checkout", icon: Folder01Icon },
  { id: "worktree", name: UI_COPY.newWorktree, description: "Start a new branch in its own Worktree", icon: GitForkIcon },
];

function ChipButton({
  icon,
  leading,
  label,
  open,
  chip,
  iconOnly = false,
  onClick,
}: {
  icon?: IconData;
  leading?: ReactNode;
  label: string;
  open: boolean;
  chip?: string;
  iconOnly?: boolean;
  onClick: (trigger: HTMLElement) => void;
}) {
  if (iconOnly)
    return (
      <Tooltip label={label} asChild>
        <Chip icon={leading ?? icon} chevron aria-label={label} aria-expanded={open} data-chip={chip} onClick={(event) => onClick(event.currentTarget)} />
      </Tooltip>
    );
  return (
    <Chip icon={leading ?? icon} chevron aria-expanded={open} data-chip={chip} className="max-w-full" onClick={(event) => onClick(event.currentTarget)}>
      <span className="min-w-0 truncate">{label}</span>
    </Chip>
  );
}

function GithubIssueMenu({
  projectKey,
  iconOnly,
  open,
  onToggle,
  onPick,
  onClose,
  className,
  style,
}: {
  projectKey: string;
  iconOnly: boolean;
  open: boolean;
  onToggle: (trigger: HTMLElement) => void;
  onPick: (issue: GithubIssue) => void;
  onClose: () => void;
  className: string;
  style: CSSProperties;
}) {
  return (
    <>
      <ChipButton leading={<GithubLogo size={14} />} label="GitHub issue" chip="github-issue" iconOnly={iconOnly} open={open} onClick={onToggle} />
      {open && <GithubIssuePicker projectKey={projectKey} className={className} style={style} onPick={onPick} onClose={onClose} />}
    </>
  );
}

type NewChatHeaderProps = Pick<
  ChatComposerProps,
  | "worktrees"
  | "selectedWorktreeId"
  | "onWorktreeChange"
  | "isolation"
  | "onIsolationChange"
  | "branches"
  | "baseBranch"
  | "onBaseBranchChange"
  | "linearActive"
  | "onStartFromIssue"
  | "noGit"
> & {
  chats?: boolean;
  link?: boolean;
  copies?: ProjectCopy[];
  currentKey?: string;
  onComputerChange?: (key: string) => void;
};

const NO_COPIES: ProjectCopy[] = [];

const WIDEST_PICKER = 420;

const offersGithubIssue = (props: { chats: boolean; link: boolean; noGit: boolean; selected: unknown; onStartFromIssue: unknown }) =>
  !props.chats && !props.link && !props.noGit && !!props.selected && !!props.onStartFromIssue;

export const NO_WORKTREES: ChatComposerProps["worktrees"] = [];

export const NO_BRANCHES: string[] = [];

export function NewChatHeader({
  worktrees,
  selectedWorktreeId,
  onWorktreeChange,
  isolation,
  onIsolationChange,
  branches,
  baseBranch,
  onBaseBranchChange,
  linearActive = false,
  onStartFromIssue,
  noGit = false,
  chats = false,
  link = false,
  copies = NO_COPIES,
  currentKey,
  onComputerChange,
}: NewChatHeaderProps) {
  type Menu = "computer" | "isolation" | "branch" | "issue" | "github";
  const [menu, setMenu] = useState<Menu | null>(null);
  const pickersRef = useRef<HTMLDivElement>(null);
  const copy = copies.find((item) => item.key === currentKey);
  const chooseComputer = copy && onComputerChange;
  const [query, setQuery] = useState("");
  const [popover, setPopover] = useState({ left: 0, maxHeight: 480, up: true });
  const selected = worktrees.find((worktree) => worktree.id === selectedWorktreeId) ?? worktrees[0];
  const linearChip = !chats && linearActive && !!onStartFromIssue;
  const githubProject = useGithubIssueProject(currentKey, offersGithubIssue({ chats, link, noGit, selected, onStartFromIssue }));
  const isolationOption = ISOLATIONS.find((option) => option.id === isolation) ?? ISOLATIONS[0];
  const search = query.trim().toLowerCase();
  const branchRows =
    isolation === "local"
      ? worktrees
          .filter((worktree) => worktree.name.toLowerCase().includes(search))
          .map((worktree) => ({
            key: String(worktree.id),
            name: worktree.name,
            description: worktree.path.split("/").findLast(Boolean),
            selected: worktree.id === selected?.id,
            choose: () => onWorktreeChange(worktree.id),
          }))
      : branches
          .filter((branch) => branch.toLowerCase().includes(search))
          .map((branch) => ({ key: branch, name: branch, description: undefined, selected: branch === baseBranch, choose: () => onBaseBranchChange(branch) }));

  const lastTrigger = useRef<HTMLElement | null>(null);
  function place(trigger: HTMLElement) {
    lastTrigger.current = trigger;
    const row = trigger.parentElement?.getBoundingClientRect();
    const button = trigger.getBoundingClientRect();
    const above = button.top - 24;
    const below = window.innerHeight - button.bottom - 24;
    const left = Math.max(row?.left ?? button.left, Math.min(button.left, window.innerWidth - WIDEST_PICKER - 16));
    setPopover({ left: left - (row?.left ?? button.left), maxHeight: Math.max(above, below), up: above >= below });
  }

  useDismiss(
    menu !== null,
    () => setMenu(null),
    (target) => !!target.closest("[data-picker-panel], [data-new-chat-pickers] button[aria-expanded]"),
    () => {
      if (lastTrigger.current) place(lastTrigger.current);
    },
  );

  useEffect(
    () =>
      onGithubIssuePickerRequest(() => {
        const chip = githubProject ? pickersRef.current?.querySelector<HTMLElement>("[data-chip=github-issue]") : null;
        if (!chip) return false;
        place(chip);
        setQuery("");
        setMenu("github");
        return true;
      }),
    [githubProject],
  );

  function toggle(next: Menu, trigger: HTMLElement) {
    place(trigger);
    setQuery("");
    setMenu((current) => (current === next ? null : next));
  }

  function close() {
    setMenu(null);
    setQuery("");
  }

  const popoverStyle = { left: popover.left, maxHeight: popover.maxHeight, transformOrigin: popover.up ? "bottom left" : "top left" };
  const popoverEdge = popover.up ? "bottom-[calc(100%+0.375rem)]" : "top-[calc(100%+0.375rem)]";

  return (
    <div className={`px-2.5 ${menu ? "relative z-30" : ""}`} style={{ animation: "fade-up var(--duration-slow) var(--ease-enter) backwards" }}>
      {!chats && !link && noGit && selected && (
        <p data-no-git-note className="mt-1 mb-2 flex items-center gap-1.5 text-13 text-ink-2">
          <Icon icon={Folder01Icon} size={14} />
          {selected.name} has no Git, so this Chat works in the folder itself.
        </p>
      )}
      {(chats || (link ? linearActive && onStartFromIssue : !noGit && selected)) && (
        <div ref={pickersRef} data-new-chat-pickers className="relative mb-1 flex min-w-0 items-center gap-1">
          {chooseComputer && (
            <Tooltip label="Choose the computer" className="min-w-0">
              <ChipButton
                icon={ComputerIcon}
                label={copy.computer}
                open={menu === "computer"}
                onClick={(trigger) => toggle("computer", trigger.parentElement ?? trigger)}
              />
            </Tooltip>
          )}
          {link ? null : chats ? (
            <span data-new-chat-label className="flex h-7 items-center gap-1.5 px-2.5 text-12 font-medium text-ink-2">
              <Icon icon={BubbleChatIcon} size={14} />
              {newChatLook("chats").trayLabel}
            </span>
          ) : (
            selected && (
              <>
                <Tooltip label="Choose the isolation level" className="min-w-0">
                  <ChipButton
                    icon={isolationOption.icon}
                    label={isolationOption.name}
                    open={menu === "isolation"}
                    onClick={(trigger) => toggle("isolation", trigger.parentElement ?? trigger)}
                  />
                </Tooltip>
                <ChipButton
                  icon={GitBranchIcon}
                  label={isolation === "local" ? selected.name : baseBranch}
                  open={menu === "branch"}
                  onClick={(trigger) => toggle("branch", trigger)}
                />
              </>
            )
          )}
          {linearChip && (
            <ChipButton
              leading={<LinearLogo size={14} />}
              label="Linear issue"
              iconOnly={!!githubProject}
              open={menu === "issue"}
              onClick={(trigger) => toggle("issue", trigger)}
            />
          )}
          {githubProject && (
            <GithubIssueMenu
              projectKey={githubProject}
              iconOnly={linearChip}
              open={menu === "github"}
              onToggle={(trigger) => toggle("github", trigger)}
              onPick={(issue) => {
                onStartFromIssue?.(issue);
                close();
              }}
              onClose={close}
              className={`absolute ${popoverEdge} w-[420px] max-w-[calc(100vw-2rem)]`}
              style={popoverStyle}
            />
          )}
          {menu === "computer" && chooseComputer && (
            <PickerPanel title="Run on" className={`absolute ${popoverEdge} w-[320px]`} style={popoverStyle}>
              {copies.map((item) => (
                <PickerRow
                  key={item.key}
                  icon={<Icon icon={ComputerIcon} size={14} />}
                  label={item.computerId === LOCAL_COMPUTER ? `${item.computer} · ${ThisComputer}` : item.computer}
                  description={chats ? undefined : shortPath(item.key)}
                  trailing={item.online ? undefined : "Offline"}
                  selected={item.key === currentKey}
                  disabled={!item.online}
                  wrapLabel
                  onClick={() => {
                    close();
                    if (item.key === currentKey) return;
                    rememberProjectComputer(item);
                    onComputerChange(item.key);
                  }}
                />
              ))}
            </PickerPanel>
          )}
          {menu === "isolation" && (
            <PickerPanel title="Isolation" className={`absolute ${popoverEdge} w-[320px]`} style={popoverStyle}>
              {ISOLATIONS.map((option) => (
                <PickerRow
                  key={option.id}
                  icon={<Icon icon={option.icon} size={14} />}
                  label={option.name}
                  description={option.description}
                  selected={option.id === isolation}
                  onClick={() => {
                    onIsolationChange(option.id);
                    close();
                  }}
                />
              ))}
            </PickerPanel>
          )}
          {menu === "issue" && (
            <LinearIssuePicker
              className={`absolute ${popoverEdge} w-[420px] max-w-[calc(100vw-2rem)]`}
              style={popoverStyle}
              onPick={(issue) => {
                onStartFromIssue?.(issue);
                close();
              }}
              onClose={close}
            />
          )}
          {menu === "branch" && (
            <PickerPanel
              title={isolation === "local" ? "Choose a Worktree" : "Branch from"}
              query={query}
              onQueryChange={setQuery}
              placeholder={isolation === "local" ? "Search Worktrees" : "Search branches"}
              searchPlacement="bottom"
              emptyLabel={isolation === "local" ? "No Worktrees found" : "No branches found"}
              isEmpty={branchRows.length === 0}
              className={`absolute ${popoverEdge} w-[420px] max-w-[calc(100vw-2rem)]`}
              style={popoverStyle}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  close();
                }
              }}
            >
              {branchRows.map((row) => (
                <PickerRow
                  key={row.key}
                  icon={<Icon icon={GitBranchIcon} size={14} />}
                  label={row.name}
                  description={row.description}
                  selected={row.selected}
                  wrapLabel
                  onClick={() => {
                    row.choose();
                    close();
                  }}
                />
              ))}
            </PickerPanel>
          )}
        </div>
      )}
    </div>
  );
}
