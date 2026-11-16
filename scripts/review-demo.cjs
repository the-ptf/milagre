// A demo computer for Apple's TestFlight Beta App Review: `npm run review:demo [-- --data-dir /absolute/path]`.
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseArgs } = require("node:util");
const { setTimeout: delay } = require("node:timers/promises");
const { startDaemon } = require("../apps/daemon/src/server.cjs");
const { connect } = require("../apps/daemon/src/client.cjs");
const { demoRuntimeOptions } = require("../apps/daemon/src/demo-agent.cjs");
const { version } = require("../apps/daemon/package.json");

const PROJECT_NAME = "Milagre Demo Project";
const DEFAULT_DATA_DIR = "/Users/Shared/Milagre Review Demo";
const LINK_FILE = "review-pairing-link.txt";
const PHONE_PORT = 8899;
const COMPUTER_NAME = "Milagre Demo Mac";
const KEEP_OPEN_MS = 5 * 60 * 1000;
const COPY = {
  ack: "Demo agent: your message reached the demo computer through Milagre's relay. ",
  reply:
    'On your own Mac this Chat would be a Claude Code, Codex or Antigravity session working in your project. This demo computer runs a scripted agent, so no command runs and no file changes. Send "tools" to see agent activity, "approval" for a permission request, or "question" for a question card.',
};
const WELCOME = "Welcome! This is a demo computer for trying Milagre. Its agent is scripted: it never runs commands or changes files.";

const FILES = {
  ".gitignore": ".milagre/\nnode_modules/\n",
  "README.md":
    "# Milagre Demo Project\n\nA small project for trying Milagre from your phone.\n\n- `src/greeting.js` builds the greeting.\n- `src/app.js` prints it.\n\nRun it with `npm start`.\n",
  "package.json": `${JSON.stringify({ name: "milagre-demo-project", version: "1.0.0", private: true, scripts: { start: "node src/app.js", test: "node --test" } }, null, 2)}\n`,
  "src/greeting.js": "function greeting(name) {\n  return `Hello, ${name}!`;\n}\n\nmodule.exports = { greeting };\n",
  "src/app.js": "const { greeting } = require('./greeting.js');\n\nconsole.log(greeting(process.argv[2] || 'world'));\n",
};
const CHANGES = {
  "src/greeting.js":
    "function greeting(name, { excited = false } = {}) {\n  return `Hello, ${name}${excited ? '!!' : '!'}`;\n}\n\nmodule.exports = { greeting };\n",
  "README.md": `${FILES["README.md"]}\nPass \`{ excited: true }\` to \`greeting\` for a louder hello.\n`,
};
const CHATS = [
  { title: "Welcome to Milagre", body: "Hi! What can I do from my phone?", note: WELCOME },
  { title: "Check the tests", body: "Look at the tools you would use and check the tests" },
];

const exists = (file) =>
  fs.access(file).then(
    () => true,
    () => false,
  );
const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=Milagre Demo", "-c", "user.email=demo@example.invalid", ...args], { stdio: "ignore" });

async function seedProject(project) {
  if (await exists(path.join(project, ".git"))) return false;
  await fs.mkdir(path.join(project, "src"), { recursive: true });
  for (const [name, text] of Object.entries(FILES)) await fs.writeFile(path.join(project, name), text);
  execFileSync("git", ["init", "-b", "main", project], { stdio: "ignore" });
  git(project, ["add", "."]);
  git(project, ["commit", "-m", "Create the demo project"]);
  for (const [name, text] of Object.entries(CHANGES)) await fs.writeFile(path.join(project, name), text);
  return true;
}

