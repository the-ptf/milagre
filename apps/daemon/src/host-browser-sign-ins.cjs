// The Browser panel's sign-ins on this Mac, signed out from the phone (Settings › Browser). The desktop app holds the
// sessions: one for this Mac's Chats and one for each paired computer's (apps/desktop/electron/
// browser-remote-sessions.cjs). These list them and forward a sign-out to the browser-panel:clear-sign-ins the desktop
// registers as a desktop command, and nothing else of that set.
const { LOCAL_COMPUTER } = require("@milagre/shared/chat-scopes");

const BROWSER_SIGN_IN_METHODS = Object.freeze(["browser:sign-ins", "browser:sign-ins:clear"]);

/**
 * @param {{
 *   desktop: { invoke(method: string, args: unknown[]): Promise<any> };
 *   computers: () => { id: string; name: string }[];
 * }} options
 */
function createHostBrowserSignIns({ desktop, computers }) {
  // This Mac first (named by the phone, which knows it), then each paired computer.
  const sessions = () => [{ id: LOCAL_COMPUTER, name: null }, ...computers().map(({ id, name }) => ({ id, name }))];
  return {
    /** @param {string} method @param {unknown[]} args */
    async invoke(method, args) {
      if (method === "browser:sign-ins") return { sessions: sessions() };
      if (method === "browser:sign-ins:clear") {
        const [computerId] = args;
        if (!sessions().some((session) => session.id === computerId)) throw new Error("This Mac has no Browser sign-ins for that computer.");
        return desktop.invoke("browser-panel:clear-sign-ins", [computerId]);
      }
      throw new Error(`Unknown command: ${method}`);
    },
  };
}

module.exports = { BROWSER_SIGN_IN_METHODS, createHostBrowserSignIns };
