const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { KEYCHAIN_ACCESS_GROUP, accountLabel, createPasskeys, passkeysSupported } = require("./passkeys.cjs");

const RESOURCES = "/Applications/Milagre.app/Contents/Resources";
const PROFILE = "/Applications/Milagre.app/Contents/embedded.provisionprofile";

test("passkeys need macOS and the release's embedded provisioning profile", () => {
  const exists = (file) => file === PROFILE;
  assert.equal(passkeysSupported({ platform: "darwin", resourcesPath: RESOURCES, exists }), true);
  assert.equal(passkeysSupported({ platform: "darwin", resourcesPath: "/tmp/dev/Resources", exists }), false);
  assert.equal(passkeysSupported({ platform: "win32", resourcesPath: RESOURCES, exists }), false);
});

function setup({ supported = true, response = 0, window = null } = {}) {
  const configured = [];
  const shown = [];
  const passkeys = createPasskeys({
    app: { configureWebAuthn: (options) => configured.push(options) },
    dialog: {
      showMessageBox: async (...args) => {
        shown.push(args);
        return { response, checkboxChecked: false };
      },
    },
    windowForFrame: () => window,
    supported,
  });
  const session = new EventEmitter();
  passkeys.attach(session);
  /** @param {object[]} accounts */
  const select = (accounts) =>
    new Promise((resolve) => session.emit("select-webauthn-account", {}, { relyingPartyId: "github.com", accounts, frame: null }, resolve));
  return { passkeys, configured, shown, select };
}

test("a signed release turns on Touch ID passkeys under Milagre's keychain group", () => {
  const { passkeys, configured } = setup();
  passkeys.configure();
  assert.deepEqual(configured, [{ touchID: { keychainAccessGroup: KEYCHAIN_ACCESS_GROUP } }]);
});

test("any other build leaves WebAuthn as Electron ships it", () => {
  const { passkeys, configured } = setup({ supported: false });
  passkeys.configure();
  assert.deepEqual(configured, []);
});

const ACCOUNTS = [
  { credentialId: "a", displayName: "Victor", name: "victor@example.com" },
  { credentialId: "b", name: "work@example.com" },
];

test("choosing an account signs in with its passkey", async () => {
  const window = { id: 1 };
  const { select, shown } = setup({ response: 1, window });
  assert.equal(await select(ACCOUNTS), "b");
  const [owner, options] = shown[0];
  assert.equal(owner, window);
  assert.equal(options.message, "Sign in to github.com");
  assert.deepEqual(options.buttons, ["Victor (victor@example.com)", "work@example.com", "Cancel"]);
  assert.equal(options.cancelId, 2);
});

test("Cancel, or a picker that fails, cancels the sign-in instead of leaving it waiting", async () => {
  assert.equal(await setup({ response: 2 }).select(ACCOUNTS), null);
  const failing = createPasskeys({
    app: { configureWebAuthn: () => {} },
    dialog: { showMessageBox: async () => Promise.reject(new Error("no window")) },
    windowForFrame: () => null,
    supported: true,
  });
  const session = new EventEmitter();
  failing.attach(session);
  const answered = new Promise((resolve) =>
    session.emit("select-webauthn-account", {}, { relyingPartyId: "x.test", accounts: ACCOUNTS, frame: null }, resolve),
  );
  assert.equal(await answered, null);
});

test("the picker works for security keys too, so it is attached on every build", async () => {
  const { select } = setup({ supported: false, response: 0 });
  assert.equal(await select(ACCOUNTS), "a");
});

test("accounts are labelled by display name, then user name", () => {
  assert.equal(accountLabel({ displayName: "Ana", name: "Ana" }), "Ana");
  assert.equal(accountLabel({ name: "ana@example.com" }), "ana@example.com");
  assert.equal(accountLabel({}), "Passkey");
});

test("the passkeys entitlements are the app's own plus the keychain group passkeys.cjs stores under", () => {
  const { readFileSync } = require("node:fs");
  const path = require("node:path");
  const keys = (file) => [...readFileSync(path.join(__dirname, "../build", file), "utf8").matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
  const passkeysPlist = readFileSync(path.join(__dirname, "../build/entitlements.mac.passkeys.plist"), "utf8");
  for (const key of keys("entitlements.mac.plist")) assert.ok(keys("entitlements.mac.passkeys.plist").includes(key), key);
  assert.ok(passkeysPlist.includes(`<string>${KEYCHAIN_ACCESS_GROUP}</string>`));
});