async function waitFor(read, what, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function seedChats(client, project) {
  const snapshot = () => client.call("project:snapshot", [project]);
  const { state } = await snapshot();
  if (state.messages.length) return false;
  const main = Object.values(state.worktrees).find((worktree) => worktree.path === project) ?? Object.values(state.worktrees)[0];
  for (const chat of CHATS) {
    const before = await snapshot();
    const known = new Set(Object.keys(before.state.sessions));
    const empty = Object.values(before.state.sessions).find((session) => !before.state.messages.some((message) => message.session_id === session.id));
    await client.call("chat:send", [
      {
        projectPath: project,
        ...(empty ? { sessionId: empty.id } : { worktreeId: main.id }),
        body: chat.body,
        provider: "codex",
        model: "demo",
        permissionMode: "ask",
      },
    ]);
    const sent = await snapshot();
    const session = empty ?? Object.values(sent.state.sessions).find((item) => !known.has(String(item.id)));
    const chatId = `${project}#${session.id}`;
    await waitFor(
      async () =>
        !(await client.call("chat:runs")).runs[chatId] &&
        (await snapshot()).state.messages.some((message) => message.session_id === session.id && message.role !== "user"),
      "the demo reply",
    );
    await client.call("chat:patch", [project, session.id, { title: chat.title }]);
    if (chat.note) await client.call("chat:git-note", [chatId, chat.note]);
  }
  return true;
}

async function writeLink(dataDir, link) {
  const file = path.join(dataDir, LINK_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${link}\n`, { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, file);
  return file;
}

async function startReviewDemo({ dataDir = DEFAULT_DATA_DIR, phoneOptions = {}, keepOpenMs = KEEP_OPEN_MS, log = console.log } = {}) {
  if (!path.isAbsolute(dataDir)) throw new Error("Pass an absolute --data-dir");
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  dataDir = await fs.realpath(dataDir);
  const project = path.join(dataDir, PROJECT_NAME);
  let daemon, client, timer;
  const close = async () => {
    clearInterval(timer);
    client?.close();
    await daemon?.close();
  };
  try {
    await seedProject(project);
    const runtimeOptions = demoRuntimeOptions({ cwd: project, worktreeRoot: path.join(project, ".milagre", "worktrees"), copy: COPY });
    daemon = await startDaemon({
      dataDir,
      version: `${version}-review-demo`,
      runtimeOptions,
      phoneOptions: { localPort: PHONE_PORT, lanPort: null, name: () => COMPUTER_NAME, ...phoneOptions, allowedRoot: project },
    });
    client = await connect({ dataDir });
    await client.call("project:open", [project]);
    if (await seedChats(client, project)) log(`Seeded ${CHATS.length} Chats in ${project}`);
    await client.call("phone:set-enabled", [true]);
    const status = await waitFor(
      async () => {
        const value = await client.call("phone:status");
        return ["on", "error"].includes(value.state) && value;
      },
      "the phone to start",
      30000,
    );
    if (status.state === "error") throw new Error(`The phone did not start: ${status.error}`);
    await client.call("phone:open-pairing");
    const linkFile = await writeLink(dataDir, status.pairingLink);
    timer = setInterval(() => {
      client.call("phone:open-pairing").catch((error) => log(`Could not reopen pairing: ${error.message}`));
    }, keepOpenMs);
    timer.unref?.();
    return { dataDir, project, link: status.pairingLink, linkFile, runtimeOptions, client, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

async function announce(
  demo,
  { log = console.log, isTTY = process.stdout.isTTY, renderQr = (text, done) => require("qrcode-terminal").generate(text, { small: true }, done) } = {},
) {
  log(`Milagre review demo is running.\nData: ${demo.dataDir}\nProject: ${demo.project}\nPairing link for App Review: ${demo.linkFile}`);
  if (!isTTY) return;
  await new Promise((resolve) =>
    renderQr(demo.link, (code) => {
      log(code);
      resolve();
    }),
  );
  log("This QR pairs a phone with this demo computer only, which opens nothing but its demo project.");
}

async function main() {
  const { values } = parseArgs({ options: { "data-dir": { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) {
    console.log(
      "npm run review:demo [-- --data-dir /absolute/path]\n\nA demo computer for App Review: a scripted agent, one demo project, paired through the relay.",
    );
    return;
  }
  const demo = await startReviewDemo({ dataDir: values["data-dir"] ? path.resolve(values["data-dir"]) : DEFAULT_DATA_DIR });
  await announce(demo);
  let stopping;
  const stop = (code) =>
    (stopping ??= (async () => {
      await demo.close().catch((error) => {
        console.error(error.message);
        code = 1;
      });
      process.exit(code);
    })());
  process.once("SIGINT", () => void stop(0));
  process.once("SIGTERM", () => void stop(0));
  // The daemon runs in this process; a lost connection means something is wrong, and launchd starts a fresh one.
  demo.client.once("close", () => {
    if (!stopping) {
      console.error("Lost the demo daemon. Exiting.");
      void stop(1);
    }
  });
}

if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
module.exports = { startReviewDemo, seedProject, announce, DEFAULT_DATA_DIR, PROJECT_NAME, PHONE_PORT, COMPUTER_NAME, LINK_FILE, KEEP_OPEN_MS };
