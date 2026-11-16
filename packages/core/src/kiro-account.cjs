const { execCommand } = require("./agents/command.cjs");

// Kiro's account is the one kiro-cli is signed in to (docs/providers.md). Its sign-in needs the

const WHOAMI_TIMEOUT_MS = 15_000;

/**
 * Who `whoami` printed: "Logged in with IAM Identity Center (https://…/start)" or "Logged in with Builder ID", then
 * "Email: …". The plan is the sign-in method, which is what tells an organization's license from a personal one.
 */
function parseWhoami(text) {
  const output = String(text ?? "");
  const method = /Logged in with ([^(\n]+?)\s*(?:\(|$)/m.exec(output)?.[1]?.trim();
  if (!method) return null;
  const email = /^Email:\s*(\S+)/m.exec(output)?.[1];
  return { method, ...(email ? { email } : {}) };
}

function inspectKiroAccount({ command, env, execImpl = execCommand } = {}) {
  if (!command) return Promise.resolve({ state: "error", message: "Kiro CLI isn't installed." });
  return new Promise((resolve) => {
    execImpl(command, ["whoami"], { encoding: "utf8", timeout: WHOAMI_TIMEOUT_MS, env }, (error, stdout, stderr) => {
      const identity = parseWhoami(stdout);
      if (identity) {
        resolve({ state: "ready", ...(identity.email ? { email: identity.email } : {}), plan: identity.method });
        return;
      }
      if (/not logged in/i.test(`${stdout}\n${stderr}`)) {
        resolve({ state: "signed-out", message: "Run `kiro-cli login` in a terminal to sign in." });
        return;
      }
      resolve({ state: "error", message: error ? "Kiro CLI couldn't say who is signed in." : "Kiro CLI's sign-in couldn't be read." });
    });
  });
}

async function kiroLoggedOut(command, { env } = {}) {
  return (await inspectKiroAccount({ command, env })).state === "signed-out";
}

module.exports = { inspectKiroAccount, kiroLoggedOut, parseWhoami };
