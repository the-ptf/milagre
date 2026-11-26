import { useMemo } from "react";
import { Alert02Icon, PaintBoardIcon } from "@hugeicons/core-free-icons";
import { DESIGNS_COPY, designDecisionLine, designDecisionSummary, type DesignSystemView } from "@milagre/shared/artifact";
import { scopeFromKey, unqualifyKey } from "@milagre/shared/chat-scopes";
import { designProjectName, requestFromDesigns } from "../../lib/design-library-page";
import { Button } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { Icon } from "../primitives/Icon";
import { ScrollArea } from "../primitives/ScrollArea";
import { SectionLabel } from "../primitives/SectionLabel";
import { useDesignSystem } from "./design-home";

/**
 * The Designs page's Design system section: the board the host draws from the Project's kit (a Named Link's member's)
 * and its decision log beside it, newest first.
 */
export function DesignSystemPanel({ projectKey, now }: { projectKey: string; now: number }) {
  const { value, error, retry } = useDesignSystem(projectKey);
  if (!value && error)
    return (
      <EmptyState title={DESIGNS_COPY.failed} size="page" data-slot="design-system-failed" action={<Button onClick={retry}>Try again</Button>}>
        {error}
      </EmptyState>
    );
  if (!value)
    return <div aria-busy="true" aria-label="Loading the design system" className="m-6 h-[480px] max-w-[720px] flex-1 animate-pulse rounded-card bg-hover" />;
  return (
    <div data-slot="design-system" className="relative flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {value.state === "frozen" && <FrozenBanner projectKey={projectKey} />}
        {value.state === "ready" && <Board view={value} />}
        {value.state === "none" && <NoDesignSystem />}
      </div>
      {value.state === "ready" && <Decisions view={value} now={now} />}
    </div>
  );
}

type Ready = Extract<DesignSystemView, { state: "ready" }>;

function Board({ view }: { view: Ready }) {
  const sources = useMemo(() => view.boards.map((board) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(board.svg)}`), [view.boards]);
  return (
    <ScrollArea className="min-h-0 flex-1" aria-label="Design system board">
      <div className="flex flex-col gap-4 p-6">
        {view.owner && (
          <p data-slot="design-system-owner" className="mb-3 text-12 text-ink-3">
            From {designProjectName(view.owner)}
          </p>
        )}
        {view.boards.map((board, index) => (
          <img
            key={index}
            data-slot="design-system-board"
            src={sources[index]}
            width={board.width}
            height={board.height}
            alt={index ? "" : `${view.kit.title} design system, version ${view.kit.version}`}
            className="h-auto max-w-full rounded-card bg-paper shadow-raised"
          />
        ))}
      </div>
    </ScrollArea>
  );
}

function Decisions({ view, now }: { view: Ready; now: number }) {
  return (
    <aside data-slot="design-decisions" aria-label={DESIGNS_COPY.decisions} className="flex w-72 shrink-0 flex-col border-l border-line">
      <SectionLabel as="h2" className="flex h-10 items-center px-4">
        {DESIGNS_COPY.decisions}
      </SectionLabel>
      <ScrollArea className="min-h-0 flex-1">
        <ol className="flex flex-col px-4 pb-4">
          {view.history.map((entry) => (
            <li key={entry.version} data-slot="design-decision" className="border-b border-line py-2.5 last:border-b-0">
              <p className={`text-13 font-medium ${entry.decision ? "text-ink" : "text-ink-3"}`}>{designDecisionSummary(entry)}</p>
              {entry.decision?.reason && <p className="mt-0.5 text-12 text-ink-2">{entry.decision.reason}</p>}
              <p className="mt-1 text-11 text-ink-3">{designDecisionLine(entry, now)}</p>
            </li>
          ))}
        </ol>
      </ScrollArea>
    </aside>
  );
}

function NoDesignSystem() {
  return (
    <EmptyState icon={PaintBoardIcon} title={DESIGNS_COPY.noSystemTitle} size="page" data-slot="design-system-empty">
      {DESIGNS_COPY.noSystemBody}
    </EmptyState>
  );
}

function FrozenBanner({ projectKey }: { projectKey: string }) {
  const scope = scopeFromKey(unqualifyKey(projectKey));
  return (
    <div data-slot="design-system-frozen" role="status" className="m-4 flex items-center gap-3 rounded-card bg-orange-tint px-3 py-2.5">
      <Icon icon={Alert02Icon} size={16} className="text-orange" />
      <p className="min-w-0 flex-1 text-13">
        <span className="font-medium text-ink">{DESIGNS_COPY.frozenTitle}</span> <span className="text-ink-2">{DESIGNS_COPY.frozenBody}</span>
      </p>
      {scope.kind === "link" && (
        <Button variant="secondary" size={28} onClick={() => requestFromDesigns({ linkId: scope.linkId })}>
          {DESIGNS_COPY.chooseProject}
        </Button>
      )}
    </div>
  );
}
