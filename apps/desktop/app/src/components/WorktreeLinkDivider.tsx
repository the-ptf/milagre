import { useState } from "react";
import { GitBranchIcon, Link04Icon } from "@hugeicons/core-free-icons";
import { linkedSummaryText, worktreeLinkLabel, worktreeLinkText } from "@milagre/shared/worktree-link";
import type { WorktreeLinkedContext } from "../model";
import { useProjectImages } from "../lib/project-images";
import { HandoffBriefDialog } from "./Handover";
import { Icon } from "./primitives/Icon";
import { ProjectAvatar } from "./primitives/ProjectAvatar";
import { TranscriptDivider } from "./primitives/TranscriptDivider";

/**
 * A Link on the canvas that reached this Chat: a hairline with "Linked to  web  main" centred on it, as the handoff
 * divider is drawn. It opens the linked summary the Chat's next turn gets.
 */
export function WorktreeLinkDivider({ context }: { context: WorktreeLinkedContext }) {
  const [open, setOpen] = useState(false);
  const imageOf = useProjectImages([context.project.path]);
  const label = worktreeLinkLabel(context);
  const canOpen = Boolean(context.summary);
  return (
    <>
      <TranscriptDivider data-worktree-link-divider label={worktreeLinkText(context)}>
        {/* The visible text names the button; it opens the summary in a dialog. -mx/-my keep the row's size with a 24px target. */}
        <button
          type="button"
          disabled={!canOpen}
          onClick={() => setOpen(true)}
          aria-haspopup={canOpen ? "dialog" : undefined}
          className="-mx-2 -my-0.5 flex h-6 min-w-0 items-center gap-1.5 rounded-control px-2 transition-colors duration-fast enabled:hover:bg-hover enabled:hover:text-ink disabled:cursor-default"
        >
          <Icon icon={Link04Icon} size={12} className="shrink-0" />
          <span className="shrink-0">Linked to{label.lead ? ` ${label.lead}` : ""}</span>
          {label.project ? (
            <>
              <ProjectAvatar name={label.project} src={imageOf(context.project.path)} size={16} />
              <span className="truncate font-medium text-ink-2">{label.project}</span>
            </>
          ) : (
            <Icon icon={GitBranchIcon} size={12} className="shrink-0" />
          )}
          {label.detail && <span className={`truncate font-mono text-11 ${label.project ? "" : "font-medium text-ink-2"}`}>{label.detail}</span>}
          {context.sameProject && <span className="shrink-0 text-11">in this Project</span>}
        </button>
      </TranscriptDivider>
      {open && context.summary && <HandoffBriefDialog title="Linked summary" brief={linkedSummaryText(context.summary)} onClose={() => setOpen(false)} />}
    </>
  );
}
