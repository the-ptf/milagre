import { useEffect, useMemo } from "react";
import { Cancel01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import type { PullRequestRow } from "@milagre/shared/pull-request-list";
import { bridgeFor } from "../../lib/computer-bridge";
import { isModalOpen } from "../../lib/modal";
import { usePanelWidth } from "../agents/panel-width";
import { Property } from "../changes/pr/Properties";
import { PullRequestPanelBody } from "../changes/PullRequestPanel";
import { usePullRequest } from "../changes/usePullRequest";
import { useRefreshSpin } from "../changes/useRefreshSpin";
import { Button, IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { SpinnerRing } from "../primitives/SpinnerRing";
import { Mascot } from "../orchestrator/Mascot";
import { stateGlyph, type ReviewForMe } from "./PullRequestItem";

function ReviewAgent({ review }: { review: ReviewForMe }) {
  return (
    <Property
      data-pr-review-agent={review.reviewing ? "reviewing" : "idle"}
      mark={<Mascot size={14} color={review.color} still />}
      label="Review agent"
      action={
        review.reviewing ? undefined : (
          <Button variant="link" size={24} data-pr-review-agent-start onClick={(event) => review.onReview(event.currentTarget)}>
            Review for me
          </Button>
        )
      }
    >
      {review.reviewing ? (
        <span className="flex items-center gap-1.5 text-12 whitespace-nowrap text-ink-2">
          <SpinnerRing size={12} />
          Reviewing
        </span>
      ) : (
        <span className="text-12 whitespace-nowrap text-ink-3">Not reviewed</span>
      )}
    </Property>
  );
}

/** The PR beside the list, in the PR panel's card: the same body as a Chat's PR tab, read through the Project's folder. */
export function PullRequestPane({ row, review, onClose }: { row: PullRequestRow; review: ReviewForMe | null; onClose: () => void }) {
  const project = row.projects[0];
  const bridge = bridgeFor(project?.computerId ?? row.computerId);
  const detail = usePullRequest({ cwd: project?.cwd, number: row.number, active: true, bridge });
  const spin = useRefreshSpin(() => detail.refresh(), detail.state.status === "loading" || detail.busy !== null);
  const { width } = usePanelWidth("changes");
  const glyph = stateGlyph(row);
  const source = useMemo(() => (project ? { bridge: bridge.pr, cwd: project.cwd } : undefined), [bridge, project]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isModalOpen() || document.documentElement.hasAttribute("data-popover-open")) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <aside
      data-changes-panel
      data-changes-mode="pr"
      data-pr-page-panel={row.url}
      aria-label="Pull request"
      className="panel-grain flex min-h-0 shrink-0 flex-col overflow-hidden rounded-window bg-surface shadow-card"
      style={{ width, animation: "fade-in var(--duration-base) var(--ease-enter)" }}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-3 py-2">
        <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-control bg-hover px-2.5 text-12 font-semibold whitespace-nowrap text-ink">
          <Icon icon={glyph.icon} size={14} className={`shrink-0 ${glyph.className}`} />#{row.number}
        </span>
        <span className="flex-1" />
        <IconButton size={28} label="Refresh the PR" onClick={() => !spin.busy && spin.refresh()} aria-disabled={spin.busy}>
          <span
            className={`flex ${spin.spinning ? "refresh-spin animate-spin" : ""}`}
            onAnimationIteration={spin.onAnimationIteration}
            onAnimationEnd={spin.onAnimationEnd}
          >
            <Icon icon={RefreshIcon} size={16} />
          </span>
        </IconButton>
        <IconButton size={28} label="Close" icon={Cancel01Icon} data-pr-page-close onClick={onClose} />
      </div>
      {project ? (
        <PullRequestPanelBody
          key={row.url}
          review={detail}
          source={source}
          project={{ name: project.name, path: project.path }}
          actions={{ openFile: () => window.open(`${row.url}/files`, "_blank", "noopener,noreferrer") }}
          properties={review && row.state === "OPEN" ? <ReviewAgent review={review} /> : undefined}
        />
      ) : (
        <p className="px-4 py-3 text-12 text-ink-3">None of your Projects is in {row.repo}.</p>
      )}
    </aside>
  );
}
