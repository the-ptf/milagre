// A stand-in for Antigravity's sign-in: answers `initialize`, and `authenticate` at once when GEMINI_HOME
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createInterface } = require("node:readline");

const home = process.env.GEMINI_HOME;
const scenario = process.env.FAKE_AGY_SCENARIO || "ok";
const token = path.join(home, "antigravity-acp", "acp_token.json");
fs.writeFileSync(
  path.join(home, "fake-agy-env.json"),
  JSON.stringify({
    BROWSER: process.env.BROWSER,
    TMPDIR: process.env.TMPDIR,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    AGY_ACP_FORCE_FILE_STORAGE: process.env.AGY_ACP_FORCE_FILE_STORAGE,
    pid: process.pid,
  }),
);

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

function authenticate(id) {
  if (fs.existsSync(token)) return send({ id, result: {} });
  const server = http.createServer((request, response) => {
    response.end("ok");
    server.close();
    if (scenario === "subscription") return send({ id, error: { code: -32603, message: "SUBSCRIPTION_REQUIRED: no eligible plan" } });
    fs.mkdirSync(path.dirname(token), { recursive: true });
    const claims = Buffer.from(JSON.stringify({ email: "person@example.test", sub: "1" })).toString("base64url");
    fs.writeFileSync(token, JSON.stringify({ refresh_token: "secret-refresh", id_token: `h.${claims}.sig` }));
    send({ id, result: {} });
  });
  server.listen(0, "127.0.0.1", () => {
    const redirect = `http://127.0.0.1:${server.address().port}/`;
    const url =
      scenario === "bad-url"
        ? `https://evil.example/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(redirect)}`
        : `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=x&redirect_uri=${encodeURIComponent(redirect)}&scope=openid`;
    process.stdout.write("not json\n");
    process.stderr.write(`Open the following link to authenticate the ACP server: ${url}\n`);
  });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentInfo: { name: "antigravity-acp", version: "fake" } } });
  else if (message.method === "authenticate") authenticate(message.id);
});
