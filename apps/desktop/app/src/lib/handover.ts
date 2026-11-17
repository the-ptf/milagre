import { providerName } from "@milagre/shared/providers";
import type { HandoffContext, ModelOption } from "../model";

export function handoffLabel(context: HandoffContext, models: ModelOption[]): { from: string; to: string; restored: boolean } {
  const side = ({ provider, model }: HandoffContext["from"]) => models.find((item) => item.id === model)?.name ?? providerName(provider);
  return { from: side(context.from), to: side(context.to), restored: context.from.provider === context.to.provider };
}
