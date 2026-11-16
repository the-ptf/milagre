import { PROVIDERS, providerName } from "@milagre/shared/providers";
import type { OrchestratorSettings } from "@milagre/shared/orchestrator";
import type { ModelOption, ModelProvider } from "../../model";
import { modelName } from "../../lib/orchestrator-names";
import { ProviderLogo } from "../ProviderLogo";

export const MODEL_SEPARATOR = "\u0000";

export function modelOptions(models: readonly ModelOption[], keep?: { provider: string | null; model: string | null }) {
  const listed = PROVIDERS.flatMap((provider) =>
    models
      .filter((model) => model.provider === provider)
      .map((model) => ({
        value: `${provider}${MODEL_SEPARATOR}${model.id}`,
        label: model.name,
        icon: <ProviderLogo provider={provider} size={14} />,
        group: providerName(provider),
      })),
  );
  if (!keep?.provider || !keep.model || models.some((model) => model.provider === keep.provider && model.id === keep.model)) return listed;
  const provider = keep.provider as ModelProvider;
  return [
    ...listed,
    {
      value: `${provider}${MODEL_SEPARATOR}${keep.model}`,
      label: modelName(keep.model),
      icon: <ProviderLogo provider={provider} size={14} />,
      group: providerName(provider),
    },
  ];
}

export function splitModel(value: string) {
  const [provider, model] = value.split(MODEL_SEPARATOR);
  return { provider: provider as OrchestratorSettings["router"]["provider"], model: model ?? "" };
}
