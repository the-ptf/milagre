import { MODEL_CATALOG } from "../model.ts";
import { PROVIDERS } from "@milagre/shared/providers";
import type { AgentModels, ModelCapabilities, ModelOption, ModelProvider } from "../model";

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

export function providerForId(id: string | undefined): ModelProvider {
  if (id?.startsWith("kiro:")) return "kiro";
  if (id?.startsWith("gemini") || id?.startsWith("antigravity:")) return "antigravity";
  return id?.startsWith("claude") ? "claude" : "codex";
}

export function keepIfSame<T>(previous: T, next: T): T {
  return JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

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
