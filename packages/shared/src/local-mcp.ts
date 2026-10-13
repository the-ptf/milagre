export type LocalMcpGrants = {
  projects?: { projectPaths: string[]; capabilities: "read"[] };
  worktrees?: { projectPaths: string[]; capabilities: ("read" | "create")[] };
  chats?: { projectPaths: string[]; capabilities: ("read" | "create" | "start")[] };
  designs?: { chatId: string; designIds: "*" | string[]; capabilities: ("read" | "write")[] };
};
export type LocalMcpConfiguration = { label: string; grants: LocalMcpGrants; expiresAt?: string };
export type LocalMcpConnection = LocalMcpConfiguration & { id: string; revision: number; createdAt: string; revokedAt?: string; clientId?: string };
export type LocalMcpCredential = { connection: LocalMcpConnection; url: string; token: string };
export type LocalMcpClient = {
  id: string;
  label: string;
  configPath: string;
  enabled: boolean;
  state: "configured" | "missing" | "off" | "error" | "unavailable";
  connection?: LocalMcpConnection;
  problem?: string;
};
export type LocalMcpStatus = {
  clients: LocalMcpClient[];
  url: string;
  connections: LocalMcpConnection[];
  groups: { id: string; enabled: boolean }[];
  projects: { id: string; name: string; path: string }[];
};
export type LocalMcpApi = {
  status(): Promise<LocalMcpStatus>;
  create(input: LocalMcpConfiguration): Promise<LocalMcpCredential>;
  update(id: string, input: LocalMcpConfiguration): Promise<LocalMcpConnection>;
  rotate(id: string): Promise<LocalMcpCredential>;
  revoke(id: string): Promise<void>;
  enableClient(id: string, input: LocalMcpConfiguration): Promise<LocalMcpClient>;
  disableClient(id: string): Promise<LocalMcpClient>;
};
export function localMcpClientConfig(credential: LocalMcpCredential): string {
  return JSON.stringify({ mcpServers: { milagre: { url: credential.url, headers: { Authorization: `Bearer ${credential.token}` } } } }, null, 2);
}
export function localMcpDescription(connection: LocalMcpConnection): string {
  return Object.entries(connection.grants)
    .map(
      ([group, grant]) =>
        `${group}: ${grant.capabilities.join(", ")} (${"projectPaths" in grant ? grant.projectPaths.join(", ") : `${grant.chatId}; ${grant.designIds === "*" ? "all designs" : grant.designIds.join(", ") || "no designs"}`})`,
    )
    .join("; ");
}
export type LocalMcpDraft = { label: string; kind: "projects" | "designs"; projectPaths: string[]; chatId: string; designIds: string; write: boolean };
export const emptyLocalMcpDraft = (): LocalMcpDraft => ({ label: "", kind: "projects", projectPaths: [], chatId: "", designIds: "*", write: false });
export function localMcpConfiguration(draft: LocalMcpDraft): LocalMcpConfiguration {
  return {
    label: draft.label,
    grants:
      draft.kind === "designs"
        ? {
            designs: {
              chatId: draft.chatId.trim(),
              designIds:
                draft.designIds.trim() === "*"
                  ? "*"
                  : draft.designIds
                      .split(",")
                      .map((id) => id.trim())
                      .filter(Boolean),
              capabilities: draft.write ? ["read", "write"] : ["read"],
            },
          }
        : {
            projects: { projectPaths: draft.projectPaths, capabilities: ["read"] },
            worktrees: { projectPaths: draft.projectPaths, capabilities: draft.write ? ["read", "create"] : ["read"] },
            chats: { projectPaths: draft.projectPaths, capabilities: draft.write ? ["read", "create", "start"] : ["read"] },
          },
  };
}
export function localMcpReadOnly(connection: LocalMcpConnection): LocalMcpConfiguration {
  const grants = Object.fromEntries(
    Object.entries(connection.grants)
      .filter(([, scope]) => scope.capabilities.includes("read"))
      .map(([group, scope]) => [group, { ...scope, capabilities: ["read"] }]),
  );
  return { label: connection.label, grants, ...(connection.expiresAt ? { expiresAt: connection.expiresAt } : {}) };
}

export function localMcpDraftFor(connection?: LocalMcpConfiguration): LocalMcpDraft {
  if (!connection) return emptyLocalMcpDraft();
  const designs = connection.grants.designs;
  return {
    label: connection.label,
    kind: designs ? "designs" : "projects",
    chatId: designs?.chatId ?? "",
    designIds: designs?.designIds === "*" ? "*" : (designs?.designIds.join(", ") ?? "*"),
    projectPaths: [...new Set(Object.values(connection.grants).flatMap((scope) => ("projectPaths" in scope ? scope.projectPaths : [])))],
    write: Object.values(connection.grants).some((scope) => scope.capabilities.some((cap) => cap !== "read")),
  };
}
export function localMcpClientDetail(client: LocalMcpClient): string {
  if (client.problem) return client.problem;
  if (client.state === "missing") return "Configuration missing. Open setup to reconnect.";
  if (!client.enabled || !client.connection) return "";
  const draft = localMcpDraftFor(client.connection);
  const scope =
    draft.kind === "designs" ? `Designs in ${draft.chatId}` : `${draft.projectPaths.length} ${draft.projectPaths.length === 1 ? "Project" : "Projects"}`;
  return `${scope} · ${draft.write ? "Read and write" : "Read only"}`;
}
