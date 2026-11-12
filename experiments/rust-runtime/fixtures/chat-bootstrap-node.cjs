// Pure real Node reconciliation over explicit synthetic discoveries. No runtime,
// filesystem discovery, providers, credentials, installation or network.
const { reconcileState } = require("../../../packages/core/src/project-state.cjs");
let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (part) => (text += part));
process.stdin.on("end", () => {
  const { state, project, name = "Rust Chat", worktreeName = "main" } = JSON.parse(text);
  const result = reconcileState(state, name, [{ path: project, name: worktreeName }], { platform: "darwin" });
  process.stdout.write(JSON.stringify(result));
});
