// A throwaway host for the landing page recordings: a temporary "milagre" Project with a few Chats in their own
// Worktrees and a scripted agent. Nothing reads a provider account, runs a command or touches a real Project.
// The desktop recorder (record-desktop.cjs) and the phone both attach to it, so they show the same run.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { startDaemon } = require("../../apps/daemon/src/server.cjs");
const { startMobileBridge } = require("../../apps/daemon/src/mobile-bridge.cjs");
const { connect } = require("../../apps/daemon/src/client.cjs");
const { demoRuntimeOptions } = require("../../apps/daemon/src/demo-agent.cjs");

const VERSION = "0.1.0-site-demo";
const MODELS = {
  claude: [{ id: "claude-opus-5-5", name: "Opus 5.5", efforts: ["low", "medium", "high"], recommended: true }],
  codex: [{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol", efforts: ["low", "medium", "high"], recommended: true }],
  antigravity: null,
  kiro: null,
};

// The Chat the recordings follow, and the others around it in the sidebar.
const HERO = {
  title: "Swipe between Chat and Changes",
  history: "Add swipe navigation between Chat and Changes on the phone.",
  prompt: "Make the swipe between Chat and Changes follow the flick speed, then run the mobile checks.",
};
const OTHERS = [
  {
    title: "Phone pairing follow-ups",
    prompt: "Follow up on phone pairing: show the paired-phone count.",
    running: true,
    pr: { number: 192, checks: "running" },
  },
  { title: "Find Projects from the phone", prompt: "Let the phone search Projects by name.", pr: { number: 189, checks: "passed" } },
  {
    title: "Keep the Chat timer running",
    prompt: "Keep the Chat timer running when the app is in the background.",
    pr: { number: 177, checks: "passed", ready: true },
  },
  { title: "Link Worktrees and share context", prompt: "Link Worktrees so agents can share context.", pr: { number: 168, merged: true } },
];

const RELAY_CHATS = [
  { title: "Rate-limit pairing attempts", prompt: "Limit how often a phone can try to pair through the relay.", pr: { number: 64, checks: "passed" } },
  { title: "Reconnect after the Mac sleeps", prompt: "Reconnect the relay room after the Mac wakes from sleep.", pr: { number: 61, merged: true } },
];

const PAGER_DIFF = `--- a/apps/mobile/src/chat-pager.tsx
+++ b/apps/mobile/src/chat-pager.tsx
@@ -41,9 +41,14 @@ export function ChatPager({ pages }: Props) {
   const onEnd = (event: PanEvent) => {
-    const next = Math.abs(event.translationX) > width / 2 ? page + direction(event) : page;
+    const fast = Math.abs(event.velocityX) > FLICK_VELOCITY;
+    const far = Math.abs(event.translationX) > width * 0.35;
+    const next = fast || far ? page + direction(event) : page;
     snapTo(clamp(next, 0, pages.length - 1));
   };`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The scripted agent: the hero Chat reads, edits, asks to run the checks and finishes; a "running" Chat never ends. */
function scriptedSession(log) {
  return function createSession(_provider, { emit }) {
    let pending = null;
    let cancelled = false;
    let turn = 0;
    const session = {
      closed: false,
      turnActive: false,
      nativeId: `site-demo-${randomBytes(4).toString("hex")}`,
      async startTurn({ prompt }) {
        const turnId = `turn-${++turn}`;
        cancelled = false;
        session.turnActive = true;
        emit({ type: "session-started", nativeId: session.nativeId });
        emit({ type: "turn-started", turnId });
        if (prompt === HERO.prompt) void hero();
        else if (/pairing/i.test(prompt)) void running();
        else void quick(prompt);
        return { turnId };
      },
      respondToPermission(requestId, decision) {
        if (!pending || pending.id !== requestId) return false;
        const resolve = pending.resolve;
        pending = null;
        emit({ type: "permission-resolved", requestId, decision });
        resolve(decision);
        return true;
      },
      answerQuestion: () => false,
      async interrupt() {
        cancelled = true;
        pending = null;
        if (session.turnActive) emit({ type: "turn-cancelled" });
        session.turnActive = false;
      },
      async close() {
        await session.interrupt();
        session.closed = true;
      },
    };
    const say = (text) => !cancelled && emit({ type: "text-delta", text });
    const finish = () => {
      if (cancelled) return;
      session.turnActive = false;
      emit({ type: "turn-completed" });
    };
    // Streams text a few words at a time, like a real model.
    async function stream(text) {
      for (const word of text.match(/\S+\s*/g) ?? []) {
        say(word);
        await wait(28);
      }
    }
    async function quick(prompt) {
      await wait(200);
      if (prompt === HERO.history) {
        await stream(
          "Swipe navigation is in. On the phone you can now swipe left from a Chat to see its Changes, and right to go back.\n\n- The pager snaps to the closest page when you let go.\n- The tab bar follows the swipe.\n- Changes load as soon as the swipe starts.",
        );
        return finish();
      }
      await stream(`Done. ${prompt.replace(/\.$/, "")} is in place and the checks pass.`);
      finish();
    }
    async function running() {
      await stream("I'll add the count to Settings › Phone.\n\n");
      emit({
        type: "step-started",
        step: { id: "p1", kind: "read", title: "Read `phone-settings.tsx`", file: "apps/desktop/app/src/components/PhoneSettings.tsx" },
      });
      await wait(600);
      emit({ type: "step-completed", id: "p1", status: "done", note: "1 file" });
      emit({
        type: "step-started",
        step: { id: "p2", kind: "shell", title: "Run `npm test -- --only test-phone`", detail: "$ npm test -- --only test-phone" },
      });
    }
    async function hero() {
      log("hero:start");
      await wait(500);
      await stream("I'll check how the pager decides when a swipe changes page.\n\n");
      emit({ type: "step-started", step: { id: "h1", kind: "read", title: "Read `chat-pager.tsx`", file: "apps/mobile/src/chat-pager.tsx" } });
      await wait(900);
      emit({ type: "step-completed", id: "h1", status: "done", note: "1 file" });
      await stream("It only looks at distance, so a quick flick snaps back. I'll count the flick speed too.\n\n");
      emit({
        type: "step-started",
        step: { id: "h2", kind: "edit", title: "Edit `chat-pager.tsx`", file: "apps/mobile/src/chat-pager.tsx", detail: PAGER_DIFF },
      });
      await wait(1000);
      emit({ type: "step-completed", id: "h2", status: "done", note: "+3 −1", detail: PAGER_DIFF });
      emit({ type: "step-started", step: { id: "h3", kind: "shell", title: "Run `npm run test:mobile`", detail: "$ npm run test:mobile" } });
      await wait(400);
      const decision = await new Promise((resolve) => {
        pending = { id: "approve-tests", resolve };
        emit({
          type: "permission-request",
          requestId: "approve-tests",
          kind: "command",
          tool: "Bash",
          title: "Run the mobile checks",
          description: "Runs the swipe navigation checks",
          command: "npm run test:mobile",
          allowForChat: true,
          stepId: "h3",
        });
        log("hero:approval");
      });
      if (cancelled) return;
      log(`hero:${decision}`);
      await wait(300);
      emit({ type: "step-output", id: "h3", text: "> mobile checks\n✓ chat pager (12)\n✓ swipe navigation (18)\n✓ changes view (12)\n" });
      await wait(1400);
      emit({ type: "step-completed", id: "h3", status: "done", note: "42 passed", detail: "$ npm run test:mobile\n42 passed" });
      await stream("A quick flick now moves between Chat and Changes, and a slow drag still needs a third of the screen.\n\nAll 42 mobile checks pass.");
      finish();
      log("hero:done");
    }
    return session;
  };
}

function fakePullRequests(byPath) {
  const read = (worktreePath) => {
    const other = byPath.get(worktreePath);
    if (!other?.pr) return null;
    const { number, checks, ready, merged } = other.pr;
    return {
      number,
      url: `https://github.com/the-ptf/milagre-ade/pull/${number}`,
      state: merged ? "MERGED" : "OPEN",
      title: other.title,
      readyToMerge: !!ready,
      hasConflicts: false,
      conflictStatusKnown: true,
      isBehind: false,
      changesRequested: false,
      ...(merged ? {} : { checks }),
    };
  };
  return { readPullRequest: async (worktreePath) => read(worktreePath), readPullRequests: async () => [] };
}

async function startSiteDemo({ port = 8913, log = () => {} } = {}) {
  // A fixed folder keeps the Project path, and so the phone's open Chat, the same from one take to the next.
  const fixed = process.env.MILAGRE_SITE_DEMO_ROOT;
  if (fixed) {
    await fs.rm(fixed, { recursive: true, force: true });
    await fs.mkdir(fixed, { recursive: true });
  }
  const root = await fs.realpath(fixed || (await fs.mkdtemp(path.join(os.tmpdir(), "milagre-site-demo-"))));
  const dataDir = path.join(root, "profile");
  async function makeRepo(name) {
    const repo = path.join(root, name);
    await fs.mkdir(repo);
    const git = (...args) =>
      execFileSync("git", ["-C", repo, "-c", "user.name=Milagre Demo", "-c", "user.email=demo@example.invalid", ...args], { stdio: "ignore" });
    execFileSync("git", ["init", "-qb", "main", repo]);
    await fs.writeFile(path.join(repo, "README.md"), `# ${name}\n`);
    await fs.writeFile(path.join(repo, ".gitignore"), ".milagre/\n");
    git("add", ".");
    git("commit", "-qm", "Start");
    return repo;
  }
  const project = await makeRepo("milagre");
  const relay = await makeRepo("relay");

  const byPath = new Map();
  const daemon = await startDaemon({
    dataDir,
    version: VERSION,
    runtimeOptions: {
      ...demoRuntimeOptions({ cwd: project, worktreeRoot: path.join(project, ".milagre", "worktrees") }),
      agentCliStatus: Object.assign(
        async () => ({ codex: { state: "ready" }, claude: { state: "ready" }, antigravity: { state: "ready" }, kiro: { state: "missing" } }),
        {
          invalidate() {},
        },
      ),
      agentModels: async () => MODELS,
      createSession: scriptedSession(log),
      ...fakePullRequests(byPath),
    },
  });
  const client = await connect({ dataDir });
  const opened = await client.call("project:open", [project]);
  // The Project's first Chat (on main) is not part of the demo.
  for (const session of Object.values(opened.state.sessions)) await client.call("chat:patch", [project, session.id, { title: "Release notes" }]);
  const icon = await fs.readFile(path.resolve(__dirname, "../../apps/desktop/build/icons/128x128.png"));
  await client.call("project:set-icon", [project, `data:image/png;base64,${icon.toString("base64")}`]);

  async function createChat({ title, prompt }, send, projectPath = project) {
    const created = await client.call("worktree:create", [{ projectPath, baseBranch: "main", prompt: title }]);
    const worktree = created.project.state.worktrees[created.worktreeId];
    const chat = Object.values(created.project.state.sessions).find((session) => session.worktree_id === created.worktreeId);
    await client.call("chat:patch", [projectPath, chat.id, { title }]);
    if (send) await client.call("chat:send", [{ projectPath, sessionId: chat.id, body: prompt, provider: "claude", model: "claude-opus-5-5" }]);
    return { chat, worktree };
  }
  // A second Project, so the every-Project sidebar has more than one group.
  const relayOpened = await client.call("project:open", [relay]);
  for (const session of Object.values(relayOpened.state.sessions)) await client.call("chat:patch", [relay, session.id, { title: "Release notes" }]);
  const relayIcon = await fs.readFile(path.join(__dirname, "relay-icon.png"));
  await client.call("project:set-icon", [relay, `data:image/png;base64,${relayIcon.toString("base64")}`]);
  for (const other of RELAY_CHATS.toReversed()) {
    const { worktree } = await createChat(other, true, relay);
    byPath.set(worktree.path, other);
    await wait(600);
  }
  await client.call("project:open", [project]);
  for (const other of OTHERS.toReversed()) {
    const { worktree } = await createChat(other, true);
    byPath.set(worktree.path, other);
    await wait(other.running ? 100 : 600);
  }
  const hero = await createChat({ title: HERO.title, prompt: HERO.history }, true);
  byPath.set(hero.worktree.path, { title: HERO.title, pr: { number: 195, checks: "passed" } });
  await wait(1500);
  const heroChatId = `${project}#${hero.chat.id}`;

  // A fixed token keeps the phone paired across takes; every take needs a fresh host.
  const token = process.env.MILAGRE_SITE_DEMO_TOKEN || randomBytes(32).toString("hex");
  const bridge = await startMobileBridge({ dataDir, port, token });
  const pairing = `milagre://pair?address=${encodeURIComponent(bridge.url)}&token=${token}&name=${encodeURIComponent("My Mac")}`;
  return {
    root,
    dataDir,
    project,
    version: VERSION,
    heroChatId,
    pairing,
    bridgeUrl: bridge.url,
    token,
    /** Approves the hero's check run from the host, for a take without the phone. */
    approve: () => client.call("agent:respond-permission", [{ chatId: heroChatId, requestId: "approve-tests", decision: "allow" }]),
    /** Sends the hero prompt: the run the recordings show. */
    play: () => client.call("chat:send", [{ projectPath: project, sessionId: hero.chat.id, body: HERO.prompt, provider: "claude", model: "claude-opus-5-5" }]),
    async close() {
      await bridge.close();
      client.close();
      await daemon.close();
    },
  };
}

module.exports = { startSiteDemo };
