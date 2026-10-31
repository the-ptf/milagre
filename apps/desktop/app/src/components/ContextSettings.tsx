import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowUp01Icon, ArrowDown01Icon, CleanIcon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { CONTEXT_DEFAULTS, normalizeContextSettings, type ContextSettings as Values } from "@milagre/shared/context-settings";
import { useContextSettings } from "../lib/context-settings";
import { useSettings, updateSettings } from "../lib/settings";
import { ContextBar } from "./ContextBar";
import { SettingCheckbox } from "./primitives/Checkbox";
import { RangeSlider } from "./primitives/RangeSlider";
export function ContextSettings() {
  const local = useSettings();
  const host = useContextSettings();
  const [preview, setPreview] = useState<number | "running">(78);
  const previewPercent = preview === "running" ? 78 : preview;
  const value = host.settings;
  const disabled = !host.ready || host.saving;
  const previewCompact = local.compactButtonDisplay === "always" || previewPercent >= value.buttonThreshold;
  const save = (patch: Partial<Values>) => void host.save(patch);
  const [draft, setDraft] = useState<Values | null>(null);
  const shown = draft ?? value;
  return (
    <section aria-label="Context settings" className="overflow-hidden rounded-card border border-line bg-surface text-13">
      <div className="space-y-3 bg-hover/40 p-4">
        <div className="flex items-center justify-between text-12 text-ink-3">
          <span>Preview</span>
          <div className="flex gap-1">
            {([40, 78, "running"] as const).map((n) => (
              <button
                key={n}
                onClick={() => setPreview(n)}
                aria-pressed={preview === n}
                className={`rounded-control px-2 py-1 ${preview === n ? "bg-surface text-ink" : ""}`}
              >
                {n === "running" ? "Running" : `${n}%`}
              </button>
            ))}
          </div>
        </div>
        <div className="flex h-10 items-center justify-end gap-2 rounded-card border border-line bg-surface px-3">
          <span className="mr-auto truncate text-ink-3">Message the agent…</span>
          {!value.autoCompact && (previewCompact || local.showContextSize) && (
            <span
              className={`flex items-center gap-2 rounded-control px-2 py-1 text-12 ${previewPercent >= value.buttonThreshold ? "bg-orange/15 text-orange-ink" : "text-ink-2"}`}
            >
              {previewCompact && (
                <span className="flex items-center gap-1">
                  <HugeiconsIcon icon={CleanIcon} size={14} />
                  {preview === "running" ? "After turn" : "Compact"}
                </span>
              )}
              {local.showContextSize ? <span>{previewPercent}%</span> : <HugeiconsIcon icon={ArrowDown01Icon} size={12} />}
            </span>
          )}
          <span aria-label="Send preview" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-surface">
            <HugeiconsIcon icon={ArrowUp01Icon} size={16} />
          </span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-6 border-t border-line p-4">
        <div>
          <p>Context size beside Send</p>
          <p className="mt-1 text-12 text-ink-3">Click it for usage and Compact now.</p>
        </div>
        <SettingCheckbox label="Show context size" checked={local.showContextSize} onChange={(showContextSize) => updateSettings({ showContextSize })} />
      </div>
      <div className="flex items-center justify-between gap-6 border-t border-line p-4">
        <div>
          <p>Auto compact quietly</p>
          <p className="mt-1 text-12 text-ink-3">Compacts at your limit without context controls or notifications.</p>
        </div>
        <SettingCheckbox label="Auto compact quietly" disabled={disabled} checked={value.autoCompact} onChange={(autoCompact) => save({ autoCompact })} />
      </div>
      <div className="border-t border-line p-4">
        <p>Thresholds on this computer</p>
        <p className="mt-1 text-12 text-ink-3">Drag either marker or enter a percentage. Auto compact waits for the reply to finish.</p>
        <div
          className="relative mt-3"
          onPointerUp={() => {
            if (draft) {
              save(draft);
              setDraft(null);
            }
          }}
          onBlur={() => {
            if (draft) {
              save(draft);
              setDraft(null);
            }
          }}
        >
          <ContextBar settings={shown} editable />
          <div className="absolute inset-0">
            <RangeSlider
              variant="context"
              label="Compact button threshold"
              value={shown.buttonThreshold}
              min={0}
              max={100}
              disabled={disabled}
              onValueChange={(n) => setDraft(normalizeContextSettings({ ...shown, buttonThreshold: Math.min(n, shown.autoThreshold - 5) }))}
              secondary={{
                label: "Automatic compaction threshold",
                value: shown.autoThreshold,
                min: 0,
                max: 100,
                disabled,
                onValueChange: (n) => setDraft(normalizeContextSettings({ ...shown, autoThreshold: n })),
              }}
            />
          </div>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-4">
          {(["buttonThreshold", "autoThreshold"] as const).map((key) => (
            <label key={key} className="space-y-2 text-12">
              <span className="block">{key === "buttonThreshold" ? "Compact button turns orange at" : "Auto compact at"}</span>
              <div className="inline-flex h-8 items-center overflow-hidden rounded-control border border-line-strong">
                <button
                  disabled={disabled}
                  aria-label={`Decrease ${key === "buttonThreshold" ? "button" : "automatic"} threshold`}
                  className="h-full w-8 hover:bg-hover"
                  onClick={() => save({ [key]: value[key] - 1 })}
                >
                  −
                </button>
                <input
                  aria-label={key === "buttonThreshold" ? "Compact button threshold percentage" : "Auto compact threshold percentage"}
                  type="number"
                  min={key === "buttonThreshold" ? 5 : value.buttonThreshold + 5}
                  max={key === "buttonThreshold" ? 90 : 95}
                  disabled={disabled}
                  key={value[key]}
                  defaultValue={value[key]}
                  onBlur={(e) => {
                    const n = Number(e.target.value);
                    if (e.target.value.trim() && Number.isFinite(n)) {
                      const next = normalizeContextSettings({ ...value, [key]: n });
                      e.target.value = String(next[key]);
                      save({ [key]: next[key] });
                    } else e.target.value = String(value[key]);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  className="w-12 bg-transparent text-center tabular-nums outline-none"
                />
                <span>%</span>
                <button
                  disabled={disabled}
                  aria-label={`Increase ${key === "buttonThreshold" ? "button" : "automatic"} threshold`}
                  className="h-full w-8 hover:bg-hover"
                  onClick={() => save({ [key]: value[key] + 1 })}
                >
                  +
                </button>
              </div>
            </label>
          ))}
        </div>
        <div className="mt-4 flex justify-between gap-3 text-11 text-ink-3">
          <span>Auto compact stays at least 5% above the button.</span>
          <button disabled={disabled} className="text-accent-ink" onClick={() => save(CONTEXT_DEFAULTS)}>
            Reset to defaults
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-6 border-t border-line p-4">
        <div>
          <p>Show Compact below threshold</p>
          <p className="mt-1 text-12 text-ink-3">Off by default. The button appears only at your threshold.</p>
        </div>
        <SettingCheckbox
          label="Show Compact below threshold"
          checked={local.compactButtonDisplay === "always"}
          onChange={(on) => updateSettings({ compactButtonDisplay: on ? "always" : "threshold" })}
        />
      </div>
      {host.error && (
        <p role="alert" className="px-4 pb-4 text-12 text-red-ink">
          {host.error}
        </p>
      )}
    </section>
  );
}
