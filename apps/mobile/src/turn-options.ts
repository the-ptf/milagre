import { MODEL_CATALOG, capabilityFor, effortFor } from "@milagre/shared/model-options";
import { type AgentModels, type ModelCapability, type ModelOption, type ModelProvider, type PermissionMode } from "@milagre/shared/model";

export type MobileModel = ModelOption & ModelCapability;
export type TurnPreferences = {
  provider: ModelProvider;
  model: string;
  effort: string;
  fastMode: boolean;
  ultracode?: boolean;
  pickedOn?: ModelProvider;
  permissionMode: PermissionMode;
  permissionPick?: { mode: PermissionMode; over?: PermissionMode };
};
export const defaultPreferences: TurnPreferences = { provider: "codex", model: "", effort: "high", fastMode: false, permissionMode: "ask" };

export function chatPreferences(
  saved: TurnPreferences | undefined,
  defaults: TurnPreferences,
  chatMode?: PermissionMode,
  runMode?: PermissionMode,
  startedWith?: string | null,
): TurnPreferences {
  const base = saved || (startedWith ? { ...defaults, effort: startedWith } : defaults);
  const pick = saved?.permissionPick;
  const permissionMode = pick && pick.over === chatMode ? pick.mode : (chatMode ?? runMode ?? base.permissionMode);
  return permissionMode === base.permissionMode ? base : { ...base, permissionMode };
}

export function modelsFor(provider: ModelProvider, reported?: AgentModels | null): MobileModel[] {
  const offered = reported?.[provider];
  return offered?.length
    ? offered.map((model) => ({ ...model, provider })).sort((a, b) => Number(b.recommended) - Number(a.recommended))
    : MODEL_CATALOG.filter((model) => model.provider === provider).map((model) => ({ ...model, ...capabilityFor(model, null) }));
}
export function selectedModel(provider: ModelProvider, wanted: string, reported?: AgentModels | null): MobileModel {
  const models = modelsFor(provider, reported);
  if (!wanted) {
    const preferred = models.find((model) => model.recommended) ?? models[0];
    if (preferred) return preferred;
  }
  const known = models.find((model) => model.id === wanted);
  if (known) return known;
  const available = models.find((model) => model.recommended) ?? models[0];
  if ((provider === "antigravity" || provider === "kiro" || provider === "ollama") && available) return available;
  const saved = { provider, id: wanted, name: wanted, description: "Previously used in this Chat" };
  return { ...saved, ...capabilityFor(saved, null) };
}
export function sendOptions(model: MobileModel, preferences: Pick<TurnPreferences, "effort" | "fastMode" | "ultracode" | "permissionMode">) {
  const effort = effortFor(model, preferences.effort);
  return {
    provider: model.provider,
    model: model.id,
    ...(effort ? { effort } : {}),
    fastMode: model.fastMode && preferences.fastMode,
    ...(model.ultracode && preferences.ultracode ? { ultracode: true } : {}),
    permissionMode: preferences.permissionMode,
  };
}

export function turnTarget(
  saved: TurnPreferences | undefined,
  chatProvider: ModelProvider | undefined,
  defaults: Pick<TurnPreferences, "provider"> & Partial<Pick<TurnPreferences, "model">>,
): { provider: ModelProvider; model: string; picked: boolean } {
  if (!chatProvider) return { provider: saved?.provider ?? defaults.provider, model: saved?.model ?? defaults.model ?? "", picked: false };
  const picked = !!saved && saved.pickedOn === chatProvider && saved.provider !== chatProvider;
  const provider = picked ? saved.provider : chatProvider;
  return { provider, model: saved && saved.provider === provider ? saved.model : "", picked };
}
export function afterSend(
  saved: TurnPreferences,
  target: { provider: ModelProvider; picked: boolean },
  chatProvider: ModelProvider | undefined,
  model: string,
  steered: boolean,
): TurnPreferences {
  if (steered && target.picked) return saved;
  const { pickedOn: _spent, ...rest } = saved;
  if (target.picked && chatProvider) return { ...rest, provider: chatProvider, model: "" };
  return { ...rest, provider: target.provider, model };
}
export function afterSheet(draft: TurnPreferences, chatProvider: ModelProvider | undefined): TurnPreferences {
  const { pickedOn: _old, ...rest } = draft;
  return chatProvider && draft.provider !== chatProvider ? { ...rest, pickedOn: chatProvider } : rest;
}
