const LINK_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PREFIX = "milagre-link:";
// A paired computer's keys carry its id in front of what this Mac's keys have (spec "Renderer"): `${computerId}|${path}`
// for a Project and `milagre-link:${computerId}|${linkId}` for a Link, so code that slices the Link prefix off gets a
// Link id that still names its computer. "local" is this Mac, whose keys carry nothing.
export const LOCAL_COMPUTER = "local";

/** A computer's status dot on both apps (8px, round), as a palette key: green online, orange while it connects or is
 * being checked, red when it refused the pairing, ink4 offline or unknown. */
export function presenceTone(state) {
  if (state === "online") return "green";
  if (state === "connecting" || state === "reconnecting" || state === "checking") return "orange";
  if (state === "refused") return "red";
  return "ink4";
}
const COMPUTER_ID = /^[A-Za-z0-9-]{1,64}$/;
const QUALIFIER = /^([A-Za-z0-9-]{1,64})\|/;

/** Whether a key is a Link's, its computer, and the key without it. */
function parts(key) {
  const link = key.startsWith(PREFIX);
  const rest = link ? key.slice(PREFIX.length) : key;
  const found = QUALIFIER.exec(rest);
  const match = found && found[1] !== LOCAL_COMPUTER ? found : null;
  return { link, computerId: match ? match[1] : LOCAL_COMPUTER, bare: match ? rest.slice(match[0].length) : rest };
}

/** The computer a scope or chat key belongs to; "local" for this Mac's. */
export function computerOfKey(key) {
  return typeof key === "string" ? parts(key).computerId : LOCAL_COMPUTER;
}

/** The key as its own computer knows it. */
export function unqualifyKey(key) {
  if (typeof key !== "string") return key;
  const { link, bare } = parts(key);
  return link ? PREFIX + bare : bare;
}

/** A computer's key as this window keeps it: unchanged for this Mac, and for a key that already names a computer. */
export function qualifyKey(computerId, key) {
  if (typeof key !== "string" || !computerId || computerId === LOCAL_COMPUTER) return key;
  if (!COMPUTER_ID.test(computerId)) throw new Error("Invalid computer id.");
  const { link, computerId: current, bare } = parts(key);
  if (current !== LOCAL_COMPUTER) return key;
  return link ? `${PREFIX}${computerId}|${bare}` : `${computerId}|${key}`;
}

export function validLinkId(id) {
  return typeof id === "string" && LINK_ID.test(id);
}
export function isLinkScopeKey(key) {
  return typeof key === "string" && key.startsWith(PREFIX) && validLinkId(parts(key).bare);
}

const absolute = (value) => value.startsWith("/") || /^[a-z]:[\\/]/i.test(value);

export function scopeKey(scope) {
  if (scope?.kind === "link" && typeof scope.linkId === "string" && validLinkId(parts(PREFIX + scope.linkId).bare)) return PREFIX + scope.linkId;
  if (scope?.kind === "project" && typeof scope.projectPath === "string" && absolute(parts(scope.projectPath).bare)) return scope.projectPath;
  throw new Error("Choose a valid Project or Link.");
}

export function scopeFromKey(key) {
  return isLinkScopeKey(key) ? { kind: "link", linkId: key.slice(PREFIX.length) } : { kind: "project", projectPath: key };
}

export function chatKeyForScope(scope, sessionId) {
  if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new Error("Invalid Chat ID.");
  return `${scopeKey(scope)}#${sessionId}`;
}

export function scopeFromChatKey(key) {
  if (typeof key !== "string" || !/#\d+$/.test(key)) throw new Error("Invalid Chat key.");
  const owner = key.slice(0, key.lastIndexOf("#"));
  const scope = scopeFromKey(owner);
  scopeKey(scope);
  return scope;
}
