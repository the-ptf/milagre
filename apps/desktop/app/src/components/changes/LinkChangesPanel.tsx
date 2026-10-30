import { useRef, useState, type ReactNode } from "react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  MoreVerticalIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  SourceCodeIcon,
  FolderOpenIcon,
} from "@hugeicons/core-free-icons";
import type { WorktreeBinding } from "@milagre/shared/model";
import { LINK_PENDING_WORKTREE_TEXT } from "@milagre/shared/worktree-link";
import type { DiffMode } from "../../electron";
import {
  ComparisonControls,
  CommitHistory,
  ChangesSections,
  ChangesTabs,
  Counts,
  changedFileCount,
  firstSection,
  type ChangesLists,
  type CommentCounts,
  type PrTab,
} from "./ChangesPanel";
import { useComparison } from "./useComparison";
import { useBridge } from "../../lib/computer-bridge";
import type { DiffList } from "./useDiffFiles";
import { ProjectAvatarStack } from "../ProjectAvatarStack";
import { ScrollArea } from "../primitives/ScrollArea";
import { Icon } from "../primitives/Icon";
import { IconButton } from "../primitives/Button";
import { MenuRow, Popover } from "../primitives/Popover";

export function LinkChangesPanel({
  members,
  projects,
  lists,
  comparisons,
  onComparisonChange,
  loading,
  mode,
  onModeChange,
  onRefresh,
  onSelectFile,
  selectedProjectId,
  activePath,
  commentCounts,
  onCommit,
  onOpenEditor,
  onReveal,
  pullRequest,
}: {
  comparisons?: Record<string, string>;
  onComparisonChange?: (path: string, value: string) => void;
  members: WorktreeBinding[];
  projects: Array<{ id: string; path: string; name: string }>;
  /** Each Project's lists by mode, keyed by Project id: the Changes tab's two sections. */
  lists: Record<DiffMode, Record<string, DiffList>>;
  loading: boolean;
  /** The section the diff shows. */
  mode: DiffMode;
  onModeChange: (mode: DiffMode) => void;
  onRefresh: () => void | Promise<unknown>;
  onSelectFile: (member: WorktreeBinding, path: string, mode: DiffMode) => void;
  selectedProjectId?: string;
  activePath?: string;
  commentCounts?: CommentCounts;
  onCommit: (member: WorktreeBinding) => void;
  /** Left out for a Link on another Mac: these only act on this one. */
  onOpenEditor?: (member: WorktreeBinding) => void;
  onReveal?: (member: WorktreeBinding) => void;
  /** The Projects' PRs, a tab each (`hint` names the Project); while one is picked the panel shows it instead of the changes. */
  pullRequest?: {
    tabs: PrTab[];
    /** The shown PR tab's key. */
    value?: string;
    onPick: (key: string) => void;
    shown: boolean;
    loading: boolean;
    body: ReactNode;
  };
}) {
  const listsOf = (projectId: string): ChangesLists => ({
    uncommitted: lists.uncommitted[projectId] ?? { state: "loading" },
    committed: lists.committed[projectId] ?? { state: "loading" },
  });
  const count = members.reduce((sum, member) => sum + changedFileCount(listsOf(member.projectId)), 0);
  return (
    <aside
      data-changes-panel
      aria-label="Changes"
      className="flex min-h-0 w-[var(--changes-panel-width,320px)] shrink-0 flex-col overflow-hidden rounded-window bg-surface shadow-card"
    >
      <ChangesTabs
        count={count}
        prs={pullRequest?.tabs ?? []}
        selected={pullRequest?.shown ? pullRequest.value : undefined}
        // The Changes tab opens on the shown Project's first section with files, as a Project Chat's panel does.
        onSelect={(key) => (key ? pullRequest?.onPick(key) : onModeChange(firstSection(listsOf(selectedProjectId ?? members[0]?.projectId ?? ""))))}
        onRefresh={onRefresh}
        loading={pullRequest?.shown ? pullRequest.loading : loading}
      />
      {pullRequest?.shown ? (
        pullRequest.body
      ) : (
        <ScrollArea className="flex-1 py-1.5">
          {members.map((member) => (
            <ProjectChanges
              key={member.projectId}
              member={member}
              comparisonValue={comparisons?.[member.worktreePath] ?? ""}
              onComparisonChange={(value) => onComparisonChange?.(member.worktreePath, value)}
              name={projects.find((project) => project.id === member.projectId)?.name ?? member.projectId}
              lists={listsOf(member.projectId)}
              mode={mode}
              onSelectFile={(path, fileMode) => onSelectFile(member, path, fileMode)}
              activePath={selectedProjectId === member.projectId ? activePath : undefined}
              commentCounts={selectedProjectId === member.projectId ? commentCounts : undefined}
              onCommit={() => onCommit(member)}
              onOpenEditor={onOpenEditor && (() => onOpenEditor(member))}
              onReveal={onReveal && (() => onReveal(member))}
            />
          ))}
          {projects
            .filter((project) => !members.some((member) => member.projectId === project.id))
            .map((project) => (
              <section
                key={project.id}
                data-link-changes-pending={project.id}
                aria-label={project.name}
                className="mx-2 mt-1 flex min-w-0 items-start gap-1.5 py-1 pl-4"
              >
                <ProjectAvatarStack projects={[{ path: project.path, name: project.name }]} />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-12 font-medium" title={project.name}>
                    {project.name}
                  </span>
                  <span className="text-11 text-ink-3">{LINK_PENDING_WORKTREE_TEXT}</span>
                </span>
              </section>
            ))}
        </ScrollArea>
      )}
    </aside>
  );
}

