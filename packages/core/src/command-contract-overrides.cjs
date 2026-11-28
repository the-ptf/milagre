// Owner/transport operations without a desktop form. UI operations are generated from preload + bridge types.
const schedule = require("./command-contracts.json").commands["settings:notification-schedule"].parameters[0].schema;
const s = { type: "string" },
  b = { type: "boolean" },
  n = { type: "number" },
  any = {};
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const object = (properties, required = Object.keys(properties), additionalProperties = false) => ({
  type: "object",
  properties,
  required,
  additionalProperties,
});
const array = (items) => ({ type: "array", items });
const p = (name, schema = s, optional = false) => ({ name, schema, optional });
const request = (properties, required) => [p("request", object(properties, required))];
const mcpTarget = { enum: ["codex", "claude", "everywhere"] };
const mcpServer = {
  anyOf: [
    object({ name: s, type: { enum: ["http", "sse"] }, url: s, headers: object({}, [], s) }),
    object({ name: s, type: { const: "stdio" }, command: s, args: array(s), env: object({}, [], s) }),
  ],
};
const mcpPrevious = nullable(object({ name: s, target: mcpTarget }));
const scope = [p("scope")],
  project = [p("projectPath")];
module.exports = {
  "mcp:definition": [p("name"), p("target", mcpTarget)],
  "mcp:save": [p("def", mcpServer), p("target", mcpTarget), p("previous", mcpPrevious, true)],
  "mcp:saveUrl": [p("def", mcpServer), p("target", mcpTarget), p("previous", mcpPrevious, true)],
  "mcp:remove": [p("name"), p("target", mcpTarget)],
  "project:open": [p("folder"), p("options", object({ takeNotice: b }, []), true)],
  "chat:ports": [p("chatId")],
  "pr-reviews:report": [
    p(
      "report",
      object(
        {
          url: s,
          summary: s,
          findings: array(
            object({ path: s, line: n, severity: { enum: ["high", "medium", "low"] }, title: s, body: s, suggestion: s }, ["path", "severity", "title"]),
          ),
        },
        ["url", "findings"],
      ),
    ),
    p("chatId", nullable(s), true),
  ],
  "browser:open-page": request({ chatId: s, url: s }),
  "browser:page-url": request({ url: s }),
  "browser:release-page-url": request({ id: s }),
  "browser:keep-page-url": request({ id: s }),
  "chat:send-status": [p("projectPath"), p("clientMessageId")],
  "attachment:upload": request({ projectPath: s, name: s, base64: s, reuse: s, quota: n, transferId: s, offset: n, totalBytes: n }, ["projectPath"]),
  "chat:inbox": [],
  "connectors:call": [p("id"), p("name"), p("args", object({}, [], true), true)],
  // Designs are always on; older apps still save the old switch, which changes nothing.
  "designs:enabled:save": [p("value", b)],
  // Every computer runs Routines; older apps still save the old switch, which changes nothing.
  "routines:enabled:save": [p("value", b)],
  // A comment from the phone's view of a Browser panel page, at a point given as fractions of the page, or the phone's
  // queued comments on its own page views (`comments`), sent as one message.
  "browser-comments:send-from-page": request(
    {
      chatId: s,
      targetId: s,
      x: n,
      y: n,
      text: s,
      page: object({ url: s, title: s, element: any }),
      comments: array(object({ text: s, page: object({ url: s, title: s, element: any }) }, ["text", "page"])),
    },
    ["chatId"],
  ),
  // The desktop's Browser panel pages and their loopback DevTools endpoint; its main process sends them (browser-panel-pages.cjs).
  "browser:panel-pages": request({ port: n, prefix: s, pages: array(object({ id: s, chatId: s, title: s, url: s })) }, ["pages"]),
  // The Browser panel's sign-ins on this Mac and signing one out, forwarded to the desktop app (host-browser-sign-ins.cjs).
  "browser:sign-ins": [],
  "browser:sign-ins:clear": [p("computerId")],
  // What a restart to install an app update would stop; the desktop's updater asks (app-auto-update.cjs).
  "app-update:activity": [],
  // Closing the Mac's Linear sign-in window cancels through main, without a renderer bridge method.
  "linear:cancel": [],
  "link:workspace-roots": [p("requested")],
  "project:plain-root": [p("root")],
  "project:snapshot": project,
  "chat:all-messages": [...scope, p("options", object({ withState: b, marks: b }, []), true)],
  "project:chat-image": [...project, p("requested")],
  "project:worktree-paths": project,
  "project:find": [p("query", s, true)],
  "devices:take-notices": [],
  "devices:confirm-notices": [p("claim")],
  "peer:routes": [],
  // Another computer's daemon delegating to this Mac's Projects (spec 2026-10-23).
  "delegation:targets": [],
  "orchestrator:capacity": [],
  "orchestrator:memory:merge": [p("memory", any)],
  "orchestrator:start-here": request({ prompt: s, title: s, origin: s, role: s, reason: nullable(s) }, ["prompt", "title", "origin", "role"]),
  "delegation:prepare": request({ worktree: s, chat: s, mode: s, newWorktree: b }, ["worktree", "chat"]),
  "delegation:receive": request({ id: s, worktree: s, chat: s, message: s, mode: s, newWorktree: b, from: object({ label: s, computer: s }, []) }, [
    "id",
    "worktree",
    "chat",
    "message",
  ]),
  "delegation:reports": request({ ids: array(s) }),
  "delegation:collected": request({ ids: array(s) }),
  "push:register": request({ deviceId: s, token: s, hostId: s, notifyWhenWaiting: b, notifyOnCompletion: b, chime: s, schedule }, [
    "deviceId",
    "token",
    "hostId",
    "notifyWhenWaiting",
    "notifyOnCompletion",
  ]),
  "push:unregister": request({ deviceId: s }),
  "push:focus": request({ deviceId: s, chatId: nullable(s) }),
  "live-activity:state": request({ deviceId: s, mode: { enum: ["all", "questions"] } }, ["deviceId"]),
  "live-activity:open": request({ deviceId: s, target: s }),
  "live-activity:answer": request({ deviceId: s, target: s, position: n, option: n, mode: { enum: ["all", "questions"] } }, [
    "deviceId",
    "target",
    "position",
    "option",
  ]),
  "live-activity:forget": request({ deviceId: s }),
  "computers:vault-status": [],
  // The loopback SOCKS5 port a remote Chat's Browser pages reach the web through (browser-proxy.cjs).
  "computers:browser-proxy": [p("computerId")],
  // Main's Browser pages for Chats on other computers, with its DevTools proxy (computer-service.cjs).
  "computers:browser-pages": request({ port: n, prefix: s, pages: array(object({ id: s, chatKey: s, title: s, url: s }, ["id", "chatKey"])) }, ["pages"]),
  "computers:unlock": request({ key: s }),
  "computers:setup-key": request({ file: s }),
  "computers:import-keys": request({
    identity: nullable(object({ publicKey: s, secretKey: s })),
    computers: { type: "object", additionalProperties: object({ hostKey: s, token: s }) },
  }),
  "command:list": request({ chatId: s }),
  "command:describe": request({ chatId: s, name: s }),
  "command:run": request({ chatId: s, name: s, input: object({}, [], true) }, ["chatId", "name"]),
  "daemon:status": [p("options", object({ commands: b, computerManagement: b }, []), true)],
  "daemon:snapshot": [p("options", object({ paged: b }, []), true)],
  "daemon:snapshot-page": [p("pageId"), p("index", n)],
  "daemon:result-page": [p("pageId"), p("index", n)],
  "daemon:flush": [],
  "daemon:stop": [],
  "daemon:focus": request({ focused: b }),
  "daemon:state-patches": [p("options", object({ messages: b, transcripts: b, archivedSubagents: b }, []), true)],
  "desktop:register": request({ methods: array(s) }),
  "desktop:respond": request({ id: s, result: any, error: object({ message: s, code: s }, ["message"]) }, ["id"]),
  "desktop:invoke": request({ method: s, args: array(any) }),
  "secrets:digest": [],
  "secrets:push": request({ from: s, entries: array(any) }),
  "secrets:forget-from": request({ from: s }),
  "secrets:sharing": [],
  "secrets:share": request({ computer: s, on: b }),
};
