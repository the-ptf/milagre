import previewImage from "../assets/og.png";
import { validateDesignPageSnapshot, renderDesignPage } from "@milagre/shared/design-page";
import { createPageService, createQuotaService, quotaLimits, response, routeRequest, type Storage } from "./service.mjs";

interface Env {
  PAGES: DurableObjectNamespace;
  QUOTA: DurableObjectNamespace;
  PUBLIC_ORIGIN: string;
  ALLOW_LOCALHOST?: string;
  MAX_TOTAL_BYTES?: string;
  MAX_TOTAL_PAGES?: string;
  MAX_DAILY_PAGES?: string;
  MAX_DAILY_IP_PAGES?: string;
  MAX_DAILY_IP_UPDATES?: string;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await routeRequest(request, {
        PUBLIC_ORIGIN: env.PUBLIC_ORIGIN,
        previewImage,
        ALLOW_LOCALHOST: env.ALLOW_LOCALHOST,
        page: (id, incoming, ip) => {
          const headers = new Headers(incoming.headers);
          headers.set("X-Milagre-Client-IP", ip);
          return env.PAGES.get(env.PAGES.idFromName(id)).fetch(new Request(incoming, { headers }));
        },
      });
    } catch {
      return response("Sharing unavailable", 503);
    }
  },
};

export class DesignPage implements DurableObject {
  private readonly service;
  constructor(state: DurableObjectState, env: Env) {
    this.service = createPageService({
      storage: adapter(state.storage),
      validate: validateDesignPageSnapshot,
      render: renderDesignPage,
      admit: async (ip, replacement) => {
        const result = await env.QUOTA.get(env.QUOTA.idFromName("global-v1")).fetch(
          new Request("https://quota/admit", { method: "POST", body: JSON.stringify({ ip, replacement }), headers: { "Content-Type": "application/json" } }),
        );
        return result.status === 204;
      },
      reserve: async (ip, bytes, replacement) => {
        const result = await env.QUOTA.get(env.QUOTA.idFromName("global-v1")).fetch(
          new Request("https://quota/reserve", {
            method: "POST",
            body: JSON.stringify({ ip, bytes, replacement }),
            headers: { "Content-Type": "application/json" },
          }),
        );
        return result.status === 204;
      },
    });
  }

  fetch(request: Request): Promise<Response> {
    const id = new URL(request.url).pathname.split("/").at(-1)!;
    return this.service.fetch(request, id, request.headers.get("X-Milagre-Client-IP") ?? "");
  }
}

export class PublishQuota implements DurableObject {
  private readonly service;
  constructor(state: DurableObjectState, env: Env) {
    this.service = createQuotaService({
      storage: adapter(state.storage),
      limits: quotaLimits({
        MAX_TOTAL_BYTES: env.MAX_TOTAL_BYTES,
        MAX_TOTAL_PAGES: env.MAX_TOTAL_PAGES,
        MAX_DAILY_PAGES: env.MAX_DAILY_PAGES,
        MAX_DAILY_IP_PAGES: env.MAX_DAILY_IP_PAGES,
        MAX_DAILY_IP_UPDATES: env.MAX_DAILY_IP_UPDATES,
      }),
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/reserve", "/admit"].includes(path)) return response("Not found", 404);
    try {
      const { ip, bytes, replacement } = await request.json<{ ip: string; bytes: number; replacement?: boolean }>();
      return response(null, (await (path === "/admit" ? this.service.admit(ip, replacement) : this.service.reserve(ip, bytes, replacement))) ? 204 : 429);
    } catch {
      return response("Invalid reservation", 400);
    }
  }
}
