import { MODEL_CATALOG } from "../model.ts";
import { PROVIDERS } from "@milagre/shared/providers";
import type { AgentModels, ModelCapabilities, ModelOption, ModelProvider } from "../model";

/**
 * The models the picker offers: each agent's own list, its recommended model first, or the maintained
 * list for an agent that hasn't reported one (still loading, CLI missing or too old, lookup failed).
 */
export function mergeModels(reported: AgentModels | null, fallback: ModelOption[]): ModelOption[] {
  return PROVIDERS.flatMap((provider) => {
    const list = reported?.[provider];
    if (!list?.length) return fallback.filter((model) => model.provider === provider);
    const options: ModelOption[] = list.map(({ id, name, description, recommended, credits }) => ({
      id,
      name,
      provider,
      description,
      ...(recommended ? { recommended: true } : {}),
      ...(credits ? { credits } : {}),
    }));
    return [...options.filter((model) => model.recommended), ...options.filter((model) => !model.recommended)];
  });
}

/** What each reported model accepts, by provider and model id (see capabilityFor). */
export function capabilitiesFrom(reported: AgentModels | null): ModelCapabilities | null {
  if (!reported) return null;
  const byId = (provider: ModelProvider) =>
    Object.fromEntries(
      (reported[provider] ?? []).map(({ id, efforts, defaultEffort, ultracode, fastMode }) => [
        id,
        { efforts, ...(defaultEffort ? { defaultEffort } : {}), ultracode, fastMode },
      ]),
    );
  return { codex: byId("codex"), claude: byId("claude"), antigravity: byId("antigravity"), kiro: byId("kiro") };
}

/** `wanted` when the list has it; otherwise the recommended model of `provider`, any model of it, or the first model. */
export function resolveModel(models: ModelOption[], wanted: string | undefined, provider: ModelProvider): ModelOption {
  return (
    models.find((model) => model.id === wanted) ??
    models.find((model) => model.provider === provider && model.recommended) ??
    models.find((model) => model.provider === provider) ??
    models[0] ??
    MODEL_CATALOG.find((model) => model.provider === provider && model.recommended) ??
    MODEL_CATALOG.find((model) => model.provider === provider) ??
    MODEL_CATALOG[0]
  );
}

/** The provider of an id no list offers any more. Antigravity partner families and every Kiro model carry a provider prefix. */
export function providerForId(id: string | undefined): ModelProvider {
  if (id?.startsWith("kiro:")) return "kiro";
  if (id?.startsWith("gemini") || id?.startsWith("antigravity:")) return "antigravity";
  return id?.startsWith("claude") ? "claude" : "codex";
}

/** The same lists (by value), so a refetch that changed nothing doesn't re-render the app. */
export function keepIfSame<T>(previous: T, next: T): T {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

/**
 * The model the composer shows once `models` changed (lists arrived or were fetched again).
 * - `applyDefault` is true once: when the agents' lists first arrive and the user hasn't picked a model. The
 *   Settings default then replaces the model the app started with, unless the open chat is on the other
 *   provider, which it starts on instead. `preferredProvider` only seeds that first selection: a chat can switch
 *   provider, so a later change of lists never moves the user's pick back to the chat's provider.
 * - Every other time the current model stays, or gives way to its provider's recommended model when the lists
 *   no longer offer it.
 * Returns `current` itself when nothing changed, so the composer doesn't re-render.
 */
export function nextSelection(
  models: ModelOption[],
  current: ModelOption,
  { defaultId, applyDefault, preferredProvider }: { defaultId: string; applyDefault: boolean; preferredProvider?: ModelProvider },
): ModelOption {
  if (models.length === 0) return current;
  const useDefault =
    applyDefault &&
    (preferredProvider === undefined ||
      providerForId(defaultId) === preferredProvider ||
      models.find((model) => model.id === defaultId)?.provider === preferredProvider);
  const wanted = useDefault ? defaultId : current.id;
  const provider = useDefault
    ? (models.find((model) => model.id === wanted)?.provider ?? providerForId(wanted))
    : ((applyDefault ? preferredProvider : undefined) ?? current.provider);
  const next = resolveModel(models, wanted, provider);
  return next.id === current.id && next.name === current.name && next.provider === current.provider ? current : next;
}
