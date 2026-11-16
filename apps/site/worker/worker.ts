import { handleRequest } from "./handler.mjs";

interface Env {
  ASSETS: Fetcher;
  GITHUB_TOKEN?: string;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, {
      assets: env.ASSETS,
      token: env.GITHUB_TOKEN,
      fetchImpl: (input, init) => fetch(input, { ...init, cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 300, "400-599": 0 } } }),
    });
  },
} satisfies ExportedHandler<Env>;
