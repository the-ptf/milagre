#!/usr/bin/env node
// Actual Node ChatHost/ProjectStates, image-input and project-content methods. Synthetic startTurn only; no native
// provider, profile or discovery. Scratch files are created here and removed in finally. Rust compares this fresh
// output with its own saved metadata and queued payloads, separately testing its intentionally tighter admission.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { createHash } = require("node:crypto");
const repo = path.resolve(__dirname, "../../..");
// oxlint-disable-next-line no-underscore-dangle
const resolveModule = Module._resolveFilename;
// oxlint-disable-next-line no-underscore-dangle
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith("@milagre/shared/")) return path.join(repo, "packages/shared/src", `${request.slice("@milagre/shared/".length)}.mjs`);
  return resolveModule.call(this, request, parent, ...rest);
};
const { ChatHost } = require(path.join(repo, "packages/core/src/agents/chat-host.cjs"));
const { ProjectStates } = require(path.join(repo, "packages/core/src/project-states.cjs"));
const { storeImages } = require(path.join(repo, "packages/core/src/project-content.cjs"));
const { decodeImages } = require(path.join(repo, "packages/core/src/image-input.cjs"));
const image = {
  id: "image-1",
  name: "tiny.png",
  path: "/never/read/upload.png",
  sourcePath: "",
  extra: { kept: true },
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
};

async function main() {
  const project = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "milagre-owner-images-node-")));
  let states;
  try {
    const normalize = (value) => JSON.parse(JSON.stringify(value).split(project).join("<project>"));
    const seed = { next_id: 10, worktrees: { 1: { id: 1, name: "main", path: project } }, sessions: { 1: { id: 1, worktree_id: 1 } }, messages: [] };
    const turns = [];
    states = new ProjectStates({ read: async () => structuredClone(seed), save: async () => {} });
    const host = new ChatHost({
      states,
      startTurn: async (request) => {
        turns.push(request);
        return { turnId: `turn-${turns.length}`, steered: false };
      },
      publish: () => {},
      broadcast: () => {},
    });
    const request = { projectPath: project, sessionId: 1, provider: "claude", model: "fixture", body: "", images: [image], clientMessageId: "direct" };
    const first = await host.send(request);
    await first.started;
    const direct = (await states.get(project)).messages.find((message) => message.clientMessageId === "direct").images;
    await host.receive(`${project}#1`, { type: "session-started", nativeId: "synthetic-native" });
    const queued = await host.send({ ...request, body: "queued", delivery: "queue", clientMessageId: "queued" });
    const queuedStored = (await states.get(project)).sessions[1].queued[0].images;
    await host.receive(`${project}#1`, { type: "turn-completed" });
    await queued.started;
    const queuedSent = (await states.get(project)).messages.find((message) => message.clientMessageId === "queued").images;
    const duplicate = await host.send({ ...request, images: [{ path: "/not/read" }] });
    const files = await fs.readdir(path.join(project, ".milagre/images"));
    const validations = [];
    for (const images of [null, [{ path: "/not/read" }], [{ dataUrl: "data:image/png;base64,AAAA" }], [image, { dataUrl: "bad" }]]) {
      try {
        await storeImages(project, images);
        validations.push(null);
      } catch (error) {
        validations.push(error.message);
      }
    }
    const sources = {};
    for (const source of ["packages/core/src/image-input.cjs", "packages/core/src/project-content.cjs", "packages/core/src/agents/chat-host.cjs"]) {
      sources[source] = createHash("sha256")
        .update(await fs.readFile(path.join(repo, source)))
        .digest("hex");
    }
    return normalize({
      sources,
      image,
      direct,
      queuedStored,
      queuedSent,
      prompts: turns.map((turn) => turn.prompt),
      payloads: turns.map((turn) => decodeImages(turn.images).map(({ mime, bytes }) => ({ mime, sha256: createHash("sha256").update(bytes).digest("hex") }))),
      duplicate: duplicate.duplicate,
      turns: turns.length,
      files,
      validations,
    });
  } finally {
    await states?.close();
    await fs.rm(project, { recursive: true, force: true });
  }
}
main()
  .then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
