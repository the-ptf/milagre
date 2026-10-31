// Run with npm test -- --only new-chat-computers. A new Chat's Project on several computers, in Electron against a
// stand-in for the bridges: the heading's picker lists one row per Git origin ("3 computers") and every Project a computer
// knows (project:known), not only its recent ones; the composer row has a computer chip for every Project whose picker
// moves the new Chat to another computer's copy (an offline one is disabled), and picking the Project again opens on the
// computer last chosen for it. Set MILAGRE_SCREENSHOT_DIR to save screenshots.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { useAsyncMiddleware } = require("./async-middleware.cjs");
const { ThisComputer } = require("@milagre/shared/host-computer");

const fixture = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { NewChatHeading } from "/src/components/NewChatHeading";
import { NewChatHeader } from "/src/components/ChatComposer";
import { useProjectGroups } from "/src/lib/project-copies";
import { updateSettings } from "/src/lib/settings";
import "/src/styles.css";
const ORIGIN = "github.com/the-ptf/milagre-ade";
const qualify = (id, projects) => projects.map((project) => ({ ...project, path: id + "|" + project.path }));
// \`known\`: what project:known answers, every Project the computer knows; without it the computer predates the command.
const remote = (id, recent, known) => ({
  listRecentProjects: async () => qualify(id, recent),
  ...(known ? { listKnownProjects: async () => qualify(id, known) } : {}),
  listNamedLinks: async () => [],
  getProjectImage: async () => null,
});
const MILAGRE_ON_ARKETA = { path: "/Users/a/work/milagre-ade", name: "milagre-ade", openedAt: "", origin: ORIGIN };
const bridges = {
  // billing is no longer among arketa's recent Projects: only project:known offers it.
  "c-arketa": remote("c-arketa", [MILAGRE_ON_ARKETA], [MILAGRE_ON_ARKETA, { path: "/Users/a/work/billing", name: "billing", openedAt: "", origin: "github.com/arketa/billing" }]),
  "c-studio": remote("c-studio", [{ path: "/Users/s/milagre-ade", name: "milagre-ade", openedAt: "", origin: ORIGIN }]),
};
const computer = (id, name, state) => ({ id, name, hostId: id.padEnd(22, "x"), relayHost: "relay.milagre.cloud", state, route: state === "online" ? "lan" : null, lastSeen: Date.now(), addedAt: 1, message: null, lan: false, lanRoutes: [] });
window.moves = [];
window.milagre = {
  listRecentProjects: async () => [
    { path: "/Users/v/Code/milagre-ade", name: "milagre-ade", openedAt: "", origin: ORIGIN },
    { path: "/Users/v/Code/website", name: "website", openedAt: "" },
  ],
  getProjectImage: async () => null,
  on: (id) => bridges[id] ?? {},
  onComputersChanged: () => () => {},
  computers: { list: async () => ({ thisMac: "victor-mbp", computers: [computer("c-arketa", "arketa", "online"), computer("c-studio", "studio", "offline")] }) },
};
updateSettings({ otherComputers: true });
function Fixture() {
  const [key, setKey] = useState("/Users/v/Code/milagre-ade");
  const name = { "/Users/v/Code/website": "website", "c-arketa|/Users/a/work/billing": "billing" }[key] ?? "milagre-ade";
  const groups = useProjectGroups(true, key, name);
  const copies = groups.find((group) => group.copies.some((copy) => copy.key === key))?.copies ?? [];
  const move = (next) => (window.moves.push(next), setKey(next));
  return (
    <div style={{ width: 640, margin: "80px auto", display: "flex", flexDirection: "column", gap: 260 }}>
      <NewChatHeading projectKey={key} projectName={name} groups={groups} onProjectChange={move} />
      <NewChatHeader
        worktrees={[{ id: 1, name: "main", path: key }]}
        selectedWorktreeId={1}
        onWorktreeChange={() => {}}
        isolation="worktree"
        onIsolationChange={() => {}}
        branches={["main"]}
        baseBranch="main"
        onBaseBranchChange={() => {}}
        copies={copies}
        currentKey={key}
        onComputerChange={move}
      />
    </div>
  );
}
createRoot(document.getElementById("root")).render(<Fixture />);
`;

async function browserChecks() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "milagre-new-chat-computers-")));
  await app.whenReady();
  const window = new BrowserWindow({ width: 960, height: 760, show: false, webPreferences: { backgroundThrottling: false } });
  const evaluate = (source) => window.webContents.executeJavaScript(source);
  const errors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  const waitFor = async (source) => {
    for (let i = 0; i < 200; i++) {
      if (await evaluate(source)) return;
      await delay(25);
    }
    throw new Error(`Timed out: ${source}`);
  };
  const screenshot = async (name) => {
    if (!process.env.MILAGRE_SCREENSHOT_DIR) return;
    fs.mkdirSync(process.env.MILAGRE_SCREENSHOT_DIR, { recursive: true });
    window.webContents.invalidate();
    await delay(250);
    fs.writeFileSync(path.join(process.env.MILAGRE_SCREENSHOT_DIR, name + ".png"), (await window.webContents.capturePage()).toPNG());
  };
  try {
    await window.loadURL(process.argv[2]);
    const heading = () => evaluate(`document.querySelector("[data-new-chat-project]").textContent`);
    const chip = () => evaluate(`[...document.querySelectorAll("[data-new-chat-pickers] button[aria-expanded]")].map((button) => button.textContent)`);
    const pickRow = (scope, label) =>
      evaluate(
        `[...document.querySelectorAll(${JSON.stringify(`${scope} [data-picker-row]`)})].find((row) => row.querySelector("strong").textContent === ${JSON.stringify(label)}).click()`,
      );

    // One row per repository; the heading leaves the computer to the chip once the Project is on several.
    await waitFor(`document.querySelectorAll("[data-new-chat-pickers] button[aria-expanded]").length === 3`);
    assert.equal(await heading(), "milagre-ade");
    assert.deepEqual(await chip(), ["victor-mbp", "New worktree", "main"]);
    await evaluate(`document.querySelector("[data-new-chat-project]").click()`);
    await waitFor(`document.querySelectorAll("[data-new-chat-heading] [data-picker-row]").length === 3`);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll("[data-new-chat-heading] [data-picker-row]")].map((row) => row.textContent)`), [
      "Mmilagre-ade3 computers",
      "Wwebsite",
      "Bbillingarketa",
    ]);
    await screenshot("new-chat-project-picker");
    console.log("PASS: the Project picker shows a repository on three computers as one row");

    // The chip lists every copy: This Mac's checked, an offline one disabled; a pick moves the new Chat there.
    await evaluate(`document.querySelector("[data-new-chat-project]").click()`);
    await evaluate(`[...document.querySelectorAll("[data-new-chat-pickers] button[aria-expanded]")][0].click()`);
    await waitFor(`document.querySelectorAll("[data-new-chat-pickers] [data-picker-row]").length === 3`);
    assert.deepEqual(
      await evaluate(`[...document.querySelectorAll("[data-new-chat-pickers] [data-picker-row]")].map((row) => [row.textContent, row.disabled])`),
      [
        [`victor-mbp · ${ThisComputer}~/Code/milagre-ade`, false],
        ["arketa~/work/milagre-ade", false],
        ["studio~/milagre-adeOffline", true],
      ],
    );
    await screenshot("new-chat-computer-chip");
    await pickRow("[data-new-chat-pickers]", "arketa");
    await waitFor(`window.moves.at(-1) === "c-arketa|/Users/a/work/milagre-ade"`);
    await waitFor(`document.querySelector("[data-new-chat-pickers] button[aria-expanded]").textContent === "arketa"`);
    assert.equal(await heading(), "milagre-ade");
    console.log("PASS: the computer chip moves the new Chat to another computer's copy, and an offline one is disabled");

    // Another Project, then this one again: it opens on arketa, the computer last chosen for it.
    await evaluate(`document.querySelector("[data-new-chat-project]").click()`);
    await waitFor(`document.querySelectorAll("[data-new-chat-heading] [data-picker-row]").length === 3`);
    await pickRow("[data-new-chat-heading]", "website");
    await waitFor(`window.moves.at(-1) === "/Users/v/Code/website"`);
    await waitFor(`document.querySelector("[data-new-chat-pickers] button[aria-expanded]").textContent === "victor-mbp"`);
    assert.deepEqual(await chip(), ["victor-mbp", "New worktree", "main"]);
    assert.equal(await heading(), "website");
    await evaluate(`document.querySelector("[data-new-chat-project]").click()`);
    await waitFor(`document.querySelectorAll("[data-new-chat-heading] [data-picker-row]").length === 3`);
    await pickRow("[data-new-chat-heading]", "milagre-ade");
    await waitFor(`window.moves.at(-1) === "c-arketa|/Users/a/work/milagre-ade"`);
    // A Project on one other computer names it in the chip, never the heading.
    await evaluate(`document.querySelector("[data-new-chat-project]").click()`);
    await waitFor(`document.querySelectorAll("[data-new-chat-heading] [data-picker-row]").length === 3`);
    await pickRow("[data-new-chat-heading]", "billing");
    await waitFor(`window.moves.at(-1) === "c-arketa|/Users/a/work/billing"`);
    await waitFor(`document.querySelector("[data-new-chat-pickers] button[aria-expanded]").textContent === "arketa"`);
    assert.equal(await heading(), "billing");
    assert.deepEqual(errors, []);
    console.log("PASS: picking the Project again opens on the computer last chosen, and a one-computer Project has a chip too");
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(errors);
    await screenshot("failure").catch(() => {});
    app.exit(1);
  }
}

async function main() {
  const { createServer } = await import("vite");
  const server = await createServer({
    configFile: path.resolve(__dirname, "../apps/desktop/vite.config.ts"),
    cacheDir: path.resolve(__dirname, "../node_modules/.vite-new-chat-computers"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "new-chat-computers-fixture",
        resolveId(id) {
          if (id === "/__new-chat-computers.tsx") return id;
        },
        load(id) {
          if (id === "/__new-chat-computers.tsx") return fixture;
        },
        transform(source, id) {
          if (id.endsWith("/components/ChatComposer.tsx")) return source + "\nexport { NewChatHeader };\n";
        },
        configureServer(server) {
          useAsyncMiddleware(server.middlewares, async (request, response, next) => {
            if (request.url !== "/__new-chat-computers") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html><body><div id="root"></div><script type="module" src="/__new-chat-computers.tsx"></script></body></html>',
              ),
            );
          });
        },
      },
    ],
  });
  try {
    await server.listen();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require("node:child_process").spawn(require("electron"), [path.resolve(__filename), `${server.resolvedUrls.local[0]}__new-chat-computers`], {
      env,
      stdio: "inherit",
    });
    process.exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    await server.close();
  }
}
(process.versions.electron ? browserChecks() : main()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
