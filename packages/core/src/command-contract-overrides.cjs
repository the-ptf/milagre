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
const scope = [p("scope")],
  project = [p("projectPath")];
module.exports = {
  "project:open": [p("folder"), p("options", object({ takeNotice: b }, []), true)],
  "chat:ports": [p("chatId")],
  "browser:open-page": request({ chatId: s, url: s }),
  "chat:send-status": [p("projectPath"), p("clientMessageId")],
  "attachment:upload": request({ projectPath: s, name: s, base64: s, reuse: s, quota: n, transferId: s, offset: n, totalBytes: n }, ["projectPath"]),
  "chat:inbox": [],
  // Designs are always on; older apps still save the old switch, which changes nothing.
  "designs:enabled:save": [p("value", b)],
  // Every computer runs Routines; older apps still save the old switch, which changes nothing.
  "routines:enabled:save": [p("value", b)],
  // A comment from the phone's view of a Browser panel page, at a point given as fractions of the page.
  "browser-comments:send-from-page": request({ chatId: s, targetId: s, x: n, y: n, text: s }, ["chatId", "x", "y", "text"]),
  // The desktop's Browser panel pages and their loopback DevTools endpoint; its main process sends them (browser-panel-pages.cjs).
  "browser:panel-pages": request({ port: n, prefix: s, pages: array(object({ id: s, chatId: s, title: s, url: s })) }, ["pages"]),
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
  "delegation:prepare": request({ worktree: s, chat: s, mode: s }, ["worktree", "chat"]),
  "delegation:receive": request({ id: s, worktree: s, chat: s, message: s, mode: s, from: object({ label: s, computer: s }, []) }, [
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
};
