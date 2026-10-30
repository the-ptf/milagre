const { CodexRpc } = require("./codex-rpc.cjs");
const { hasToken } = require("./antigravity-install.cjs");
const { queryAntigravityModels } = require("./antigravity-model-list.cjs");
const { listKiroModels } = require("./kiro-model-list.cjs");
const { ANTIGRAVITY_AGENT_OPTIONS, ANTIGRAVITY_FAMILY_COPY, antigravityFamilies } = require("@milagre/shared/antigravity-models");

// The models each agent offers, asked from its CLI once per app run: Claude's supportedModels(), Codex's
// model/list and Kiro's `model` option (kiro-model-list.cjs, which adds each model's `credits`). A model is { id, name, description, recommended, efforts, defaultEffort?, ultracode, fastMode },
// where `efforts` are the levels it accepts, lightest first (none when it has no effort control) and `fastMode`
// says whether it has a faster, costlier tier: Claude Code's fast mode, or Codex's "priority" service tier.

// "claude-haiku-4-5-20251001" and "claude-opus-5-5[1m]" are the picker's "claude-haiku-4-5" and "claude-opus-5-5".
const plainId = (id) =>
  String(id ?? "")
    .replace(/\[.*\]$/, "")
    .replace(/-\d{8}$/, "");
// Codex ends its descriptions with a period; Claude's and the picker's have none.
const sentence = (text) =>
  String(text ?? "")
    .trim()
    .replace(/\.$/, "");

// Claude reports no ultracode flag. Ultracode needs a model with the full effort range, so
// models that offer xhigh are treated as ultracode-capable. supportsFastMode comes only on the
// models that have it (Opus 5.5, Opus 5 and Opus 4.8 as of Claude Code 2.1.288).
function claudeCapability(info) {
  const efforts = info.supportsEffort ? (info.supportedEffortLevels ?? []) : [];
  return { efforts, ultracode: efforts.includes("xhigh"), fastMode: info.supportsFastMode === true };
}

// supportedModels() lists aliases first (default, opus, fable, sonnet, haiku), each resolving to a model,
// then older models by id. The picker lists models by id, so a chat keeps its model when an alias moves
// on to a newer one; "default" only says which model Claude Code recommends.
function claudeModels(infos) {
  const recommended = plainId(infos.find((info) => info.value === "default")?.resolvedModel);
  const models = new Map();
  for (const info of infos) {
    const id = plainId(String(info.value).startsWith("claude-") ? info.value : info.resolvedModel);
    if (info.value === "default" || !id.startsWith("claude-") || models.has(id)) continue;
    models.set(id, { id, name: info.displayName || id, description: sentence(info.description), recommended: id === recommended, ...claudeCapability(info) });
  }
  return [...models.values()];
}

// Codex's fast mode is the "priority" service tier, listed per model (turn/start's serviceTierForTurn).
const CODEX_FAST_TIER = "priority";

// model/list leaves hidden models out unless asked for them; any that come anyway are dropped.
function codexModels(entries) {
  return entries
    .filter((model) => model?.id && model.hidden !== true)
    .map((model) => ({
      id: model.id,
      name: model.displayName || model.id,
      description: sentence(model.description),
      recommended: model.isDefault === true,
      efforts: (model.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort ?? option),
      ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
      ultracode: false,
      fastMode: (model.serviceTiers ?? []).some((tier) => tier?.id === CODEX_FAST_TIER),
    }));
}

async function listClaudeModels({ command, env, loadSdk = () => import("@anthropic-ai/claude-agent-sdk") }) {
  const { query } = await loadSdk();
  const idle = {
    // oxlint-disable-next-line require-yield -- async generator stub that throws or never settles on purpose to simulate a failing or idle stream
    async *[Symbol.asyncIterator]() {
      await new Promise(() => {});
    },
  };
  const session = query({ prompt: idle, options: { pathToClaudeCodeExecutable: command, ...(env ? { env } : {}) } });
  try {
    return claudeModels(await session.supportedModels());
  } finally {
    session.close?.();
  }
}

