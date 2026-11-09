import { fileURLToPath } from "node:url";

export async function migrateActiveQuota({ account, namespace, apiToken, migrationToken, origin = "https://share.milagre.cloud", fetcher = fetch }) {
  if (new URL(origin).protocol !== "https:") throw Error("SHARE_ORIGIN must use HTTPS");
  const maintenance = async (path, body) => {
    const result = await fetcher(`${origin}/maintenance/${path}`, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${migrationToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    await result.body?.cancel();
    if (result.status !== 204) throw Error(`Migration ${path} failed (${result.status}); rerun before enabling publication`);
  };
  let cursor = "";
  let count = 0;
  const seen = new Set();
  for (;;) {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/workers/durable_objects/namespaces/${encodeURIComponent(namespace)}/objects`,
    );
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const result = await fetcher(url, { headers: { Authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(60000) });
    if (!result.ok) throw Error(`Namespace inventory failed (${result.status})`);
    const payload = await result.json();
    if (!payload.success || !Array.isArray(payload.result)) throw Error("Invalid namespace inventory response");
    for (const object of payload.result) {
      if (object.hasStoredData === false) continue;
      await maintenance("import", { objectId: object.id });
      count++;
    }
    const next = payload.result_info?.cursor;
    if (!next || !payload.result.length) break;
    if (seen.has(next)) throw Error("Namespace inventory repeated a cursor; migration not finalized");
    seen.add(next);
    cursor = next;
  }
  await maintenance("finish", {});
  return count;
}

const required = (name) => {
  if (!process.env[name]) throw Error(`Set ${name}`);
  return process.env[name];
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const count = await migrateActiveQuota({
    account: required("CLOUDFLARE_ACCOUNT_ID"),
    namespace: required("SHARE_PAGES_NAMESPACE_ID"),
    apiToken: required("CLOUDFLARE_API_TOKEN"),
    migrationToken: required("MIGRATION_TOKEN"),
    origin: process.env.SHARE_ORIGIN,
  });
  console.log(`Inventoried ${count} stored pages. Active quota enabled; remove the temporary MIGRATION_TOKEN secret.`);
}
