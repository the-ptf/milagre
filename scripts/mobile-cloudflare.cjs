const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { parseArgs } = require("node:util");
const { readCloudflare } = require("../apps/daemon/src/mobile-cloudflare.cjs");

const API = "https://api.cloudflare.com/client/v4/";

function client(token, fetcher = fetch) {
  return async (method, route, body) => {
    const response = await fetcher(API + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
    });
    const value = await response.json();
    if (!value.success)
      throw new Error(
        `Cloudflare ${method} ${route.split("?")[0]} failed: ${(value.errors || []).map((error) => error.message).join("; ") || response.status}`,
      );
    return value.result;
  };
}

async function setUpCloudflare({ token, domain, name = "mac", port = 8797, dataDir, fetcher }) {
  if (!token)
    throw new Error("Set CLOUDFLARE_API_TOKEN. It needs Cloudflare Tunnel, Access: Apps and Policies, Access: Service Tokens (account) and DNS (zone) edit.");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain || "")) throw new Error("Pass --domain, a domain whose DNS is on Cloudflare.");
  if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error("--name must be lowercase letters, digits and dashes.");
  const cf = client(token, fetcher);
  const zone = (await cf("GET", `zones?name=${encodeURIComponent(domain)}`))[0];
  if (!zone) throw new Error(`${domain} is not a zone this token can see.`);
  const account = zone.account.id;
  const hostname = `${name}.${domain}`;
  const tunnelName = `milagre-${name}`;
  const tunnel =
    (await cf("GET", `accounts/${account}/cfd_tunnel?is_deleted=false&name=${tunnelName}`))[0] ??
    (await cf("POST", `accounts/${account}/cfd_tunnel`, { name: tunnelName, config_src: "cloudflare", tunnel_secret: randomBytes(32).toString("base64") }));
  await cf("PUT", `accounts/${account}/cfd_tunnel/${tunnel.id}/configurations`, {
    config: {
      ingress: [{ hostname, service: `http://127.0.0.1:${port}`, originRequest: { httpHostHeader: `127.0.0.1:${port}` } }, { service: "http_status:404" }],
    },
  });
  const record = { type: "CNAME", name: hostname, content: `${tunnel.id}.cfargotunnel.com`, proxied: true };
  const existing = (await cf("GET", `zones/${zone.id}/dns_records?name=${hostname}`))[0];
  if (existing) await cf("PUT", `zones/${zone.id}/dns_records/${existing.id}`, record);
  else await cf("POST", `zones/${zone.id}/dns_records`, record);
  const connectorToken = await cf("GET", `accounts/${account}/cfd_tunnel/${tunnel.id}/token`);

  const file = path.join(dataDir, "cloudflare.json");
  let saved = {};
  try {
    saved = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {}
  const serviceName = `Milagre ${name}`;
  let service = (await cf("GET", `accounts/${account}/access/service_tokens`)).find((item) => item.name === serviceName);
  let secret = service && saved.access?.id === service.client_id ? saved.access.secret : undefined;
  if (!service)
    ({ client_secret: secret, ...service } = await cf("POST", `accounts/${account}/access/service_tokens`, { name: serviceName, duration: "8760h" }));
  // Cloudflare shows a secret once; without the saved one, a new secret replaces it and paired phones scan again.
  else if (!secret) secret = (await cf("POST", `accounts/${account}/access/service_tokens/${service.id}/rotate`)).client_secret;
  const app =
    (await cf("GET", `accounts/${account}/access/apps`)).find((item) => item.domain === hostname) ??
    (await cf("POST", `accounts/${account}/access/apps`, {
      type: "self_hosted",
      name: `Milagre ${name}`,
      domain: hostname,
      session_duration: "24h",
      service_auth_401_redirect: true,
      app_launcher_visible: false,
    }));
  const policies = await cf("GET", `accounts/${account}/access/apps/${app.id}/policies`);
  if (!policies.some((policy) => policy.include?.some((rule) => rule.service_token?.token_id === service.id))) {
    await cf("POST", `accounts/${account}/access/apps/${app.id}/policies`, {
      name: "Milagre devices",
      decision: "non_identity",
      include: [{ service_token: { token_id: service.id } }],
      precedence: policies.length + 1,
    });
  }

  const config = { hostname, port, tunnelId: tunnel.id, connectorToken, access: { id: service.client_id, secret } };
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(config, null, 2), { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return { ...config, file };
}

async function main() {
  const { values } = parseArgs({
    options: {
      domain: { type: "string" },
      name: { type: "string", default: "mac" },
      port: { type: "string", default: "8797" },
      "data-dir": { type: "string", default: path.join(os.homedir(), ".milagre-mobile") },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "CLOUDFLARE_API_TOKEN=... npm run mobile:cloudflare -- --domain example.com [--name mac] [--port 8797] [--data-dir /absolute/profile]\nCreates <name>.<domain>: a Cloudflare tunnel to this Mac, guarded by Cloudflare Access. Then run `npm run mobile:host -- --cloudflare`.",
    );
    return;
  }
  const result = await setUpCloudflare({
    token: process.env.CLOUDFLARE_API_TOKEN,
    domain: values.domain,
    name: values.name,
    port: Number(values.port),
    dataDir: values["data-dir"],
  });
  console.log(
    `Ready: https://${result.hostname} → 127.0.0.1:${result.port}, guarded by Cloudflare Access.\nSecrets saved to ${result.file}. Start the host with: npm run mobile:host -- --cloudflare`,
  );
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { setUpCloudflare, readCloudflare };
