import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon, ArrowRight01Icon, MicOff01Icon, PauseCircleIcon } from "@hugeicons/core-free-icons";
import type { DictationError, DictationErrorKind } from "@milagre/shared/voice-dictation";

const ICONS: Record<DictationErrorKind, typeof MicOff01Icon> = {
  permission: MicOff01Icon,
  "no-speech": MicOff01Icon,
  failed: AlertCircleIcon,
  interrupted: PauseCircleIcon,
};

/**
 * A take's message in a bubble over the mic, its arrow on the mic, so the words sit by the button that tries again.
 * Clicks pass through to the draft under it; a refused microphone adds a way to the system's settings.
 */
export function DictationNotice({ error, onOpenSettings }: { error: DictationError; onOpenSettings: () => void }) {
  return (
    <div
      role="alert"
      className="pointer-events-none absolute right-0 bottom-full z-[60] mb-2 flex w-max max-w-[320px] items-center gap-1.5 rounded-control bg-ink px-2 py-1.5 text-12 font-medium text-surface shadow-overlay"
      style={{ animation: "fade-in 120ms ease-out both" }}
    >
      <HugeiconsIcon icon={ICONS[error.kind]} size={14} strokeWidth={1.8} aria-hidden className="shrink-0 opacity-70" />
      <span className="min-w-0">{error.message}</span>
      {error.kind === "permission" && (
        <>
          <span aria-hidden className="h-3.5 w-px shrink-0 bg-surface/25" />
          <button type="button" onClick={onOpenSettings} className="pointer-events-auto flex shrink-0 items-center gap-0.5 font-semibold hover:opacity-80">
            Open Settings
            <HugeiconsIcon icon={ArrowRight01Icon} size={12} strokeWidth={2} aria-hidden />
          </button>
        </>
      )}
      {/* Centred on the 28 px mic under the bubble's right edge. */}
      <span aria-hidden className="absolute top-full right-2 size-0 border-x-[6px] border-t-[6px] border-x-transparent border-t-ink" />
    </div>
  );
}
