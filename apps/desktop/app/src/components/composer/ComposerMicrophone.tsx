import { Cancel01Icon, Mic01Icon } from "@hugeicons/core-free-icons";
import { DictationNotice } from "../DictationNotice";
import { DownloadRing, DroppingArrow } from "../DownloadRing";
import Tooltip from "../primitives/Tooltip";
import { Icon } from "../primitives/Icon";
import type { useDictationTake } from "./use-dictation-take";
import { DictationVocabulary } from "./DictationVocabulary";

export function ComposerMicrophone({ take, cwd }: { take: ReturnType<typeof useDictationTake>; cwd: string }) {
  const { dictationError, dictation, dictateShortcutLabel, discardDictation, dictating, fixing, startDictation, openVocabulary } = take;
  return (
    <>
      {take.vocabulary && <DictationVocabulary cwd={cwd} correction={take.vocabulary.correction} onClose={take.closeVocabulary} />}
      <span className="relative flex shrink-0">
        {dictationError && <DictationNotice error={dictationError} onOpenSettings={dictation.openSettings} />}
        {dictation.download ? (
          <Tooltip
            label={`Downloading speech model · ${Math.round((dictation.download.received / dictation.download.total) * 100)}% of ${Math.round(dictation.download.total / 1e6)} MB`}
            align="end"
          >
            <button
              type="button"
              data-dictation-download
              aria-label={`Downloading speech model, ${Math.round((dictation.download.received / dictation.download.total) * 100)}%. Cancel`}
              onClick={discardDictation}
              className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink"
            >
              <DownloadRing size={28} progress={dictation.download.received / dictation.download.total}>
                <DroppingArrow size={14} well={20} />
              </DownloadRing>
            </button>
          </Tooltip>
        ) : dictating ? (
          <span data-dictation-capsule className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-hover px-1">
            <button
              type="button"
              aria-label="Discard dictation"
              title="Discard dictation"
              onClick={discardDictation}
              className="flex size-6 shrink-0 items-center justify-center rounded-full text-ink-2 transition-colors hover:text-ink"
            >
              <Icon icon={Cancel01Icon} size={14} />
            </button>
            {dictation.phase === "recording" ? (
              <button
                ref={dictation.setMeter}
                type="button"
                aria-label="Stop dictation"
                title="Stop dictation"
                onClick={() => void dictation.stop()}
                className="relative flex size-6 shrink-0 items-center justify-center rounded-full"
              >
                <span
                  aria-hidden
                  className="absolute inset-0.5 rounded-full bg-red/25 motion-safe:transition-transform motion-safe:duration-75"
                  style={{
                    transform: "scale(calc(1 + var(--level, 0) * 0.38))",
                  }}
                />
                <span aria-hidden className="relative block size-2.5 rounded-inline bg-red" />
              </button>
            ) : (
              <span aria-hidden className="flex size-6 shrink-0 items-center justify-center">
                <span className="block size-4 rounded-full border-2 border-line border-t-ink-2 border-r-ink-2 motion-safe:animate-spin" />
              </span>
            )}
          </span>
        ) : (
          <Tooltip
            label={fixing !== null ? (fixing ? `Correcting names · ${fixing}` : "Correcting names…") : "Dictate"}
            shortcut={dictateShortcutLabel}
            align="end"
          >
            <button
              type="button"
              aria-label="Dictate"
              aria-description={fixing !== null ? "Correcting names. Start a new dictation to replace the pending correction." : undefined}
              onClick={startDictation}
              onContextMenu={(event) => {
                event.preventDefault();
                openVocabulary();
              }}
              className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors hover:bg-hover hover:text-ink"
            >
              <Icon icon={Mic01Icon} size={16} />
            </button>
          </Tooltip>
        )}
      </span>{" "}
    </>
  );
}
