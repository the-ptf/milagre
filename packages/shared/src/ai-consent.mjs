export const AI_CONSENT_VERSION = "2026-10-10";
export const PRIVACY_URL = "https://milagre.cloud/privacy";
export const SUPPORT_URL = "https://milagre.cloud/support";
export const AI_CONSENT_TITLE = "Allow sharing with AI providers?";
export const AI_CONSENT_DESCRIPTION =
  "When you send or continue a Chat, Milagre sends your prompts, attachments, relevant project files, conversation history and tool results to the AI providers you use: Anthropic (Claude), OpenAI (Codex) or Google (Antigravity). Agents and advisors you configure may use a different provider. This data can include personal or confidential information.";
export const AI_CONSENT_DETAIL =
  "Sharing lets those providers generate responses and carry out your requests. Their privacy policies and your provider account settings govern how they process and retain this data. Allowing applies to future AI actions from this device. You can reset this permission in Settings > Privacy & AI.";
export const AI_RESET_DETAIL =
  "Reset blocks future AI actions from this device until you allow sharing again. It does not stop agents already running or delete data already sent. Use Stop in the Chat to stop a running agent.";
export const AI_PROVIDER_POLICIES = [
  { name: "Anthropic", url: "https://www.anthropic.com/legal/privacy" },
  { name: "OpenAI", url: "https://openai.com/policies/privacy-policy/" },
  { name: "Google", url: "https://policies.google.com/privacy" },
];

const denied = () => new Error("AI sharing permission is required. Your message was not sent.");

/** A versioned device decision. Failed reads/writes never grant permission. */
export function createAiConsent({ read, write, ask }) {
  let pending = null;
  let epoch = 0;
  let writes = Promise.resolve();
  const save = (value) => {
    const next = writes.then(() => write(value));
    writes = next.catch(() => {});
    return next;
  };
  const allowed = async () => {
    await writes;
    return (await read()) === AI_CONSENT_VERSION;
  };
  return {
    allowed,
    async require(interactive = true) {
      const started = epoch;
      if (await allowed()) {
        if (started !== epoch) throw denied();
        return;
      }
      if (!interactive || started !== epoch) throw denied();
      if (!pending) {
        const decision = (async () => {
          if (!(await ask()) || started !== epoch) throw denied();
          await save(AI_CONSENT_VERSION);
          if (started !== epoch) throw denied();
        })();
        pending = decision;
        void decision
          .finally(() => {
            if (pending === decision) pending = null;
          })
          .catch(() => {});
      }
      await pending;
      if (started !== epoch) throw denied();
    },
    async reset() {
      epoch++;
      await save(null);
    },
  };
}

export function requiresAiConsent(method, args = []) {
  if (method === "agent:respond-permission") return args[0]?.decision !== "deny";
  if (method === "agent:set-permission-mode") return args[0]?.mode !== "ask";
  // A sign-off lets the bot's turn go on; a denial ends it.
  if (method === "bots:answer-gate") return args[1] !== "deny";
  return ["chat:send", "bots:send", "link:send", "chat:resume", "chat:limit-switch", "advisor:retry", "agent:answer-question", "live-activity:answer"].includes(
    method,
  );
}

const methods = {
  sendMessage: "chat:send",
  sendLinkMessage: "link:send",
  resumeChat: "chat:resume",
  switchAccountAfterLimit: "chat:limit-switch",
  retryAdvisor: "advisor:retry",
  answerQuestion: "agent:answer-question",
  respondToPermission: "agent:respond-permission",
  setAgentPermissionMode: "agent:set-permission-mode",
  sendToBot: "bots:send",
  answerBotGate: "bots:answer-gate",
};

/** Wrap both local and paired-computer bridges at their shared call boundary. */
export function protectAiBridge(bridge, requireConsent) {
  const wrapped = new Map();
  // Electron contextBridge freezes its object; proxy a mutable facade instead.
  // Read from the original bridge so dynamic Proxy methods survive the facade.
  return new Proxy(
    { ...bridge },
    {
      get(_target, property) {
        const method = Object.hasOwn(methods, property) ? methods[property] : null;
        const value = Reflect.get(bridge, property);
        if (!method || typeof value !== "function") return value;
        if (!wrapped.has(property))
          wrapped.set(property, async (...args) => {
            const input = property === "respondToPermission" ? [{ decision: args[2] }] : property === "setAgentPermissionMode" ? [{ mode: args[1] }] : args;
            if (requiresAiConsent(method, input)) await requireConsent(property !== "setAgentPermissionMode");
            return value.apply(bridge, args);
          });
        return wrapped.get(property);
      },
    },
  );
}