async function listCodexModels({ command, cwd, env, clientVersion = "0.0.0", createRpc = (options) => new CodexRpc(options) }) {
  const rpc = createRpc({ command, cwd, ...(env ? { env } : {}) });
  rpc.start();
  try {
    await rpc.request("initialize", { clientInfo: { name: "milagre", title: "Milagre", version: clientVersion }, capabilities: null });
    rpc.notify("initialized");
    const entries = [];
    let cursor = null;
    do {
      const page = await rpc.request("model/list", cursor ? { cursor } : {});
      entries.push(...(page.data ?? []));
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return codexModels(entries);
  } finally {
    rpc.close();
  }
}

// Antigravity's models come from session/new (configOptions). Discovery opens an empty session before the first
// Chat, and SessionManager records later changes. Both are partitioned by account, including concurrent lookups.
const reportedAntigravity = new Map();
const pendingAntigravity = new Map();
const antigravityKey = (accountId) => accountId ?? "default";

/** Records the models an Antigravity session offered ([{ value, name, description }]) and its current one, for its account. */
function recordAntigravityModels(accountId, offered, current) {
  if (Array.isArray(offered) && offered.length) reportedAntigravity.set(antigravityKey(accountId), { offered, current: current ?? null });
}

function forgetAntigravityModels(accountId) {
  if (accountId === undefined) {
    reportedAntigravity.clear();
    pendingAntigravity.clear();
  } else {
    reportedAntigravity.delete(antigravityKey(accountId));
    pendingAntigravity.delete(antigravityKey(accountId));
  }
}

// The agent reports one model per thinking level; they are grouped into families whose levels are the efforts
// (antigravityFamilies). Its descriptions are only its ids, so the catalog's wording is shown per family; a model
// without levels keeps a description of its own.
function antigravityModels(offered, current) {
  const valid = Array.isArray(offered) ? offered.filter((model) => typeof model?.value === "string" && model.value) : [];
  return antigravityFamilies(valid.length ? valid : ANTIGRAVITY_AGENT_OPTIONS, current).map((family) => {
    const copy = ANTIGRAVITY_FAMILY_COPY[family.id];
    const own = family.efforts.length ? "" : String(family.options[0]?.description ?? "").trim();
    return {
      id: family.id,
      name: family.name,
      description: sentence(copy?.description ?? (own && own !== family.options[0]?.value ? own : "")),
      recommended: copy?.recommended === true,
      efforts: family.efforts,
      ...(family.defaultEffort ? { defaultEffort: family.defaultEffort } : {}),
      ultracode: false,
      fastMode: false,
    };
  });
}

/** Discover once per signed-in account; a Chat's latest report wins. Failed lookups retry on the next read. */
async function listAntigravityModels({ accountId, command, args, harness, env, clientVersion, discover = queryAntigravityModels } = {}) {
  const key = antigravityKey(accountId);
  if (!reportedAntigravity.has(key) && command && env?.GEMINI_HOME && hasToken(env.GEMINI_HOME)) {
    if (!pendingAntigravity.has(key)) {
      const pending = Promise.resolve()
        .then(() => discover({ accountId, command, args, harness, env, clientVersion }))
        .then((result) => {
          // An invalidation or a Chat's newer report must survive an older probe finishing.
          if (pendingAntigravity.get(key) === pending && !reportedAntigravity.has(key))
            return recordAntigravityModels(accountId, result?.offered, result?.current);
          return undefined;
        })
        .catch(() => {})
        .finally(() => {
          if (pendingAntigravity.get(key) === pending) pendingAntigravity.delete(key);
        });
      pendingAntigravity.set(key, pending);
    }
    await pendingAntigravity.get(key);
  }
  const reported = reportedAntigravity.get(key);
  return antigravityModels(reported?.offered, reported?.current);
}

/**
 * Asks each agent's CLI once per run. An agent whose CLI has a problem (missing, too old) or whose lookup
 * fails or comes back empty reports null, and is asked again on the next call. Antigravity discovers per account
 * and uses its last session report or the catalog when unavailable, so it is always present.
 */
function createModelCache({
  cli,
  cwd,
  clientVersion,
  list = { claude: listClaudeModels, codex: listCodexModels, antigravity: listAntigravityModels, kiro: listKiroModels },
}) {
  const cache = new Map();
  function lookup(provider) {
    if (!cache.has(provider)) {
      const pending = cli(provider)
        .then((status) =>
          status.problem || !status.command
            ? null
            : list[provider]({ command: status.command, cwd, clientVersion, ...(status.env ? { env: status.env } : {}) }),
        )
        .catch(() => null)
        .then((models) => {
          if (models?.length) return models;
          cache.delete(provider);
          return null;
        });
      cache.set(provider, pending);
    }
    return cache.get(provider);
  }
  const antigravity = async () => {
    const status = await cli("antigravity").catch(() => null);
    return (list.antigravity ?? listAntigravityModels)({
      accountId: status?.accountId,
      ...(!status?.problem && status?.command ? { command: status.command, args: status.args, harness: status.harness, env: status.env, clientVersion } : {}),
    });
  };
  const read = async () => {
    const [claude, codex, antigravityList, kiro] = await Promise.all([lookup("claude"), lookup("codex"), antigravity(), list.kiro ? lookup("kiro") : null]);
    return { claude, codex, antigravity: antigravityList, kiro };
  };
  read.invalidate = (provider) => {
    cache.delete(provider);
    if (provider === "antigravity") forgetAntigravityModels();
  };
  return read;
}

module.exports = {
  CODEX_FAST_TIER,
  claudeCapability,
  claudeModels,
  codexModels,
  createModelCache,
  forgetAntigravityModels,
  antigravityModels,
  listClaudeModels,
  listCodexModels,
  listAntigravityModels,
  recordAntigravityModels,
};
