const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { CodexSession } = require("./codex-provider.cjs");
const { CodexRpc } = require("./codex-rpc.cjs");
const { ClaudeSession } = require("./claude-provider.cjs");
const { waitUntil } = require("./test-helpers.cjs");
const { isTerminal } = require("./events.cjs");

test("Codex answers on an ephemeral fork and preserves its read-only restrictions", async (t) => {
  const requests = [];
  const events = [];
  const session = new CodexSession({
    cwd: os.tmpdir(),
    command: process.execPath,
    resumeId: "parent-thread",
    forkSession: true,
    ephemeral: true,
    analysisOnly: true,
    sideChat: true,
    emit: (event) => events.push(event),
    createRpc: (options) => {
      const rpc = new CodexRpc({ ...options, args: [path.join(__dirname, "fixtures/fake-app-server.cjs")], env: { ...process.env, FAKE_SCENARIO: "reply" } });
      const request = rpc.request.bind(rpc);
      rpc.request = (method, params, config) => {
        requests.push({ method, params });
        return request(method, params, config);
      };
      return rpc;
    },
  });
  t.after(() => session.close());
  await session.startTurn({ prompt: "Side question", model: "gpt-6-luna", permissionMode: "full" });
  await waitUntil(() => events.some(isTerminal));
  assert.ok(
    events.some((event) => event.type === "turn-completed"),
    JSON.stringify(events),
  );
  assert.notEqual(session.nativeId, "parent-thread");
  const fork = requests.find((request) => request.method === "thread/fork").params;
  assert.equal(fork.threadId, "parent-thread");
  assert.equal(fork.excludeTurns, true);
  assert.equal(fork.ephemeral, true);
  assert.equal(fork.sandbox, "read-only");
  assert.equal(fork.approvalPolicy, "never");
  assert.equal(
    requests.some((request) => request.method === "thread/resume"),
    false,
  );
});

test("Claude forks native context with read-only tools and side-question instructions", async (t) => {
  let options;
  const events = [];
  const session = new ClaudeSession({
    cwd: os.tmpdir(),
    command: "claude",
    resumeId: "parent-session",
    forkSession: true,
    ephemeral: true,
    analysisOnly: true,
    sideChat: true,
    emit: (event) => events.push(event),
    loadSdk: async () => ({
      query: (request) => {
        options = request.options;
        async function* answers() {
          for await (const prompt of request.prompt) {
            assert.match(prompt.message.content[0].text, /Side question/);
            yield { type: "system", subtype: "init", session_id: "side-session" };
            yield { type: "result", subtype: "success", is_error: false, result: "A side answer" };
          }
        }
        return Object.assign(answers(), {
          interrupt: async () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          setMaxThinkingTokens: async () => {},
        });
      },
    }),
  });
  t.after(() => session.close());
  await session.startTurn({ prompt: "Side question", model: "haiku", permissionMode: "full" });
  await waitUntil(() => events.some(isTerminal));
  assert.equal(session.nativeId, "side-session");
  assert.equal(options.resume, "parent-session");
  assert.equal(options.forkSession, true);
  assert.equal(options.persistSession, false);
  assert.equal(options.permissionMode, "dontAsk");
  assert.match(options.systemPrompt.append, /ephemeral \/btw/);
  assert.equal((await options.canUseTool("Bash", { command: "touch changed" })).behavior, "deny");
});
