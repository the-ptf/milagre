import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { cliName } from "@milagre/shared/providers";
import { chatKey } from "../lib/agent-runs";
import { requiredCliVersion } from "../lib/cli-status";
import { bridgeForKey } from "../lib/computer-bridge";
import { capabilitiesFrom, keepIfSame, mergeModels, nextSelection, providerForId, resolveModel } from "../lib/models";
import { getSettings, updateSettings } from "../lib/settings";
import { MODEL_CATALOG, capabilityFor, type AgentCliStatus, type AgentModels, type ModelOption, type ModelProvider } from "../model";

const PROVIDERS_FRESH_MS = 60_000;
const CHAT_MODELS_KEY = "milagre.chatModels";

function readChatModels(): Record<string, string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(CHAT_MODELS_KEY) ?? "{}");
    return saved && typeof saved === "object" ? (saved as Record<string, string>) : {};
  } catch {
    return {};
  }
}

type ProviderEntry = { reported: AgentModels | null; cliStatus: AgentCliStatus | null; reportedAt?: number; cliStatusAt?: number };

/**
 * The agents' own model lists and CLI status for a Project or Link, with the maintained list standing in until they
 * arrive. Each scope's last read is cached with its time: switching back shows it at once and reads again only once
 * it is older than PROVIDERS_FRESH_MS. A refetch that changed nothing keeps the old objects, so opening the picker
 * doesn't re-render the app.
 */
function useProviderLists(accountScope: string | undefined) {
  const accountScopeRef = useRef(accountScope);
  accountScopeRef.current = accountScope;
  const accountGeneration = useRef(0);
  const [loadedAccountScope, setLoadedAccountScope] = useState<string | undefined>(undefined);
  const [rawReported, setReported] = useState<AgentModels | null>(null);
  const reported = loadedAccountScope === accountScope ? rawReported : null;
  const [rawCliStatus, setCliStatus] = useState<AgentCliStatus | null>(null);
  const cliStatus = loadedAccountScope === accountScope ? rawCliStatus : null;
  const providerCache = useRef(new Map<string, ProviderEntry>());
  const remember = (patch: Partial<ProviderEntry>) => {
    if (accountScope) providerCache.current.set(accountScope, { reported: null, cliStatus: null, ...providerCache.current.get(accountScope), ...patch });
  };
  const refreshCliStatus = () => {
    const generation = ++accountGeneration.current;
    const live = () => generation === accountGeneration.current && accountScopeRef.current === accountScope;
    void bridgeForKey(accountScope)
      .getCliStatus(accountScope)
      .then((next) => {
        if (!live()) return;
        setLoadedAccountScope(accountScope);
        setCliStatus((previous) => keepIfSame(previous, next));
        remember({ cliStatus: next, cliStatusAt: Date.now() });
      })
      .catch(() => undefined);
    void bridgeForKey(accountScope)
      .getModels(accountScope)
      .then((next) => {
        if (!live()) return;
        setLoadedAccountScope(accountScope);
        setReported((previous) => keepIfSame(previous, next));
        remember({ reported: next, reportedAt: Date.now() });
      })
      .catch(() => undefined);
  };
  const staleProviders = () => {
    for (const [scope, entry] of providerCache.current) providerCache.current.set(scope, { reported: entry.reported, cliStatus: entry.cliStatus });
  };
  useEffect(() => {
    const reset = (dropCache: boolean) => {
      if (dropCache) providerCache.current.clear();
      const hit = accountScope ? providerCache.current.get(accountScope) : undefined;
      setReported(hit?.reported ?? null);
      setCliStatus(hit?.cliStatus ?? null);
      if (hit) setLoadedAccountScope(accountScope);
      const fresh = (at: number | undefined) => at !== undefined && Date.now() - at < PROVIDERS_FRESH_MS;
      if (!hit || !fresh(hit.reportedAt) || !fresh(hit.cliStatusAt)) refreshCliStatus();
    };
    reset(false);
    const off = window.milagre.onAccountsChanged?.(() => reset(true));
    return () => {
      accountGeneration.current++;
      off?.();
    };
  }, [accountScope]);
  return { reported, cliStatus, refreshCliStatus, staleProviders };
}

