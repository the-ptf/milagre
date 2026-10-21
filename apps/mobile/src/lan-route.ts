/** How a phone reaches its Mac on the same network: the Mac's relay id and box key, and its addresses there. */
export type LanRoute = { hostId: string; key: string; endpoints: string[]; learnedAt: number };

const PRIVATE_WS = /^ws:\/\/(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}:\d{1,5}$/;
const MAX_ENDPOINTS = 4;

export function validLanRoute(value: unknown): LanRoute | undefined {
  const route = value as Partial<LanRoute> | null | undefined;
  if (!route || !/^[A-Za-z0-9_-]{22}$/.test(String(route.hostId)) || !/^[A-Za-z0-9_-]{43}$/.test(String(route.key))) return undefined;
  const endpoints = (Array.isArray(route.endpoints) ? route.endpoints : [])
    .filter((endpoint): endpoint is string => typeof endpoint === "string" && PRIVATE_WS.test(endpoint))
    .slice(0, MAX_ENDPOINTS);
  if (!endpoints.length) return undefined;
  return { hostId: String(route.hostId), key: String(route.key), endpoints, learnedAt: Number(route.learnedAt) || 0 };
}

/** The Mac's `phone:routes` answer as a saved route; undefined when it has none to offer. */
export function lanRouteFromAnswer(answer: unknown, learnedAt: number): LanRoute | undefined {
  const value = answer as { hostId?: unknown; key?: unknown; lan?: unknown } | null | undefined;
  return validLanRoute({ hostId: value?.hostId, key: value?.key, endpoints: value?.lan, learnedAt });
}
