import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { FlashIcon, Search01Icon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import { providerName } from "@milagre/shared/providers";
import type { AgentCliStatus, EffortLevel, ModelCapability, ModelOption, ModelProvider } from "../model";
import { effortCopy } from "../model";
import { cliMessage, cliTabLabel } from "../lib/cli-status";
import { contextWindowFor } from "../lib/model-options";
import { formatTokens } from "./usage/format";
import { ProviderLogo } from "./ProviderLogo";
import { EmptyState } from "./primitives/EmptyState";
import { PickerRow } from "./primitives/Picker";
import { ScrollArea } from "./primitives/ScrollArea";
import { RangeSlider } from "./primitives/RangeSlider";
import { Icon } from "./primitives/Icon";
import { SectionLabel } from "./primitives/SectionLabel";
import Tooltip from "./primitives/Tooltip";

/** The model's context window as the picker shows it: "1M", "272k". */
function contextLabel(model: ModelOption) {
  const size = contextWindowFor(model);
  return size ? formatTokens(size) : undefined;
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
      className={`absolute z-20 flex h-[340px] overflow-hidden rounded-card bg-surface shadow-raised ${hasSettings ? "w-[580px]" : "w-[300px]"}`}
      style={{ animation: "pop-in var(--duration-base) var(--ease-enter) backwards", ...style }}
    >
      <ScrollArea data-provider-tabs aria-label="Providers" className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-inset py-2">
        {providers.map((item) => {
          const warning = cliTabLabel(cliStatus?.[item]);
          const on = item === provider;
          // asChild: the tabs stay the rail's direct children. A CLI message, when there is one, is also the tab's description.
          return (
            <Tooltip key={item} label={cliMessage(cliStatus?.[item]) ?? providerName(item)} wrap asChild>
              <button
                type="button"
                aria-label={providerName(item)}
                aria-pressed={on}
                onClick={() => onProviderChange(item)}
                className={`relative flex size-8 shrink-0 items-center justify-center rounded-control transition-colors ${on ? "bg-surface shadow-card" : "hover:bg-hover"}`}
              >
                {/* Selection is ink, like every other picked state. */}
                {on && <span aria-hidden className="absolute top-2 bottom-2 -left-1.5 w-[3px] rounded-r-full bg-ink" />}
                <span className={on ? "" : "opacity-60 grayscale-[0.4]"}>
                  <ProviderLogo provider={item} size={16} />
                </span>
                {warning && <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-orange" />}
              </button>
            </Tooltip>
          );
        })}
      </ScrollArea>

      <div onKeyDown={handleKeyDown} className={`flex min-w-0 flex-col pt-2 pl-2 ${hasSettings ? "w-[240px] shrink-0 border-r border-line" : "flex-1"}`}>
        <div className="flex items-baseline justify-between px-1.5 pr-3 pb-1.5">
          <strong className="text-13 font-semibold text-ink">{providerName(provider)}</strong>
          <span className="text-11 text-ink-3">
            {totalModels} {totalModels === 1 ? "model" : "models"}
          </span>
        </div>
        {/* PickerPanel's search field. */}
        <label className="mr-2 mb-1 flex h-9 shrink-0 items-center gap-2 rounded-control border border-line-strong bg-field px-3 text-ink-3 transition-colors focus-within:border-accent">
          <Icon icon={Search01Icon} size={14} />
          <input
            className="w-full border-0 bg-transparent text-13 text-ink outline-none placeholder:text-ink-3"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search models…"
            autoFocus
          />
        </label>
        {notice}
        <ScrollArea className="grid flex-1 grid-cols-1 content-start gap-px pr-2 pb-2">
          {models.map((model) => (
            <ModelTip key={model.id} description={model.description}>
              <PickerRow
                icon={<ProviderLogo provider={model.provider} size={16} />}
                label={model.name}
                meta={contextLabel(model)}
                selected={model.id === selectedModel.id && model.provider === selectedModel.provider}
                onClick={() => onModelChange(model)}
              />
            </ModelTip>
          ))}
          {models.length === 0 && <EmptyState size="compact" title="No models found" />}
        </ScrollArea>
      </div>

      {hasSettings && (
        <div data-model-settings className="flex min-w-0 flex-1 flex-col gap-3 p-3">
          {levels.length > 0 && current && (
            <div className="flex flex-col">
              <SectionLabel as="span" variant="menu" className="pb-2">
                Thinking effort
              </SectionLabel>
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
                  <div className="flex justify-between pt-1.5 text-11 text-ink-3">
                    <span>{effortCopy(lowest).name}</span>
                    <span>{effortCopy(highest).name}</span>
                  </div>
                </>
              ) : null}
              <p data-effort-caption className="pt-1.5 text-11 text-ink-3">
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
  /** The colour the row takes while on: Fast is orange, Ultracode purple like its Fatality overlay. The icon takes the
   * plain fill (fills are for icons), the title the -ink shade. */
  tone?: "orange" | "purple";
  icon: typeof FlashIcon;
  label: string;
  title: string;
  detail: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  const ink = tone === "purple" ? "text-purple-ink" : "text-orange-ink";
  const fill = tone === "purple" ? "text-purple" : "text-orange";
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`flex w-full items-center gap-2 rounded-control border px-2.5 py-2 text-left transition-colors ${on ? `border-transparent ${tone === "purple" ? "bg-purple-tint" : "bg-orange-tint"}` : "border-line hover:bg-hover"}`}
    >
      <span className={on ? fill : "text-ink-2"}>
        <Icon icon={icon} size={16} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <strong className={`text-12 font-semibold ${on ? ink : "text-ink"}`}>{title}</strong>
        <span className="truncate text-11 text-ink-3">{detail}</span>
      </span>
    </button>
  );
}

/** A model row's description in a tooltip; a row without one is left bare. */
function ModelTip({ description, children }: { description?: string; children: ReactNode }) {
  return description ? (
    <Tooltip label={description} wrap className="w-full">
      {children}
    </Tooltip>
  ) : (
    children
  );
}
