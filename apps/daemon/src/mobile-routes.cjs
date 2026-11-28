const { isSealed } = require("./sealed-channel.cjs");
const { isSecretRequest } = require("@milagre/core/chat-secrets");
const { isLinkScopeKey } = require("@milagre/shared/chat-scopes");
const { chatsNeedingAttention } = require("@milagre/shared/attention");
const { secretAnswerFlag } = require("@milagre/shared/agent-runs");
const { METHODS } = require("./mobile-methods.cjs");
const {
  failure,
  forPhone,
  phoneMessage,
  withoutMessages,
  forNewWorktree,
  forChatList,
  runsForPhone,
  projectRuns,
  projectRunsForPhone,
  requestedRunChats,
} = require("./mobile-projections.cjs");

const MAX_BODY = 1024 * 1024;
const MAX_CHAT_LISTS = 20;
const CHAT_LIST_READS = 4;

async function readJsonBody(req, limit) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw failure(415, "Use application/json");
  if (Number(req.headers["content-length"]) > limit) throw failure(413, "Request exceeds the upload limit");
  let size = 0;
  const chunks = [];
  const body = await new Promise((resolve, reject) => {
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(failure(413, "Request exceeds the upload limit"));
        return;
      }
      chunks.push(chunk);
    });
    req.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.once("error", reject);
    req.once("aborted", () => reject(failure(400, "Request was interrupted")));
  });
  try {
    return JSON.parse(body);
  } catch {
    throw failure(400, "Invalid JSON");
  }
}

function withoutHiddenArgs(request) {
  if (request.method === "agent:answer-question" && request.args[0] && typeof request.args[0] === "object" && "secretAnswer" in request.args[0]) {
    const { secretAnswer: _secret, ...rest } = request.args[0];
    return [rest, ...request.args.slice(1)];
  }
  return (request.method === "link:update" || request.method === "link:create") &&
    request.args[0] &&
    typeof request.args[0] === "object" &&
    !Array.isArray(request.args[0]) &&
    "hidden" in request.args[0]
    ? [
        (() => {
          const { hidden: _hidden, ...rest } = request.args[0];
          return rest;
        })(),
        ...request.args.slice(1),
      ]
    : request.args;
}

/** What the phone gets back from an RPC: the Mac's hidden flags left out, and opened Projects reduced to what it reads next. */
const withoutHint = (secret) => (secret && typeof secret === "object" && "hint" in secret ? { ...secret, hint: null } : secret);

function phoneReply(method, value) {
  let result = value;
  if (method.startsWith("secrets:")) return Array.isArray(result) ? result.map(withoutHint) : withoutHint(result);
  if ((method === "project:recent" || method === "project:forget" || method === "link:list") && Array.isArray(result))
    result = result.map((item) => {
      if (!item || typeof item !== "object" || !("hidden" in item)) return item;
      const { hidden: _hidden, ...rest } = item;
      return rest;
    });
  if ((method === "link:create" || method === "link:update") && result && typeof result === "object" && "hidden" in result) {
    const { hidden: _hidden, ...rest } = result;
    result = rest;
  }
  if ((method === "project:open" || method === "onboarding:clone" || method === "chats:ensure") && result && typeof result === "object")
    result = { path: result.path, name: result.name, ...(result.kind ? { kind: result.kind } : {}) };
  if (method === "link:open" && result?.link) result = { id: result.link.id, name: result.link.name };
  if (method === "worktree:create" && result?.project?.state) result = { ...result, project: forNewWorktree(result.project, result.worktreeId) };
  return result;
}

const masksAnswer = (runs, requestId) =>
  Object.values(runs ?? {}).some((run) => run?.questions?.some((question) => question.requestId === requestId && secretAnswerFlag(question).secretAnswer));

/**
 * A secret value in a phone call: every bridge takes it only through the sealed channel, unless a development host opts
 * out. A masked question is known by the question this computer holds, whatever the phone says about it.
 */
