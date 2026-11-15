import { ipcErrorMessage } from "./result.mjs";

export const SEND_RETRY_DELAYS = Object.freeze([1000, 2000, 4000, 8000, 15000, 30000]);
export const SEND_RETRY_BUDGET = 10 * 60 * 1000;
export const READ_RETRY_BUDGET = 60 * 1000;

const RELAY_LOST = new Set(["lost", "host-offline"]);

/**
 * Why a failed call may be retried: "unsent" if it never reached the host (busy, closing, disconnected), "unknown" if
 * it may have run and only its answer was lost, null for the host's own answer, which a retry would only get again.
 */
export function retryKind(error) {
  if (!error) return null;
  if (error.retry === "unsent" || error.retry === "unknown") return error.retry;
  if (error.name === "RelayTransportError") return RELAY_LOST.has(error.code) ? "unknown" : null;
  const message = ipcErrorMessage(error);
  if (error.status === 429 || (error.status === 503 && message === "Bridge is closing")) return "unsent";
  // A proxy's unavailable response doesn't prove the Mac skipped the request.
  if (error.status === 502 || error.status === 503 || error.status === 504) return "unknown";
  if (message.startsWith("Milagre host is disconnected. Your command was not sent.")) return "unsent";
  if (message.startsWith("Timed out: ") || message === "Daemon connection closed") return "unknown";
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt` until the computer answers. A failure `retryable` accepts is retried while the budget lasts; any other
 * failure, or one past the budget, is thrown.
 */
export async function retrySend(attempt, { retryable, delays = SEND_RETRY_DELAYS, budget = SEND_RETRY_BUDGET, now = Date.now, wait = sleep }) {
  const started = now();
  for (let tries = 0; ; tries++) {
    try {
      return await attempt();
    } catch (error) {
      const delay = delays[Math.min(tries, delays.length - 1)];
      if (!retryable(error) || now() + delay - started > budget) throw error;
      await wait(delay);
    }
  }
}
