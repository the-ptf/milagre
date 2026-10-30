import { AlertCircleIcon, ArrowRight01Icon, MicOff01Icon, PauseCircleIcon } from "@hugeicons/core-free-icons";
import type { DictationError, DictationErrorKind } from "@milagre/shared/voice-dictation";
import { Icon } from "./primitives/Icon";

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
      className="pointer-events-none absolute right-0 bottom-full z-[60] mb-2 flex w-max max-w-[320px] items-center gap-1.5 rounded-control bg-ink px-2 py-1.5 text-12 font-medium text-on-ink shadow-overlay"
      style={{ animation: "fade-in var(--duration-fast) var(--ease-enter) both" }}
    >
      <Icon icon={ICONS[error.kind]} size={14} className="shrink-0" />
      <span className="min-w-0">{error.message}</span>
      {error.kind === "permission" && (
        <>
          <span aria-hidden className="h-3.5 w-px shrink-0 bg-on-ink/25" />
          <button
            type="button"
            onClick={onOpenSettings}
            className="pointer-events-auto relative flex shrink-0 items-center gap-0.5 font-semibold underline-offset-2 before:absolute before:-inset-1 hover:underline"
          >
            Open Settings
            <Icon icon={ArrowRight01Icon} size={12} />
          </button>
        </>
      )}
      {/* Centred on the 28 px mic under the bubble's right edge. */}
      <span aria-hidden className="absolute top-full right-2 size-0 border-x-[6px] border-t-[6px] border-x-transparent border-t-ink" />
    </div>
  );
}
