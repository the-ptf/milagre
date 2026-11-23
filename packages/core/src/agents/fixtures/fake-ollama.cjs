// An Ollama server answering from fixed routes, for tests that read local models.
function fakeOllama(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const route = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ route, body });
    const answer = routes[route];
    const value = typeof answer === "function" ? answer(body) : answer;
    if (value === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => value };
  };
  return { fetchImpl, calls };
}

const ROUTES = {
  "/api/tags": {
    models: [
      { name: "embed:latest", modified_at: "2026-11-01T00:00:00Z", details: { parameter_size: "0.3B" } },
      { name: "qwen3:8b", modified_at: "2026-11-20T00:00:00Z", details: { parameter_size: "8.2B", quantization_level: "Q4_K_M" } },
      { name: "coder:64k", modified_at: "2026-11-10T00:00:00Z", details: { parameter_size: "27B", quantization_level: "Q4_K_M" } },
    ],
  },
  "/api/ps": { models: [{ name: "qwen3:8b", context_length: 40960 }] },
  "/api/show": ({ model }) =>
    ({
      "embed:latest": { capabilities: ["embedding"], model_info: {} },
      "qwen3:8b": { capabilities: ["completion", "tools", "thinking"], model_info: { "qwen3.context_length": 131072 } },
      "coder:64k": { capabilities: ["completion", "tools", "vision"], parameters: "temperature 1\nnum_ctx 65536", model_info: { "x.context_length": 262144 } },
    })[model],
};

module.exports = { ROUTES, fakeOllama };
