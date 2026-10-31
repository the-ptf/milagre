import { useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Delete02Icon, Download04Icon, MoreHorizontalIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { WHISPER_MODELS, type WhisperModel } from "@milagre/shared/dictation";
import type { DictationModelState } from "../../electron";
import { useDismiss } from "../../lib/use-dismiss";
import { DownloadRing } from "../DownloadRing";
import { dictationModels, useDictationModels } from "../useDictationModels";

const megabytes = (bytes: number) => Math.round(bytes / 1e6);

function Dots({ label, value }: { label: string; value: number }) {
  return (
    <span className="flex items-center gap-1.5" aria-label={`${label} ${value} of 3`}>
      <span aria-hidden>{label}</span>
      <span aria-hidden className="flex gap-0.5">
        {[1, 2, 3].map((dot) => (
          <span key={dot} className={`size-1.5 rounded-full ${dot <= value ? "bg-ink-2" : "bg-line-strong"}`} />
        ))}
      </span>
    </span>
  );
}

function detail(model: WhisperModel, state: DictationModelState | undefined, selected: boolean) {
  if (state?.received != null) return `${model.name} · ${megabytes(state.received)} of ${megabytes(model.size)} MB`;
  if (state?.ready) return `${model.name} · ${megabytes(model.size)} MB · Downloaded`;
  return `${model.name} · ${megabytes(model.size)} MB${selected ? " · Downloads on your next take" : ""}`;
}

/** A downloaded model's … menu: its one action is freeing the disk it takes. */
function MoreMenu({ model }: { model: WhisperModel }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  useDismiss(
    open,
    () => setOpen(false),
    (target) => Boolean(root.current?.contains(target)),
  );
  return (
    <span ref={root} className="relative flex">
      <button
        type="button"
        aria-label={`More for ${model.purpose}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => event.key === "Escape" && setOpen(false)}
        className="flex size-7 items-center justify-center rounded-control text-ink-2 hover:bg-hover"
      >
        <HugeiconsIcon icon={MoreHorizontalIcon} size={16} />
      </button>
      {open && (
        <span
          role="menu"
          className="absolute top-full right-0 z-20 mt-1 rounded-control bg-surface p-1 shadow-overlay"
          style={{ animation: "pop-in 160ms cubic-bezier(0.23,1,0.32,1) both", transformOrigin: "top right" }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void dictationModels.remove(model.id);
            }}
            className="flex h-8 items-center gap-2 whitespace-nowrap rounded-inline px-2 text-13 font-medium text-red-ink hover:bg-hover"
          >
            <HugeiconsIcon icon={Delete02Icon} size={14} />
            Delete download · {megabytes(model.size)} MB
          </button>
        </span>
      )}
    </span>
  );
}

/**
 * Settings › Chat › Dictation: the speech models this computer can run, named for what each is good at. Picking one uses
 * it and starts its download; the ring cancels it, and a downloaded model's … menu deletes it.
 */
export function SpeechModelChoice({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const states = useDictationModels();
  const pick = (model: WhisperModel) => {
    onChange(model.id);
    const state = states[model.id];
    if (!state?.ready && state?.received == null) void dictationModels.download(model.id).catch(() => {});
  };
  return (
    <div role="radiogroup" aria-label="Speech model" className="rounded-card bg-surface shadow-card">
      {WHISPER_MODELS.desktop.map((model, index) => {
        const state = states[model.id];
        const selected = model.id === value;
        const downloading = state?.received != null;
        return (
          <div
            key={model.id}
            data-speech-model={model.id}
            className={`relative flex h-[60px] items-center gap-3 pr-3 pl-4 ${index > 0 ? "before:absolute before:top-0 before:right-0 before:left-11 before:border-t before:border-line" : ""}`}
          >
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={model.purpose}
              aria-description={detail(model, state, selected)}
              onClick={() => pick(model)}
              className="flex min-w-0 flex-1 items-center gap-3 self-stretch text-left"
            >
              <span className="flex w-4 shrink-0 text-accent-ink">{selected && <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={2.2} />}</span>
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className={`text-13 text-ink ${selected ? "font-semibold" : "font-medium"}`}>{model.purpose}</span>
                <span className="truncate text-12 text-ink-3 tabular-nums">{detail(model, state, selected)}</span>
              </span>
              <span className="flex w-44 shrink-0 items-center gap-3 text-11 text-ink-3">
                <Dots label="Accuracy" value={model.accuracy} />
                <Dots label="Speed" value={model.speed} />
              </span>
            </button>
            <span className="flex w-[104px] shrink-0 justify-end">
              {downloading ? (
                <button
                  type="button"
                  aria-label={`Cancel the ${model.purpose} download`}
                  onClick={() => void dictationModels.cancel(model.id)}
                  className="flex size-7 items-center justify-center rounded-full text-ink"
                >
                  <DownloadRing size={24} progress={(state.received ?? 0) / model.size}>
                    <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2.4} />
                  </DownloadRing>
                </button>
              ) : state?.ready ? (
                <MoreMenu model={model} />
              ) : (
                <button
                  type="button"
                  onClick={() => void dictationModels.download(model.id).catch(() => {})}
                  className="flex h-7 items-center gap-1.5 rounded-control bg-hover px-2.5 text-12 font-medium text-ink hover:bg-hover-2"
                >
                  <HugeiconsIcon icon={Download04Icon} size={14} />
                  Download
                </button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
