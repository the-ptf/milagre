const { PROVIDERS } = require("@milagre/shared/providers");

// What a turn fails with when the provider, not the task, is at fault: the model at capacity or overloaded, a rate or
// usage limit, or the agent's process exiting unexpectedly (events.cjs crashMessage). A Run in a Chat of its own that
// fails this way tries once more on its fallback. "cancelled" and every other failure end the Run as they are.
const PROVIDER_FAILURE =
  /at capacity|try a different model|overloaded|rate[ -]?limit|usage limit|too many requests|quota|\b(429|529)\b|stopped unexpectedly|exited with (code|signal)/i;

/** Whether a failed turn's `error` (and its turn-failed `event`, which carries `limit` when a usage limit stopped it) is the provider's fault. */
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
