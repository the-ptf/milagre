const { PROVIDERS } = require("@milagre/shared/providers");

const PROVIDER_FAILURE =
  /at capacity|try a different model|overloaded|rate[ -]?limit|usage limit|too many requests|quota|\b(429|529)\b|stopped unexpectedly|exited with (code|signal)/i;

const providerFailure = (error, event) => Boolean(event?.limit) || (typeof error === "string" && PROVIDER_FAILURE.test(error));

/**
 * The model a Run retries on when its Routine names no fallback: the recommended model (the one a new Chat picks) of the
 * first provider in picker order (Codex, Claude, Antigravity, Kiro) that isn't `failed` and is installed, signed in and
 * reports its models. A Run that failed on Codex retries on Claude, and one on any other provider on Codex. `status` and
 * `models` are agent:cli-status and agent:models. Null when no other provider is ready.
 */
function defaultFallback(failed, status, models) {
  const from = failed ?? "claude";
  for (const provider of PROVIDERS) {
    if (provider === from || status?.[provider]?.state !== "ready") continue;
    const list = models?.[provider];
    if (!Array.isArray(list) || list.length === 0) continue;
    const model = list.find((item) => item.recommended) ?? list[0];
    return { provider, model: model.id };
  }
  return null;
}

module.exports = { defaultFallback, providerFailure };