function ProjectChanges({
  member,
  comparisonValue,
  onComparisonChange,
  name,
  lists,
  mode,
  onSelectFile,
  activePath,
  commentCounts,
  onCommit,
  onOpenEditor,
  onReveal,
}: {
  member: WorktreeBinding;
  comparisonValue: string;
  onComparisonChange: (value: string) => void;
  name: string;
  lists: ChangesLists;
  mode: DiffMode;
  onSelectFile: (path: string, mode: DiffMode) => void;
  activePath?: string;
  commentCounts?: CommentCounts;
  onCommit: () => void;
  onOpenEditor?: () => void;
  onReveal?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const comparison = useComparison(member.worktreePath, member.base, useBridge(), !collapsed, { value: comparisonValue, onChange: onComparisonChange });
  const [actionsOpen, setActionsOpen] = useState(false);
  const files = [lists.uncommitted, lists.committed].flatMap((list) => (list.state === "ready" && list.isRepo ? list.files : []));
  return (
    <section data-link-changes-project={member.projectId} aria-label={name} className="pb-2">
      <div data-project-header className={`group/project relative mx-2 mt-1 rounded-chip hover:bg-hover ${actionsOpen ? "bg-hover" : ""}`}>
        <button
          type="button"
          data-project-collapse
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${name} changes`}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          className={`flex w-full min-w-0 items-center gap-1.5 rounded-chip py-1 pl-1 text-left transition-[padding] group-hover/project:pr-8 group-focus-within/project:pr-8 ${actionsOpen ? "pr-8" : "pr-1"}`}
        >
          <Icon icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon} size={12} />
          <ProjectAvatarStack projects={[{ path: member.projectPath, name }]} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-12 font-medium" title={name}>
              {name}
            </span>
            <span className="flex min-w-0 items-center gap-1 text-11 text-ink-3">
              <Icon icon={GitBranchIcon} size={12} className="shrink-0" />
              <span className="truncate" title={member.branch}>
                {member.branch}
              </span>
            </span>
          </span>
          <Counts
            className="self-start pt-0.5"
            added={files.reduce((sum, file) => sum + file.added, 0)}
            removed={files.reduce((sum, file) => sum + file.removed, 0)}
          />
        </button>
        <ProjectActions name={name} onOpenChange={setActionsOpen} onCommit={onCommit} onOpenEditor={onOpenEditor} onReveal={onReveal} />
      </div>
      {!collapsed && (
        <div className="pl-5">
          <ComparisonControls comparison={comparison} fileCount={changedFileCount(lists)} />
          {comparison.view === "commits" ? (
            <CommitHistory comparison={comparison} />
          ) : (
            <ChangesSections
              compactComparison={!comparison.unavailable}
              lists={lists}
              mode={mode}
              onSelectFile={onSelectFile}
              activePath={activePath}
              commentCounts={commentCounts}
            />
          )}
        </div>
      )}
    </section>
  );
}

function ProjectActions({
  name,
  onOpenChange,
  onCommit,
  onOpenEditor,
  onReveal,
}: {
  name: string;
  onOpenChange: (open: boolean) => void;
  onCommit: () => void;
  onOpenEditor?: () => void;
  onReveal?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const toggle = (next: boolean) => {
    setOpen(next);
    onOpenChange(next);
  };
  const choose = (action: () => void) => () => {
    toggle(false);
    action();
  };
  return (
    <>
      {/* Positioned by its wrapper (IconButton's own `relative` would beat `absolute`); shown on the row's hover or focus. */}
      <span
        className={`absolute top-1/2 right-1 z-10 -translate-y-1/2 transition-opacity focus-within:opacity-100 group-hover/project:opacity-100 ${open ? "opacity-100" : "opacity-0"}`}
      >
        <IconButton
          ref={trigger}
          label={`${name} actions`}
          icon={MoreVerticalIcon}
          size={24}
          data-project-actions
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => toggle(!open)}
        />
      </span>
      {open && (
        <Popover anchor={trigger} width={230} label={`${name} actions`} onClose={() => toggle(false)} data-link-project-menu>
          <MenuRow icon={GitPullRequestIcon} title="Commit and open PR…" onClick={choose(onCommit)} />
          {onOpenEditor && <MenuRow icon={SourceCodeIcon} title="Open in editor" onClick={choose(onOpenEditor)} />}
          {onReveal && <MenuRow icon={FolderOpenIcon} title="Reveal Worktree" onClick={choose(onReveal)} />}
        </Popover>
      )}
    </>
  );
}