function useCliUpdate(cliStatus: AgentCliStatus | null, refreshCliStatus: () => void, staleProviders: () => void, setNotice: (notice: string) => void) {
  const [updatingCli, setUpdatingCli] = useState<ModelProvider | null>(null);
  const refreshCliStatusRef = useRef(refreshCliStatus);
  refreshCliStatusRef.current = refreshCliStatus;
  const staleProvidersRef = useRef(staleProviders);
  staleProvidersRef.current = staleProviders;
  const updateCli = async (provider: ModelProvider) => {
    setUpdatingCli(provider);
    try {
      const result = await window.milagre.updateCli(provider, requiredCliVersion(cliStatus?.[provider]));
      staleProviders();
      refreshCliStatusRef.current();
      if (result.ok) {
        setNotice(`${cliName(provider)} updated to version ${result.version ?? "latest"} successfully!`);
      } else {
        setNotice(result.error ?? `Failed to update ${cliName(provider)}.`);
      }
    } catch (error) {
      setNotice(`Error updating ${cliName(provider)}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setUpdatingCli(null);
    }
  };
  const updateCliRef = useRef(updateCli);
  updateCliRef.current = updateCli;
  const handleUpdateCli = useCallback((provider: ModelProvider) => updateCliRef.current(provider), []);
  const handleProvidersUpdated = useCallback(() => {
    staleProvidersRef.current();
    refreshCliStatusRef.current();
  }, []);
  return { updatingCli, handleUpdateCli, handleProvidersUpdated };
}

/**
 * The model picker's selection. The Settings default applies once, when the agents' lists first arrive, if the user
 * hasn't picked a model and the open chat isn't on another agent (`preferredProviderRef`); after that a model the agents
 * don't offer only gives way to its provider's recommended model. A pick in an open chat stays with that chat (a Link's
 * composer names its chat); on a new-chat screen it becomes the default. Updating a CLI is global: the open scope reads
 * its lists again at once, the others when next shown.
 */
export function useModelSelection({
  accountScope,
  selectedSessionRef,
  selectedLinkRef,
  projectRef,
  setNotice,
}: {
  accountScope: string | undefined;
  selectedSessionRef: RefObject<number | null>;
  selectedLinkRef: RefObject<unknown>;
  projectRef: RefObject<{ path: string } | null>;
  setNotice: (notice: string) => void;
}) {
  const [selectedModel, setSelectedModel] = useState<ModelOption>(() =>
    resolveModel(MODEL_CATALOG, getSettings().defaultModelId, providerForId(getSettings().defaultModelId)),
  );
  const { reported, cliStatus, refreshCliStatus, staleProviders } = useProviderLists(accountScope);
  const models = useMemo(() => mergeModels(reported, MODEL_CATALOG), [reported]);
  const capabilities = useMemo(() => capabilitiesFrom(reported), [reported]);
  const pickedModel = useRef(false);
  const appliedDefault = useRef(false);
  const preferredProviderRef = useRef<ModelProvider | undefined>(undefined);
  useEffect(() => {
    const applyDefault = reported !== null && !appliedDefault.current && !pickedModel.current;
    if (reported !== null) appliedDefault.current = true;
    setSelectedModel((current) =>
      nextSelection(models, current, { defaultId: getSettings().defaultModelId, applyDefault, preferredProvider: preferredProviderRef.current }),
    );
  }, [models]);
  const chatModels = useRef<Record<string, string>>(readChatModels());
  const chooseModel = (model: ModelOption, linkChat?: string | null) => {
    pickedModel.current = true;
    setSelectedModel(model);
    const sessionId = selectedSessionRef.current;
    const chat = selectedLinkRef.current ? linkChat : sessionId !== null && projectRef.current ? chatKey(projectRef.current.path, sessionId) : null;
    if (!chat) {
      updateSettings({ defaultModelId: model.id });
      return;
    }
    chatModels.current = { ...chatModels.current, [chat]: model.id };
    localStorage.setItem(CHAT_MODELS_KEY, JSON.stringify(chatModels.current));
  };
  const cli = useCliUpdate(cliStatus, refreshCliStatus, staleProviders, setNotice);
  return {
    selectedModel,
    setSelectedModel,
    models,
    capabilities,
    selectedCapability: capabilityFor(selectedModel, capabilities),
    cliStatus,
    refreshCliStatus,
    staleProviders,
    preferredProviderRef,
    chatModels,
    chooseModel,
    ...cli,
  };
}
