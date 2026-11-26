// @ts-check
const path = require("node:path");

const KEYCHAIN_ACCESS_GROUP = "YWMU5N9D6K.com.milagre.app.webauthn";

/**
 * macOS grants the `keychain-access-groups` entitlement Touch ID passkeys are stored under only with the provisioning
 * profile a signed release embeds. Any other build would offer passkeys to every page and then fail each one.
 * @param {{ platform: NodeJS.Platform; resourcesPath: string; exists: (file: string) => boolean }} options
 */
function passkeysSupported({ platform, resourcesPath, exists }) {
  return platform === "darwin" && exists(path.join(resourcesPath, "..", "embedded.provisionprofile"));
}

/** @param {Pick<Electron.WebAuthnAccount, "displayName" | "name">} account */
function accountLabel({ displayName, name }) {
  if (displayName && name && displayName !== name) return `${displayName} (${name})`;
  return displayName || name || "Passkey";
}

/**
 * Touch ID passkeys for Browser panel pages, and the account picker a sign-in with more than one passkey waits on.
 * @param {{
 *   app: Pick<Electron.App, "configureWebAuthn">;
 *   dialog: Pick<Electron.Dialog, "showMessageBox">;
 *   windowForFrame: (frame: Electron.WebFrameMain | null) => Electron.BrowserWindow | null;
 *   supported: boolean;
 * }} options
 */
function createPasskeys({ app, dialog, windowForFrame, supported }) {
  /**
   * @param {Electron.SelectWebauthnAccountDetails} details
   * @param {(credentialId?: string | null) => void} callback
   */
  async function pick(details, callback) {
    let chosen = null;
    try {
      const { accounts } = details;
      /** @type {Electron.MessageBoxOptions} */
      const options = {
        type: "question",
        message: `Sign in to ${details.relyingPartyId}`,
        detail: "Choose a passkey.",
        buttons: [...accounts.map(accountLabel), "Cancel"],
        defaultId: 0,
        cancelId: accounts.length,
      };
      const window = windowForFrame(details.frame);
      const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      chosen = accounts[response]?.credentialId ?? null;
    } catch (error) {
      console.warn("Passkey picker:", error instanceof Error ? error.message : String(error));
    } finally {
      callback(chosen);
    }
  }

  return {
    supported,
    configure() {
      if (supported) app.configureWebAuthn({ touchID: { keychainAccessGroup: KEYCHAIN_ACCESS_GROUP } });
    },
    /** @param {Pick<Electron.Session, "on">} session */
    attach(session) {
      session.on("select-webauthn-account", (_event, details, callback) => void pick(details, callback));
    },
  };
}

module.exports = { KEYCHAIN_ACCESS_GROUP, accountLabel, createPasskeys, passkeysSupported };
