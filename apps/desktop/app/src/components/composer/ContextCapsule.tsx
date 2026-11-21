import { HugeiconsIcon } from "@hugeicons/react";
import { CleanIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import type { ComponentProps } from "react";
import type { ContextUsage, ModelOption } from "../../model";
import { ContextRing } from "../ContextRing";

/** A local model's window is small and fills fast, so its Chats always show how much is used: none before the first turn. */
export function shownContextUsage(contextUsage: ContextUsage | undefined, model: ModelOption): ContextUsage | undefined {
  if (contextUsage || model.provider !== "ollama" || !model.contextWindow) return contextUsage;
  return { used: 0, size: model.contextWindow };
}

export function ContextCapsule({
  compactButton,
  compactQueued,
  compacting,
  contextUsage,
  alwaysShown,
  showContextSize,
  compactLabel,
  compactBlocked,
  running,
  settings,
  onCompact,
  onCancelCompact,
}: {
  compactButton: { visible: boolean; warning: boolean };
  compactQueued: boolean;
  compacting: boolean;
  contextUsage: ContextUsage | undefined;
  alwaysShown: boolean;
  showContextSize: boolean;
  compactLabel: string;
  compactBlocked: string | null;
  running: boolean;
  settings: ComponentProps<typeof ContextRing>["settings"];
  onCompact?: () => void;
  onCancelCompact?: () => void;
}) {
  const sized = Boolean(contextUsage && contextUsage.size > 0);
  const compactShown = compactButton.visible || compactQueued || compacting;
  if (!compactShown && !((showContextSize || alwaysShown) && sized)) return null;
  return (
    <div
      data-context-capsule
      className={`flex shrink-0 items-center overflow-hidden rounded-control ${compactButton.warning ? "bg-orange/15 text-orange-ink" : "text-ink-2"}`}
    >
      {compactShown && (
        <button
          type="button"
          data-compact-context
          aria-label={compactQueued ? "Cancel queued compaction" : "Compact context"}
          disabled={Boolean(compactBlocked)}
          title={compactLabel}
          onClick={compactQueued ? onCancelCompact : onCompact}
          className="flex h-7 items-center gap-1 px-2 text-12 font-medium disabled:opacity-40"
        >
          <HugeiconsIcon icon={compactQueued ? Cancel01Icon : CleanIcon} size={14} strokeWidth={1.8} color="currentColor" />
          <span className="@max-[700px]:hidden">{compactLabel}</span>
        </button>
      )}
      {contextUsage && sized && (
        <ContextRing
          {...contextUsage}
          onCompact={onCompact}
          compactBlocked={compactBlocked}
          compactLabel={running ? "Compact after turn" : "Compact now"}
          settings={settings}
          showSize={showContextSize || alwaysShown}
        />
      )}
    </div>
  );
}
