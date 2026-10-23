import assert from "node:assert/strict";
import { test } from "node:test";
import { migrateActiveQuota } from "../scripts/migrate-active-quota.mjs";

const options = { account: "account", namespace: "namespace", apiToken: "cloudflare-secret", migrationToken: "migration-secret" };

test("inventory follows cursors, imports stored objects, and finalizes only after all imports", async () => {
  const calls = [];
  const count = await migrateActiveQuota({
    ...options,
    fetcher: async (input, init) => {
      const url = new URL(input);
      if (url.hostname === "api.cloudflare.com") {
        assert.equal(init.headers.Authorization, "Bearer cloudflare-secret");
        return Response.json({
          success: true,
          result: [
            { id: url.searchParams.get("cursor") ? "second" : "first", hasStoredData: true },
            { id: "empty", hasStoredData: false },
          ],
          result_info: url.searchParams.get("cursor") ? {} : { cursor: "next" },
        });
      }
      assert.equal(init.headers.Authorization, "Bearer migration-secret");
      assert.equal(init.redirect, "error");
      calls.push([url.pathname, JSON.parse(init.body)]);
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(count, 2);
  assert.deepEqual(calls, [
    ["/maintenance/import", { objectId: "first" }],
    ["/maintenance/import", { objectId: "second" }],
    ["/maintenance/finish", {}],
  ]);
});

test("failed inventory or import never enables uploads", async () => {
  for (const failingStage of ["inventory", "import"]) {
    let finalized = false;
    await assert.rejects(
      migrateActiveQuota({
        ...options,
        fetcher: async (input) => {
          const url = new URL(input);
          if (url.hostname === "api.cloudflare.com") {
            if (failingStage === "inventory") return new Response(null, { status: 503 });
            return Response.json({ success: true, result: [{ id: "page", hasStoredData: true }] });
          }
          if (url.pathname.endsWith("finish")) finalized = true;
          return new Response(null, { status: 503 });
        },
      }),
    );
    assert.equal(finalized, false);
  }
});

test("repeated cursors fail closed instead of finalizing an incomplete inventory", async () => {
  await assert.rejects(
    migrateActiveQuota({
      ...options,
      fetcher: async (input) => {
        const url = new URL(input);
        if (url.hostname === "api.cloudflare.com") return Response.json({ success: true, result: [{ id: "page" }], result_info: { cursor: "repeated" } });
        assert.ok(!url.pathname.endsWith("finish"));
        return new Response(null, { status: 204 });
      },
    }),
    /repeated a cursor/,
  );
});
