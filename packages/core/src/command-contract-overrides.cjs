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
  "chat:send-status": [p("projectPath"), p("clientMessageId")],
  "attachment:upload": request({ projectPath: s, name: s, base64: s, reuse: s, quota: n }, ["projectPath"]),
  "chat:inbox": [],
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
