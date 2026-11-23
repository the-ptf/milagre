import { modelMatches } from "../../lib/model-options";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { PROVIDERS } from "@milagre/shared/providers";
import type { OrchestratorRole } from "@milagre/shared/orchestrator";
import { capabilityFor, effortCopy, type EffortLevel, type ModelCapability, type ModelOption, type ModelProvider } from "../../model";
import { modelName } from "../../lib/orchestrator-names";
import { useDismiss } from "../../lib/use-dismiss";
import { ModelPicker } from "../ModelPicker";
import { ProviderLogo } from "../ProviderLogo";
import { IconButton } from "../primitives/Button";
import { layerHost } from "../primitives/Tooltip";

const EDGE = 8;
const GAP = 6;
const HEIGHT = 380;
const NO_SETTINGS: ModelCapability = { efforts: [], ultracode: false, fastMode: false };

type Route = Pick<OrchestratorRole, "provider" | "model" | "effort">;

function roleModel(role: OrchestratorRole, models: ModelOption[]): ModelOption | null {
  if (!role.provider || !role.model) return null;
  return (
    models.find((entry) => entry.provider === role.provider && entry.id === role.model) ?? {
      id: role.model,
      name: modelName(role.model),
      provider: role.provider,
      description: "",
    }
  );
}

const widthFor = (capability: Pick<ModelCapability, "efforts">) => (capability.efforts.length > 0 ? 580 : 300);

function place(trigger: HTMLElement, width: number): CSSProperties {
  const box = trigger.getBoundingClientRect();
  const left = Math.max(EDGE, Math.min(box.right - width, window.innerWidth - width - EDGE));
  const below = window.innerHeight - box.bottom - GAP - EDGE;
  return below >= HEIGHT || below >= box.top
    ? { position: "fixed", left, top: box.bottom + GAP, maxHeight: below, transformOrigin: "top right" }
    : { position: "fixed", left, bottom: window.innerHeight - box.top + GAP, maxHeight: box.top - GAP - EDGE, transformOrigin: "bottom right" };
}

export function RoleModelPicker({ role, models, onChange }: { role: OrchestratorRole; models: ModelOption[]; onChange: (route: Route) => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [host, setHost] = useState<Element | null>(null);
  const open = host !== null;
  const [query, setQuery] = useState("");
  const [style, setStyle] = useState<CSSProperties>({});
  const model = roleModel(role, models);
  const providers = PROVIDERS.filter((provider) => provider === role.provider || models.some((entry) => entry.provider === provider));
  const [provider, setProvider] = useState<ModelProvider>(role.provider ?? providers[0] ?? "claude");
  const capability = model ? { ...capabilityFor(model, null), ultracode: false, fastMode: false } : NO_SETTINGS;
  const width = widthFor(capability);
  const effort = role.effort && capability.efforts.includes(role.effort) ? role.effort : undefined;
  const rows = models.filter((entry) => entry.provider === provider && modelMatches(entry, query));
  const follow = (to = width) => trigger.current && setStyle(place(trigger.current, to));
  const close = () => setHost(null);

  useDismiss(
    open,
    close,
    (target) => !!target.closest("[data-picker-panel]") || !!trigger.current?.contains(target),
    () => follow(),
  );
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setHost(null);
      trigger.current?.focus();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [open]);
  const pick = (next: ModelOption) => {
    const levels = capabilityFor(next, null).efforts;
    setProvider(next.provider);
    follow(widthFor({ efforts: levels }));
    onChange({
      provider: next.provider,
      model: next.id,
      effort: role.effort && levels.includes(role.effort as EffortLevel) ? role.effort : (levels.at(-2) ?? levels[0] ?? null),
    });
  };

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-label={`Model for ${role.name}`}
        data-role-model={role.id}
        onClick={(event) => {
          if (open) return close();
          setProvider(role.provider ?? providers[0] ?? "claude");
          setQuery("");
          setStyle(place(event.currentTarget, width));
          setHost(layerHost(event.currentTarget));
        }}
        className="flex h-7 min-w-0 items-center gap-1 rounded-control px-1.5 text-12 font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
      >
        {model && <ProviderLogo provider={model.provider} size={14} optical />}
        <span className="max-w-40 min-w-0 truncate">{model ? model.name : "Not set"}</span>
        {model && effort && (
          <span className="flex shrink-0 items-center gap-1">
            <span className="text-ink-3">·</span>
            {effortCopy(effort).name}
          </span>
        )}
      </button>
      {model && (
        <IconButton size={24} label={`Turn off ${role.name}`} icon={Cancel01Icon} onClick={() => onChange({ provider: null, model: null, effort: null })} />
      )}
      {host &&
        createPortal(
          <ModelPicker
            style={style}
            providers={providers}
            provider={provider}
            onProviderChange={setProvider}
            models={rows}
            query={query}
            onQueryChange={setQuery}
            cliStatus={null}
            selectedModel={model ?? { id: "", name: "Not set", provider, description: "" }}
            onModelChange={pick}
            capability={capability}
            effort={effort}
            onEffortChange={(level) => onChange({ provider: role.provider, model: role.model, effort: level })}
          />,
          host,
        )}
    </span>
  );
}