async function carriesSecret(request, hostRuns) {
  if (request.method === "secrets:set") return true;
  if (request.method !== "agent:answer-question") return false;
  const requestId = request.args[0]?.requestId;
  return isSecretRequest(requestId) || request.args[0]?.secretAnswer === true || masksAnswer((await hostRuns.read()).runs, requestId);
}

function createMobileRoutes({
  readScope,
  hostRuns,
  withMessages,
  numberSnapshot,
  chatListOf,
  confine,
  validScope,
  client,
  scopeRoots,
  attachmentQuota,
  phoneRoutes,
  serveMedia,
}) {
  const get = {
    "/media": async ({ target, res }) => {
      await serveMedia(target, res);
      return;
    },
    "/snapshot": async ({ target, req, reply }) => {
      const projectPath = target.searchParams.get("projectPath");
      const [held, runs] = await Promise.all([readScope(projectPath), hostRuns.read()]);
      if (!held.link && target.searchParams.get("view") === "chats") {
        const { project } = await withMessages(projectPath, held, { marks: true });
        reply(200, { result: forChatList(project, projectRuns(runs, projectPath)) }, { etag: true });
        return;
      }
      const pages = req.headers["x-milagre-chat-pages"] === "1";
      const scope = pages ? held : await withMessages(projectPath, held);
      const slim = scope.link ? { link: forPhone(scope.link) } : { project: forPhone(scope.project) };
      const result = { ...(pages ? withoutMessages(slim) : slim), runs: runsForPhone(projectRuns(runs, projectPath)) };
      const since = req.headers["x-milagre-snapshot-since"];
      if (typeof since !== "string") reply(200, { result }, { etag: true });
      else reply(200, { result: numberSnapshot(pages ? `${projectPath}#pages` : projectPath, result, since) });
      return;
    },
    "/chat-lists": async ({ target, reply }) => {
      let paths;
      try {
        paths = JSON.parse(target.searchParams.get("paths") ?? "");
      } catch {
        throw failure(400, "Choose the Projects as a JSON list");
      }
      if (!Array.isArray(paths) || !paths.length || !paths.every((item) => typeof item === "string"))
        throw failure(400, "Choose the Projects as a JSON list of paths");
      if (paths.length > MAX_CHAT_LISTS) throw failure(400, `Choose at most ${MAX_CHAT_LISTS} Projects`);
      const runs = await hostRuns.read();
      const projects = [...new Set(paths)];
      const result = {};
      const read = async (projectPath) => {
        try {
          if (isLinkScopeKey(projectPath)) throw failure(400, "Chats of a Link are not listed here");
          result[projectPath] = await chatListOf(projectPath, runs);
        } catch (error) {
          result[projectPath] = { error: error.message };
        }
      };
      for (let at = 0; at < projects.length; at += CHAT_LIST_READS) await Promise.all(projects.slice(at, at + CHAT_LIST_READS).map(read));
      reply(200, { result }, { etag: true });
      return;
    },
    "/chat-messages": async ({ target, reply }) => {
      const owner = target.searchParams.get("projectPath");
      await confine?.check(owner);
      if (!validScope(owner)) throw failure(400, "Choose a valid Project or Link");
      const number = (name) => (target.searchParams.has(name) ? Number(target.searchParams.get(name)) : undefined);
      const page = await client.call("chat:messages", [owner, number("chatId"), { before: number("before"), turns: number("turns") }]);
      reply(200, { result: { ...page, messages: page.messages.map(phoneMessage) } });
      return;
    },
    "/search": async ({ target, reply }) => {
      const owner = target.searchParams.get("projectPath");
      await confine?.check(owner);
      if (!validScope(owner)) throw failure(400, "Choose a valid Project or Link");
      reply(200, { result: await client.call("chat:search", [owner, target.searchParams.get("q") ?? "", { limit: 200 }]) });
      return;
    },
    "/search-all": async ({ target, reply }) => {
      const scope = target.searchParams.get("projectPath") || undefined;
      if (scope !== undefined) {
        await confine?.check(scope);
        if (!validScope(scope)) throw failure(400, "Choose a valid Project or Link");
      }
      const options = { scope, archived: target.searchParams.get("archived") === "1", limit: 100 };
      const found = await client.call("chats:search", [target.searchParams.get("q") ?? "", options]);
      reply(200, { result: confine ? await confine.filterResult("chats:search", found) : found });
      return;
    },
    "/runs": async ({ target, reply }) => {
      const projectPath = target.searchParams.get("projectPath");
      if (!validScope(projectPath)) throw failure(400, "Choose a valid Project or Link");
      await confine?.check(projectPath);
      const chats = requestedRunChats(target.searchParams);
      reply(200, { result: projectRunsForPhone(await hostRuns.read(), projectPath, chats) }, { etag: true });
      return;
    },
    "/attention": async ({ reply }) => {
      reply(200, { result: confine ? [] : chatsNeedingAttention((await hostRuns.read()).runs) }, { etag: true });
      return;
    },
    "/inbox": async ({ reply }) => {
      const inbox = await client.call("chat:inbox");
      reply(200, { result: confine ? await confine.filterResult("chat:inbox", inbox) : inbox }, { etag: true });
      return;
    },
    "/message": async ({ target, reply }) => {
      const owner = target.searchParams.get("projectPath");
      await confine?.check(owner);
      if (!validScope(owner)) throw failure(400, "Choose a valid Project or Link");
      let message;
      try {
        message = await client.call("chat:message", [owner, Number(target.searchParams.get("id"))]);
      } catch (error) {
        if (/no longer in this Project/.test(error.message)) throw failure(404, "That message is no longer in this Project.");
        throw error;
      }
      reply(200, { result: message });
      return;
    },
  };
  async function post({ target, req }) {
    let result;
    const request = await readJsonBody(req, target.pathname === "/attachments" ? 7 * MAX_BODY : MAX_BODY);
    if (target.pathname === "/attachments") {
      const { projectPath, name, base64, reuse, transferId, offset, totalBytes } = request || {};
      if (typeof projectPath !== "string") throw failure(400, "Invalid attachment");
      await confine?.check(projectPath);
      await scopeRoots(projectPath);
      const outcome = await client.call("attachment:upload", [
        { projectPath, name, base64, reuse, transferId, offset, totalBytes, ...(confine ? { quota: attachmentQuota } : {}) },
      ]);
      if (outcome.error) throw failure(outcome.error.status, outcome.error.message);
      result = outcome.file;
    } else {
      if (request?.v !== 1 || typeof request.method !== "string" || !Array.isArray(request.args))
        throw failure(400, "Expected version 1, method and args array");
      if (request.method === "phone:routes") {
        if (!phoneRoutes || confine) throw failure(403, "Command is not available from mobile");
        result = await phoneRoutes(request.args[0]?.phoneKey);
      } else {
        if (!METHODS.has(request.method)) throw failure(403, "Command is not available from mobile");
        if (request.method === "secrets:set" && request.args[0]?.file !== undefined) throw failure(403, "The phone can't read files on this computer");
        if (!isSealed(req) && (await carriesSecret(request, hostRuns)) && process.env.MILAGRE_DEV_PLAIN_SECRETS !== "1")
          throw failure(403, "Secrets travel only over Milagre's encrypted connection (relay, local network or Tailscale), not through a tunnel or proxy.");
        const args = withoutHiddenArgs(request);
        if (confine) {
          const decided = await confine.checkCall(request.method, args);
          result = "result" in decided ? decided.result : await confine.filterResult(request.method, await client.call(request.method, decided.args));
        } else result = await client.call(request.method, args);
      }
      result = phoneReply(request.method, result);
    }
    return result;
  }
  return { get, post };
}

module.exports = { createMobileRoutes, phoneReply, carriesSecret };
