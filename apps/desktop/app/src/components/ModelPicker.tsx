import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { FlashIcon, Search01Icon, Tick02Icon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import { providerName } from "@milagre/shared/providers";
import { formatCredits } from "@milagre/shared/kiro-models";
import type { AgentCliStatus, EffortLevel, ModelCapability, ModelOption, ModelProvider } from "../model";
import { effortCopy } from "../model";
import { cliMessage, cliTabLabel } from "../lib/cli-status";
import { contextWindowFor } from "../lib/model-options";
import { formatTokens } from "./usage/format";
import { ProviderLogo } from "./ProviderLogo";
import { ScrollArea } from "./primitives/ScrollArea";
import { RangeSlider } from "./primitives/RangeSlider";

/** The model's context window as the picker shows it: "1M", "272k". */
function contextLabel(model: ModelOption) {
  const size = contextWindowFor(model);
  return size ? formatTokens(size) : undefined;
}

/** A Kiro model's credit multiplier ("2×"), else its context window. */
function metaLabel(model: ModelOption) {
  return model.credits ? formatCredits(model.credits) : contextLabel(model);
}

/** Model, thinking effort, fast mode and Ultracode in one popover: a provider rail that scrolls as providers grow,
 * the provider's models, and the selected model's settings beside them. Picking a model keeps it open. */
export function ModelPicker({
  style,
  providers,
  provider,
  onProviderChange,
  models,
  totalModels,
  query,
  onQueryChange,
  cliStatus,
  notice,
  selectedModel,
  onModelChange,
  capability,
  effort,
  onEffortChange,
  fastMode,
  onFastModeChange,
  ultracode,
  onUltracodeChange,
}: {
  style: CSSProperties;
  providers: ModelProvider[];
  provider: ModelProvider;
  onProviderChange: (provider: ModelProvider) => void;
  /** The open provider's models, filtered by the search. */
  models: ModelOption[];
  totalModels: number;
  query: string;
  onQueryChange: (query: string) => void;
  cliStatus: AgentCliStatus | null;
  notice?: ReactNode;
  selectedModel: ModelOption;
  onModelChange: (model: ModelOption) => void;
  capability: ModelCapability;
  effort?: EffortLevel;
  onEffortChange: (effort: EffortLevel) => void;
  fastMode: boolean;
  onFastModeChange: (on: boolean) => void;
  ultracode: boolean;
  onUltracodeChange: (on: boolean) => void;
}) {
  const levels = capability.efforts;
  const lowest = levels[0];
  const highest = levels.at(-1);
  const hasSettings = levels.length > 0 || capability.fastMode || capability.ultracode;
  const index = Math.max(0, levels.indexOf(effort ?? ""));
  const current = levels[index];

  // Arrow keys move through the model rows, Enter picks; the search field keeps typing.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-picker-row]")];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const searching = event.target instanceof HTMLInputElement;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!searching && at < 0) return;
      event.preventDefault();
      event.stopPropagation();
      const next = at < 0 ? (event.key === "ArrowDown" ? 0 : rows.length - 1) : (at + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      rows[next]?.focus({ preventScroll: true });
      rows[next]?.scrollIntoView({ block: "nearest" });
    } else if (searching && event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      rows[0]?.click();
    }
  }

  return (
    <div
      data-picker-panel
      data-model-picker
      className={`absolute z-20 flex h-[340px] overflow-hidden rounded-[12px] border border-line bg-surface shadow-raised ${hasSettings ? "w-[580px]" : "w-[300px]"}`}
      style={{ animation: "pop-in 180ms cubic-bezier(0.23,1,0.32,1) both", ...style }}
    >
      <ScrollArea data-provider-tabs aria-label="Providers" className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-inset py-2">
        {providers.map((item) => {
          const warning = cliTabLabel(cliStatus?.[item]);
          const on = item === provider;
          return (
            <button
              key={item}
              type="button"
              aria-label={providerName(item)}
              aria-pressed={on}
              title={cliMessage(cliStatus?.[item]) ?? providerName(item)}
              onClick={() => onProviderChange(item)}
              className={`relative flex size-8 shrink-0 items-center justify-center rounded-[8px] transition-colors ${on ? "bg-surface shadow-xs" : "hover:bg-hover"}`}
            >
              {on && <span aria-hidden className="absolute top-2 bottom-2 -left-1.5 w-[3px] rounded-r-full bg-accent-ink" />}
              <span className={on ? "" : "opacity-60 grayscale-[0.4]"}>
                <ProviderLogo provider={item} size={16} />
              </span>
              {warning && <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-orange" />}
            </button>
          );
        })}
      </ScrollArea>

      <div onKeyDown={handleKeyDown} className={`flex min-w-0 flex-col pt-2 pl-2 ${hasSettings ? "w-[240px] shrink-0 border-r border-line" : "flex-1"}`}>
        <div className="flex items-baseline justify-between px-1.5 pr-3.5 pb-1.5">
          <strong className="text-sm text-ink">{providerName(provider)}</strong>
          <span className="text-[10.5px] text-ink-3">
            {totalModels} {totalModels === 1 ? "model" : "models"}
          </span>
        </div>
        <label className="mr-2 mb-1 flex shrink-0 items-center gap-2 rounded-control border border-line px-2.5 py-1.5 text-ink-3">
          <HugeiconsIcon icon={Search01Icon} size={14} strokeWidth={1.8} color="currentColor" />
          <input
            className="w-full border-0 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search models…"
            autoFocus
          />
        </label>
        {notice}
        <ScrollArea className="grid flex-1 grid-cols-1 content-start gap-0.5 pr-2 pb-2">
          {models.map((model) => {
            const selected = model.id === selectedModel.id && model.provider === selectedModel.provider;
            const meta = metaLabel(model);
            return (
              <button
                key={model.id}
                type="button"
                data-picker-row
                title={model.description || undefined}
                aria-current={selected || undefined}
                onClick={() => onModelChange(model)}
                className={`flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-ink-3 focus-visible:-outline-offset-2 ${selected ? "bg-hover" : "hover:bg-inset"}`}
              >
                <ProviderLogo provider={model.provider} size={14} />
                <strong className="truncate text-xs font-medium text-ink">{model.name}</strong>
                {meta && (
                  <span
                    data-picker-meta
                    title={model.credits ? `Uses ${formatCredits(model.credits)} the credits Auto would` : undefined}
                    className="shrink-0 rounded-chip border border-line px-1 text-[10px] leading-[14px] font-medium tabular-nums text-ink-3"
                  >
                    {meta}
                  </span>
                )}
                {selected && (
                  <span className="ml-auto shrink-0 text-ink">
                    <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={1.8} color="currentColor" />
                  </span>
                )}
              </button>
            );
          })}
          {models.length === 0 && <div className="px-2 py-5 text-center text-xs text-ink-3">No models found.</div>}
        </ScrollArea>
      </div>

      {hasSettings && (
        <div data-model-settings className="flex min-w-0 flex-1 flex-col gap-3 p-3">
          {levels.length > 0 && current && (
            <div className="flex flex-col">
              <span className="pb-2.5 text-[10.5px] font-semibold tracking-[0.02em] text-ink-3 uppercase">Thinking effort</span>
              {levels.length > 1 && lowest !== undefined && highest !== undefined ? (
                <>
                  <RangeSlider
                    label="Thinking effort"
                    value={index}
                    min={0}
                    max={levels.length - 1}
                    step={1}
                    onValueChange={(value) => {
                      const level = levels[value];
                      if (level !== undefined) onEffortChange(level);
                    }}
                    formatValueText={(value) => (levels[value] === undefined ? "" : effortCopy(levels[value]).name)}
                  />
                  <div className="flex justify-between pt-1.5 text-[10px] text-ink-3">
                    <span>{effortCopy(lowest).name}</span>
                    <span>{effortCopy(highest).name}</span>
                  </div>
                </>
              ) : null}
              <p data-effort-caption className="pt-1.5 text-[11px] leading-snug text-ink-3">
                <strong className={`font-semibold ${current === "ultra" ? "text-purple-ink" : "text-ink"}`}>{effortCopy(current).name}</strong>
                {effortCopy(current).description ? ` · ${effortCopy(current).description}` : ""}
              </p>
            </div>
          )}
          {(capability.fastMode || capability.ultracode) && (
            <div className="flex flex-col gap-1.5">
              {capability.fastMode && (
                <SettingRow icon={FlashIcon} label="Fast mode" title="Fast" detail="Quicker replies, higher usage" on={fastMode} onChange={onFastModeChange} />
              )}
              {capability.ultracode && (
                <SettingRow
                  icon={UserMultipleIcon}
                  label="Ultracode"
                  title="Ultracode"
                  tone="purple"
                  detail="Parallel agents for big work"
                  on={ultracode}
                  onChange={onUltracodeChange}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SettingRow({
  icon,
  label,
  title,
  detail,
  on,
  onChange,
  tone = "orange",
}: {
  /** The color the row takes while on: Fast is orange, Ultracode purple like its Fatality overlay. */
  tone?: "orange" | "purple";
  icon: typeof FlashIcon;
  label: string;
  title: string;
  detail: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  const ink = tone === "purple" ? "text-purple-ink" : "text-orange-ink";
  return (
    <button
      type="button"
      role="checkbox"
      aria-label={label}
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`flex w-full items-center gap-2.5 rounded-control border px-2.5 py-2 text-left transition-colors ${on ? `border-transparent ${tone === "purple" ? "bg-purple-tint" : "bg-orange-tint"}` : "border-line hover:bg-inset"}`}
    >
      <span className={on ? ink : "text-ink-2"}>
        <HugeiconsIcon icon={icon} size={15} strokeWidth={1.8} color="currentColor" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <strong className={`text-xs font-semibold ${on ? ink : "text-ink"}`}>{title}</strong>
        <span className="truncate text-[10.5px] text-ink-3">{detail}</span>
      </span>
    </button>
  );
}
