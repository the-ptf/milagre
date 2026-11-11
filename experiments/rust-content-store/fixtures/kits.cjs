const fs = require("node:fs/promises");
const path = require("node:path");
const { createDesignKits } = require("../../../packages/core/src/design-kits.cjs");
(async () => {
  const root = path.resolve(process.argv[2]);
  await fs.access(path.join(root, "MILAGRE-ISOLATED-COPY"));
  const directory = path.join(root, "node-kits");
  const api = createDesignKits({
    directory,
    projectForChat: async (chat) => {
      if (["/one#1", "/one#2"].includes(chat)) return "/project/one";
      if (chat === "/two#1") return "/project/two";
      throw Error("Unknown Chat");
    },
  });
  const kit = {
    title: "Brand",
    colors: { paper: "#fff", ink: "#202720" },
    textStyles: { body: { fontSize: 16, fontFamily: "Inter" } },
    spacing: { base: 8 },
    radii: { control: 6 },
    components: {
      button: [
        { id: "button", type: "frame", width: 100, height: 40, component: true },
        { id: "label", type: "text", parentId: "button", width: 80, height: 30, text: "Save", textStyle: "body" },
      ],
    },
  };
  const actions = [
    ["read", { chatId: "/one#1" }],
    ["save", { chatId: "/one#1", expectedVersion: 0, kit }],
    ["read", { chatId: "/one#2" }],
    ["read", { chatId: "/two#1" }],
    ["save", { chatId: "/one#2", expectedVersion: 1, kit: { ...kit, title: "Revision 2" } }],
    ["read", { chatId: "/one#1", version: 1 }],
    ["read", { chatId: "/one#1", version: 3 }],
    ["save", { chatId: "/one#1", expectedVersion: 1, kit }],
    ["save", { chatId: "/one#1", id: "invalid/id", expectedVersion: 0, kit }],
    ["save", { chatId: "/unknown#1", expectedVersion: 0, kit }],
    [
      "save",
      {
        chatId: "/one#1",
        id: "no-main",
        expectedVersion: 0,
        kit: { ...kit, components: { button: [{ id: "button", type: "frame", width: 20, height: 20 }] } },
      },
    ],
    ["save", { chatId: "/two#1", expectedVersion: 0, kit }],
    ["read", { chatId: "/one#1", id: "missing", version: 1 }],
  ];
  for (let index = 0; index < 101; index++)
    actions.push(["save", { chatId: "/one#1", id: "history", expectedVersion: index, kit: { ...kit, title: `Version ${index + 1}` } }]);
  const outputs = [];
  for (const [method, args] of actions) {
    try {
      outputs.push({ result: await api[method](args) });
    } catch (error) {
      outputs.push({ error: error.message });
    }
  }
  const files = {};
  for (const project of await fs.readdir(directory)) {
    for (const name of await fs.readdir(path.join(directory, project)))
      files[`${project}/${name}`] = JSON.parse(await fs.readFile(path.join(directory, project, name), "utf8"));
  }
  process.stdout.write(JSON.stringify({ actions, outputs, files }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
