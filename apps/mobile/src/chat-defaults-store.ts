import type { ModelProvider } from "@milagre/shared/model";
import type { TurnPreferences } from "./turn-options";

type Storage = { getItem: (key: string) => string | null; setItemAsync: (key: string, value: string) => Promise<void> };
export type ChatTargetDefaults = { isolation: "local" | "worktree"; baseBranch?: string };
type ModelDefaults = Pick<TurnPreferences, "provider" | "model" | "effort" | "fastMode" | "ultracode">;
const isolationKey = "milagre.chat-isolation.v1";
const modelKey = "milagre.chat-model.v1";
const lastProjectKey = "milagre.chat-last-project.v1";
const originComputersKey = "milagre.chat-origin-computers.v1";
const lastComputerKey = "milagre.chat-last-computer.v1";

function targetKey(scope: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < scope.length; i++) hash = Math.imul(hash ^ scope.charCodeAt(i), 0x01000193) >>> 0;
  return `milagre.chat-target.v1.${hash.toString(16)}`;
}

/** Only explicit new-Chat choices are saved. Linear issues and provider-switch markers never become defaults. */
export function createChatDefaultsStore(storage: Storage) {
  const cache = new Map<string, string>();
  let pending = Promise.resolve();
  function read(key: string) {
    try {
      return JSON.parse(cache.get(key) ?? storage.getItem(key) ?? "null");
    } catch {
      return null;
    }
  }
  function write(key: string, value: object) {
    const raw = JSON.stringify(value);
    cache.set(key, raw);
    pending = pending.then(() => storage.setItemAsync(key, raw)).catch(() => {});
    return pending;
  }
  function readTarget(hostId: string, projectPath: string): ChatTargetDefaults {
    const scope = JSON.stringify([hostId, projectPath]);
    const saved = read(targetKey(scope));
    return {
      isolation: read(isolationKey)?.isolation === "worktree" ? "worktree" : "local",
      ...(saved?.scope === scope && typeof saved.baseBranch === "string" ? { baseBranch: saved.baseBranch } : {}),
    };
  }
  function readLastProject(): { hostId: string; projectPath: string } | null {
    const saved = read(lastProjectKey);
    return saved && typeof saved.hostId === "string" && typeof saved.projectPath === "string" ? { hostId: saved.hostId, projectPath: saved.projectPath } : null;
  }
  function modelDefaults(value: ModelDefaults): ModelDefaults {
    return { provider: value.provider, model: value.model, effort: value.effort, fastMode: !!value.fastMode, ultracode: !!value.ultracode };
  }
  return {
    readTarget,
    saveTarget(hostId: string, projectPath: string, patch: Partial<ChatTargetDefaults>) {
      const scope = JSON.stringify([hostId, projectPath]);
      const previous = readTarget(hostId, projectPath);
      if (patch.isolation) void write(isolationKey, { isolation: patch.isolation });
      return write(targetKey(scope), {
        scope,
        baseBranch: patch.baseBranch ?? previous.baseBranch,
      });
    },
    readModel(): ModelDefaults | null {
      const saved = read(modelKey);
      if (
        !saved ||
        !(["claude", "codex", "antigravity", "kiro"] as ModelProvider[]).includes(saved.provider) ||
        typeof saved.model !== "string" ||
        typeof saved.effort !== "string"
      )
        return null;
      return modelDefaults(saved);
    },
    saveModel(value: ModelDefaults) {
      return write(modelKey, modelDefaults(value));
    },
    /** The Project the last new Chat was started in, which the next New Chat opens in. */
    readLastProject,
    saveLastProject(hostId: string, projectPath: string) {
      return write(lastProjectKey, { hostId, projectPath });
    },
    /**
     * The computer the last new Chat was started on, with or without a Project: where No project starts. A phone from
     * before this was kept has only its last Project's.
     */
    readLastComputer(): string | null {
      const saved = read(lastComputerKey);
      return typeof saved?.hostId === "string" ? saved.hostId : (readLastProject()?.hostId ?? null);
    },
    saveLastComputer(hostId: string) {
      return write(lastComputerKey, { hostId });
    },
    /** The computer a repository's new Chat was last started on, where picking that Project again opens. */
    readOriginComputer(origin: string): string | null {
      const saved = read(originComputersKey);
      return typeof saved?.[origin] === "string" ? saved[origin] : null;
    },
    saveOriginComputer(origin: string, hostId: string) {
      const saved = read(originComputersKey);
      if (saved?.[origin] === hostId) return pending;
      return write(originComputersKey, { ...(saved && typeof saved === "object" ? saved : {}), [origin]: hostId });
    },
  };
}
