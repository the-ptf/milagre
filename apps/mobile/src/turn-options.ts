import { MODEL_CATALOG, capabilityFor, effortFor } from "@milagre/shared/model-options";
import { type AgentModels, type ModelCapability, type ModelOption, type ModelProvider, type PermissionMode } from "@milagre/shared/model";

export type MobileModel = ModelOption & ModelCapability;
export type TurnPreferences = {
  provider: ModelProvider;
  model: string;
  effort: string;
  fastMode: boolean;
  ultracode?: boolean;
  /** The Chat's provider when `provider` was picked as a switch; the pick only holds while the Chat is still on it. */
  pickedOn?: ModelProvider;
  permissionMode: PermissionMode;
  /** A mode picked here, and the Chat's saved mode when it was picked: it shows until the Mac's copy moves on. */
  permissionPick?: { mode: PermissionMode; over?: PermissionMode };
};
export const defaultPreferences: TurnPreferences = { provider: "codex", model: "", effort: "high", fastMode: false, permissionMode: "ask" };

/**
 * A Chat's preferences. Its permission mode is the one the Mac saved on the Chat (the last pick or message, from this
 * phone, desktop or another Chat), so every device shows the same; a pick made here shows until that copy catches up.
 * A Chat from before the Mac saved one shows the mode its turn runs in, then this phone's choice.
 */
export function chatPreferences(
  saved: TurnPreferences | undefined,
  defaults: TurnPreferences,
  chatMode?: PermissionMode,
  runMode?: PermissionMode,
): TurnPreferences {
  const base = saved || defaults;
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
  // Antigravity's and Kiro's availability belongs to the signed-in Account. A stale choice follows that Account's
  // list, as desktop does, instead of becoming an unsupported extra row in the picker.
  const available = models.find((model) => model.recommended) ?? models[0];
  if ((provider === "antigravity" || provider === "kiro") && available) return available;
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

/**
 * Which provider and model the next send uses. A picked provider is an override that only holds while the Chat is still
 * on the provider it was picked against; once the Chat moves (a switch done elsewhere) or the pick is spent, the Chat
 * decides. A Chat with no provider yet (new) follows the saved preferences.
 */
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
/**
 * Preferences after a send: a pick that was carried is spent, so the Chat follows its own provider from here. A send
 * that steered a running turn spends nothing: the turn keeps its provider, so the pick still waits for the next one.
 */
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
/** Preferences after the model sheet's Done: the provider is recorded as a pick only when it differs from the Chat's. */
export function afterSheet(draft: TurnPreferences, chatProvider: ModelProvider | undefined): TurnPreferences {
  const { pickedOn: _old, ...rest } = draft;
  return chatProvider && draft.provider !== chatProvider ? { ...rest, pickedOn: chatProvider } : rest;
}
