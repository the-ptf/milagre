import { useState } from "react";
import { ArrowExpand01Icon, ArrowShrink01Icon } from "@hugeicons/core-free-icons";
import { advisorResultLabel, advisorResultRole } from "@milagre/shared/advisor-result";
import type { AdvisorResultContext } from "@milagre/shared/model";
import { ProviderLogo } from "../ProviderLogo";
import { Markdown } from "../markdown/Markdown";
import { ScrollArea } from "../primitives/ScrollArea";
import { IconButton } from "../primitives/Button";
import Tooltip from "../primitives/Tooltip";

export function AdvisorResultCard({ context, body }: { context: AdvisorResultContext; body: string }) {
  // Collapsed, the card keeps a fixed height and scrolls; expanded, it grows to show the whole result.
  const [expanded, setExpanded] = useState(false);
  const resultLabel = context.mode === "execution" ? "execution result" : "advisor result";
  const toggleLabel = `${expanded ? "Collapse" : "Expand"} ${resultLabel}`;
  return (
    <section
      data-advisor-result
      aria-label={advisorResultLabel(context)}
      data-expanded={expanded}
      className={`flex ${expanded ? "" : "h-[286px]"} min-w-0 flex-col rounded-window border border-line bg-surface`}
    >
      <header className="shrink-0 px-5 pt-4 pb-3">
        <div className="flex items-center gap-2 text-12 font-medium text-ink-2">
          <ProviderLogo provider={context.provider} size={18} />
          <span>{advisorResultRole(context)}</span>
          {context.outcome !== "completed" && (
            <span className={`ml-auto ${context.outcome === "failed" ? "text-red-ink" : "text-ink-2"}`}>
              {context.outcome === "failed" ? "Failed" : "Stopped"}
            </span>
          )}
          <Tooltip label={toggleLabel} align="end" className={`${context.outcome === "completed" ? "ml-auto" : ""} -my-1 -mr-1.5`}>
            <IconButton
              label={toggleLabel}
              icon={expanded ? ArrowShrink01Icon : ArrowExpand01Icon}
              size={24}
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            />
          </Tooltip>
        </div>
        <h3 className="mt-2 line-clamp-2 break-words text-15 font-semibold text-ink [overflow-wrap:anywhere]" title={context.title}>
          {context.title}
        </h3>
      </header>
      {expanded ? (
        <div role="region" aria-label={context.mode === "execution" ? advisorResultLabel(context) : "Advisor result"} className="mx-1 mb-2 px-4 pt-1 pb-3">
          <Markdown text={body} images={context.images} />
        </div>
      ) : (
        <ScrollArea
          chainScroll
          role="region"
          aria-label={context.mode === "execution" ? advisorResultLabel(context) : "Advisor result"}
          tabIndex={0}
          className="mx-1 mb-2 flex-1 rounded-card px-4 pt-1 pb-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <Markdown text={body} images={context.images} />
        </ScrollArea>
      )}
    </section>
  );
}
