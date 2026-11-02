const { computerNoun } = require("@milagre/shared/host-computer");
// A scripted agent for demos (`npm run mobile:demo`, `npm run review:demo`). Never selected by the real daemon CLI:
// a host passes `demoRuntimeOptions()` to startDaemon explicitly. It reads, runs and changes nothing.

const DEFAULT_COPY = {
  ack: `Demo agent: your message reached the daemon on your ${computerNoun}. `,
  reply: "The reply made it back to your simulator. Your Chat is saved locally.",
};

/** The one model the demo reports. */
const DEMO_MODEL = Object.freeze({
  id: "demo",
  name: "Demo agent",
  description: "A scripted agent. It runs no command and changes no file",
  recommended: true,
  efforts: [],
  ultracode: false,
  fastMode: false,
});
const DEMO_ONLY = "This demo computer runs only the demo agent.";
const NO_PULL_REQUESTS = "Pull requests are not available on the demo computer.";

/** A createSession for core's SessionManager. `copy` replaces the plain reply's two parts. */
function createDemoSession(copy = {}) {
  const { ack, reply } = { ...DEFAULT_COPY, ...copy };
  return function demoSession(_provider, { emit }) {
    let timer;
    let pending;
    let sequence = 0;
    const session = {
      closed: false,
      turnActive: false,
      nativeId: "milagre-local-demo",
      async startTurn({ prompt }) {
        clearTimeout(timer);
        pending = null;
        const turnId = `demo-${++sequence}`;
        session.turnActive = true;
        emit({ type: "session-started", nativeId: session.nativeId });
        emit({ type: "turn-started", turnId });
        if (/approval/i.test(prompt)) {
          pending = { kind: "permission", id: turnId };
          emit({
            type: "permission-request",
            requestId: turnId,
            kind: "command",
            tool: "Demo",
            title: "Approve a demo action?",
            command: "Demo only: no command will run",
            allowForChat: false,
          });
        } else if (/question/i.test(prompt)) {
          pending = { kind: "question", id: turnId };
          emit({
            type: "question-request",
            requestId: turnId,
            questions: [
              {
                id: "next",
                header: "Next step",
                question: "What should we try next?",
                options: [{ label: "Read a Chat" }, { label: "Send a message" }],
                multiSelect: false,
                allowOther: true,
                secret: false,
              },
            ],
          });
        } else if (/tools/i.test(prompt)) {
          emit({ type: "text-delta", text: "I will inspect the app and check the tests.\n\n" });
          emit({
            type: "step-started",
            step: { id: "demo-read", kind: "read", title: "Read `chat.tsx`", detail: "Demo file inspection. No files were read or changed." },
          });
          timer = setTimeout(() => {
            emit({ type: "step-completed", id: "demo-read", status: "done", note: "1 file" });
            emit({
              type: "step-started",
              step: { id: "demo-test", kind: "shell", title: "Run `npm test`", detail: "$ npm test\nChecking the Chat controls…" },
            });
            timer = setTimeout(
              () => {
                const failed = /failure/i.test(prompt);
                emit({
                  type: "step-completed",
                  id: "demo-test",
                  status: failed ? "failed" : "done",
                  detail: failed
                    ? "$ npm test\nFAIL: demo assertion\nThis is a simulated failure; no command ran."
                    : "$ npm test\nPASS: send, stop, reconnect\n3 checks passed (simulated).",
                  note: failed ? "Demo failure" : "3 checks passed",
                });
                finish(
                  "## Preview ready\n\nThe **Chat controls** are ready to try.\n\n- Expand activity to inspect tool output.\n- Send `approval` to try a permission request.\n\n```sh\nnpm run test:mobile\n```\n\nThis is a **demo response**. No command was run.",
                );
              },
              /slow/i.test(prompt) ? 20000 : 800,
            );
          }, 500);
        } else {
          emit({ type: "text-delta", text: ack });
          timer = setTimeout(() => finish(reply), /slow/i.test(prompt) ? 20000 : 1200);
        }
        return { turnId };
      },
      respondToPermission(requestId, decision) {
        if (pending?.kind !== "permission" || pending.id !== requestId) return false;
        pending = null;
        emit({ type: "permission-resolved", requestId });
        finish(`Demo agent: action ${decision === "deny" ? "denied" : "approved"}. No command was run.`);
        return true;
      },
      answerQuestion(requestId, answers) {
        if (pending?.kind !== "question" || pending.id !== requestId) return false;
        pending = null;
        emit({ type: "question-resolved", requestId, outcome: answers ? "answered" : "dismissed" });
        finish(`Demo agent: answer received${answers ? ": " + Object.values(answers).flat().join(", ") : "."}`);
        return true;
      },
      async interrupt() {
        clearTimeout(timer);
        pending = null;
        if (session.turnActive) emit({ type: "turn-cancelled" });
        session.turnActive = false;
      },
      async close() {
        await session.interrupt();
        session.closed = true;
      },
    };
    function finish(text) {
      emit({ type: "text-delta", text });
      session.turnActive = false;
      emit({ type: "turn-completed" });
    }
    return session;
  };
}

const demoSession = createDemoSession();

/**
 * Runtime options that put only the demo agent behind a daemon: every turn, whichever provider the phone picks, goes
 * to `createSession`; no CLI is looked up, no account's usage is read, and the model list is the demo model alone.
 * The CLI lookup answers with a path that does not exist, so a background helper that tries to start one fails.
 */
function demoRuntimeOptions({ cwd, worktreeRoot, copy } = {}) {
  const agentCliStatus = Object.assign(
    async () => ({
      codex: { state: "ready" },
      claude: { state: "missing", message: DEMO_ONLY },
      antigravity: { state: "missing", message: DEMO_ONLY },
      kiro: { state: "missing", message: DEMO_ONLY },
    }),
    { invalidate() {} },
  );
  return {
    cwd,
    worktreeRoot,
    environmentReady: Promise.resolve(),
    titleModels: {},
    createSession: copy ? createDemoSession(copy) : demoSession,
    agentCli: Object.assign(async () => ({ command: "/nonexistent/milagre-demo-agent" }), { invalidate() {} }),
    agentModels: async () => ({ codex: [{ ...DEMO_MODEL }], claude: null, antigravity: null, kiro: null }),
    agentCliStatus,
    readUsage: async () => ({ providers: [] }),
    // The owner's personal skills stay on the Mac: `/skill` reaches the agent as typed.
    expandSkills: false,
    // Never `gh`, which would use the owner's GitHub login.
    readPullRequest: async () => {
      throw new Error(NO_PULL_REQUESTS);
    },
    readPullRequests: async () => {
      throw new Error(NO_PULL_REQUESTS);
    },
  };
}

module.exports = { createDemoSession, demoSession, demoRuntimeOptions, DEMO_MODEL, DEMO_ONLY, NO_PULL_REQUESTS };
