import { useMemo, type RefObject } from "react";
import { projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { runChoices } from "@milagre/shared/model-options";
import { modelForOpenChat } from "@/lib/agent-runs";
import { readComposerPreferences } from "@/lib/composer-preferences";
import { providerForId, resolveModel } from "@/lib/models";
import { preferenceStorage as localStorage } from "@/lib/preference-storage";
import { getSettings } from "@/lib/settings";
import { useEvent } from "@/lib/stable";
import type { EffortLevel, ModelCapabilities, ModelOption } from "@/model";
import type { useAgentRuns } from "../useAgentRuns";
import type { CanvasChatActions, CanvasSend } from "./CanvasChat";

/**
 * What a Chat open as a window on the canvas does, while Chats on the canvas is on: it sends with the choices its own
 * composer would make, without opening it. Off, none: a click on a Chat opens the full Chat.
 */
export function useCanvasChatActions(
  agentRuns: ReturnType<typeof useAgentRuns>,
  models: ModelOption[],
  capabilities: ModelCapabilities | null,
  chatModels: RefObject<Record<string, string>>,
  enabled: boolean,
): CanvasChatActions | undefined {
  const send = useEvent(async (request: CanvasSend) => {
    const settings = getSettings();
    const prefs = readComposerPreferences(localStorage)[request.key] ?? {};
    const fallback = resolveModel(models, settings.defaultModelId, providerForId(settings.defaultModelId));
    const model = modelForOpenChat(prefs.modelId ?? chatModels.current[request.key] ?? request.lastModel, request.provider, [], models, fallback);
    const picks = {
      permissionMode: prefs.permissionMode ?? agentRuns.store.shown()[request.key]?.permissionMode ?? request.permissionMode ?? settings.defaultPermissionMode,
      effort: prefs.effort ?? (localStorage.getItem("milagre.effort") as EffortLevel | null) ?? "high",
      ultracode: prefs.ultracode ?? localStorage.getItem("milagre.ultracode") === "on",
      fastMode: prefs.fastMode ?? localStorage.getItem("milagre.fastMode") === "on",
    };
    await agentRuns.send({
      projectPath: projectOfKey(request.key),
      sessionId: sessionIdFromKey(request.key),
      worktreeId: request.worktreeId,
      clientMessageId: crypto.randomUUID(),
      ...(request.delivery ? { delivery: request.delivery } : {}),
      body: request.body,
      images: [],
      files: [],
      prompt: request.body,
      ...runChoices(model, capabilities, picks, settings),
    });
  });
  const { respond, answerQuestion, interrupt } = agentRuns;
  return useMemo<CanvasChatActions | undefined>(
    () =>
      enabled
        ? { models, send, respond, answerQuestion: (key, requestId, answers, images) => answerQuestion(key, requestId, answers, images), interrupt }
        : undefined,
    [enabled, models, send, respond, answerQuestion, interrupt],
  );
}
