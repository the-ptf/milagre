import previewImage from "../assets/og.png";
import { validateDesignPageSnapshot, renderDesignPage } from "@milagre/shared/design-page";
import { createPageService, createQuotaService, quotaLimits, response, routeRequest, digest, type Storage, type PageQuota } from "./service.mjs";

const hash = (value: string) => digest(new TextEncoder().encode(value));

interface Env {
  PAGES: DurableObjectNamespace;
  QUOTA: DurableObjectNamespace;
  PUBLIC_ORIGIN: string;
  ALLOW_LOCALHOST?: string;
  MAX_TOTAL_BYTES?: string;
  MIGRATION_TOKEN?: string;
}

function adapter(storage: DurableObjectStorage): Storage {
  return {
    get: (key) => storage.kv.get(key),
    put: (key, value) => storage.kv.put(key, value),
    delete: (key) => {
      storage.kv.delete(key);
    },
    keys: (prefix) => [...storage.kv.list({ prefix })].map(([key]) => key),
    transaction: (callback) => storage.transactionSync(callback),
  };
}

async function quotaCall(env: Env, method: string, args: unknown[]): Promise<Response> {
  return env.QUOTA.get(env.QUOTA.idFromName("global-v1")).fetch(
    new Request(`https://quota/${method}`, {
      method: "POST",
      body: JSON.stringify(args),
      headers: { "Content-Type": "application/json" },
    }),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      // Disabled without a temporary operator secret. Never expose namespace object IDs publicly.
      if (path.startsWith("/maintenance/")) {
        const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");
        if (!env.MIGRATION_TOKEN || !token || (await hash(token)) !== (await hash(env.MIGRATION_TOKEN))) return response("Not found", 404);
        if (request.method !== "POST") return response("Not found", 404);
        if (path === "/maintenance/finish") return quotaCall(env, "finishMigration", []);
        if (path !== "/maintenance/import") return response("Not found", 404);
        const { objectId } = await request.json<{ objectId: string }>();
        if (!/^[a-f0-9]{64}$/.test(objectId)) return response("Invalid object", 400);
        return env.PAGES.get(env.PAGES.idFromString(objectId)).fetch(new Request("https://internal/_migrate", { method: "POST" }));
      }
      return await routeRequest(request, {
        PUBLIC_ORIGIN: env.PUBLIC_ORIGIN,
        previewImage,
        ALLOW_LOCALHOST: env.ALLOW_LOCALHOST,
        page: (id, incoming) => env.PAGES.get(env.PAGES.idFromName(id)).fetch(incoming),
      });
    } catch {
      return response("Sharing unavailable", 503);
    }
  },
};

export class DesignPage implements DurableObject {
  private readonly service;
  constructor(state: DurableObjectState, env: Env) {
    const call = async (method: string, args: unknown[]) => {
      const result = await quotaCall(env, method, args);
      if (!result.ok && result.status !== 429) throw Error("Quota service unavailable");
      return result;
    };
    const confirmed = async (method: string, args: unknown[]) => {
      const result = await call(method, args);
      if (result.status !== 204) throw Error("Quota operation not confirmed");
    };
    const quota: PageQuota = {
      available: async (id) => Number(await (await call("available", [id])).text()),
      reserve: async (...args) => (await call("reserve", args)).status === 204,
      commit: async (...args) => (await call("commit", args)).status === 204,
      abort: (...args) => confirmed("abort", args),
      release: (...args) => confirmed("release", args),
      importPage: (...args) => confirmed("importPage", args),
    };
    this.service = createPageService({
      storage: adapter(state.storage),
      validate: validateDesignPageSnapshot,
      render: renderDesignPage,
      quota,
      quotaId: state.id.toString(),
      setAlarm: (time) => state.storage.setAlarm(time),
      deleteAlarm: () => state.storage.deleteAlarm(),
    });
  }
  alarm(): Promise<void> {
    return this.service.alarm();
  }
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/_migrate") {
      await this.service.migrate();
      return response(null, 204);
    }
    const id = new URL(request.url).pathname.split("/").at(-1)!;
    return this.service.fetch(request, id);
  }
}

export class PublishQuota implements DurableObject {
  private readonly service;
  constructor(state: DurableObjectState, env: Env) {
    this.service = createQuotaService({ storage: adapter(state.storage), limits: quotaLimits({ MAX_TOTAL_BYTES: env.MAX_TOTAL_BYTES }) });
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return response("Not found", 404);
    try {
      const args = await request.json<[string, string, number]>();
      switch (new URL(request.url).pathname) {
        case "/available":
          return response(String(this.service.available(args[0])));
        case "/reserve":
          return response(null, this.service.reserve(...args) ? 204 : 429);
        case "/commit":
          return response(null, this.service.commit(args[0], args[1]) ? 204 : 429);
        case "/abort":
          this.service.abort(args[0], args[1]);
          break;
        case "/release":
          this.service.release(args[0]);
          break;
        case "/importPage":
          this.service.importPage(args[0], Number(args[1]));
          break;
        case "/finishMigration":
          this.service.finishMigration();
          break;
        default:
          return response("Not found", 404);
      }
      return response(null, 204);
    } catch {
      return response("Invalid reservation", 400);
    }
  }
}
