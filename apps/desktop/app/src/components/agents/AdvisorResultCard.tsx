import { advisorResultLabel } from "@milagre/shared/advisor-result";
import type { AdvisorResultContext } from "@milagre/shared/model";
import { providerName } from "@milagre/shared/providers";
import { ProviderLogo } from "../ProviderLogo";
import { Markdown } from "../markdown/Markdown";
import { ScrollArea } from "../primitives/ScrollArea";

export function AdvisorResultCard({ context, body }: { context: AdvisorResultContext; body: string }) {
  return (
    <section
      data-advisor-result
      aria-label={advisorResultLabel(context)}
      className="flex h-[286px] min-w-0 flex-col rounded-[14px] border border-line bg-surface"
    >
      <header className="shrink-0 px-5 pt-4 pb-3">
        <div className="flex items-center gap-2 text-xs font-medium text-ink-2">
          <ProviderLogo provider={context.provider} size={18} />
          <span>{providerName(context.provider)} advisor</span>
          {context.outcome !== "completed" && (
            <span className={`ml-auto ${context.outcome === "failed" ? "text-red" : "text-ink-2"}`}>{context.outcome === "failed" ? "Failed" : "Stopped"}</span>
          )}
        </div>
        <h3 className="mt-2 line-clamp-2 break-words text-base leading-snug font-semibold text-ink [overflow-wrap:anywhere]" title={context.title}>
          {context.title}
        </h3>
      </header>
      <ScrollArea
        chainScroll
        role="region"
        aria-label="Advisor result"
        tabIndex={0}
        className="mx-1 mb-2 flex-1 rounded-lg px-4 pt-1 pb-3 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <Markdown text={body} />
      </ScrollArea>
    </section>
  );
}
