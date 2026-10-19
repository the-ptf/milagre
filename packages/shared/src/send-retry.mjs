import { ipcErrorMessage } from "./result.mjs";

/** The waits between tries of a send the computer couldn't take: quick at first, then every 30 s. */
export const SEND_RETRY_DELAYS = Object.freeze([1000, 2000, 4000, 8000, 15000, 30000]);
/** How long a send keeps trying before it fails as it would have at once. */
export const SEND_RETRY_BUDGET = 10 * 60 * 1000;

const RELAY_LOST = new Set(["lost", "host-offline"]);

/**
 * Why a failed call to the computer may be tried again. "unsent" when it never reached the host: the host was busy
 * (429, the phone channel's or bridge's cap), closing, or disconnected from this window. "unknown" when it may have run
 * and only its answer was lost: a deadline passed or the connection dropped. Null for the host's own answer, such as a
 * refusal, which a retry would only get again.
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
  // The daemon client's deadline (apps/daemon/src/client.cjs), on this Mac or forwarded by the phone bridge.
  if (message.startsWith("Timed out: ") || message === "Daemon connection closed") return "unknown";
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt` until the computer answers it. A failure `retryable` accepts is tried again after a wait while the
 * budget lasts, so a busy computer takes the send once it can; any other failure, or one past the budget, is thrown.
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
