const CLEARS = {
  all: ["client", "issuer", "tokens", "verifier", "discovery"],
  client: ["client", "issuer"],
  tokens: ["tokens"],
  verifier: ["verifier"],
  discovery: ["discovery"],
};

function createOAuthProvider({ connector, secrets, redirectUrl, state = () => undefined, redirect, now = Date.now }) {
  const preset = typeof connector.clientId === "string" && connector.clientId !== "";
  return {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata() {
      return {
        client_name: "Milagre",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    state,
    clientInformation() {
      const stored = secrets.read();
      if (!preset) return stored.client;
      return {
        client_id: connector.clientId,
        ...(stored.clientSecret ? { client_secret: stored.clientSecret } : {}),
        ...(stored.issuer ? { issuer: stored.issuer } : {}),
      };
    },
    saveClientInformation(information) {
      if (preset) secrets.update({ issuer: information.issuer });
      else secrets.update({ client: information });
    },
    tokens: () => secrets.read().tokens,
    saveTokens(tokens) {
      secrets.update({ tokens: { ...tokens, savedAt: now() } });
    },
    redirectToAuthorization: (url) => redirect(url),
    saveCodeVerifier(verifier) {
      secrets.update({ verifier });
    },
    codeVerifier() {
      const { verifier } = secrets.read();
      if (!verifier) throw new Error("Start the sign-in again from Milagre.");
      return verifier;
    },
    discoveryState: () => secrets.read().discovery,
    saveDiscoveryState(discovery) {
      secrets.update({ discovery });
    },
    invalidateCredentials(scope) {
      const keys = (CLEARS[scope] ?? CLEARS.all).filter((key) => !(preset && key === "client"));
      secrets.update(Object.fromEntries(keys.map((key) => [key, undefined])));
    },
  };
}

module.exports = { createOAuthProvider };
