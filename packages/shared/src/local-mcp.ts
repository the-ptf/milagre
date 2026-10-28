export type LocalMcpProjectPaths = "*" | string[];
export type LocalMcpGrants = {
  projects?: { projectPaths: LocalMcpProjectPaths; capabilities: ("read" | "create")[] };
  worktrees?: { projectPaths: LocalMcpProjectPaths; capabilities: ("read" | "create")[] };
  chats?: { projectPaths: LocalMcpProjectPaths; capabilities: ("read" | "create" | "start")[] };
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
export type LocalMcpChangedPayload = { projectAdded?: boolean };
export type LocalMcpApi = {
  status(): Promise<LocalMcpStatus>;
  create(input: LocalMcpConfiguration): Promise<LocalMcpCredential>;
  update(id: string, input: LocalMcpConfiguration): Promise<LocalMcpConnection>;
  rotate(id: string): Promise<LocalMcpCredential>;
  revoke(id: string): Promise<void>;
  enableClient(id: string, input: LocalMcpConfiguration): Promise<LocalMcpClient>;
  disableClient(id: string): Promise<LocalMcpClient>;
  onChanged?(callback: (payload?: LocalMcpChangedPayload) => void): () => void;
};
export function localMcpClientConfig(credential: LocalMcpCredential): string {
  return JSON.stringify({ mcpServers: { milagre: { url: credential.url, headers: { Authorization: `Bearer ${credential.token}` } } } }, null, 2);
}
export function localMcpDescription(connection: LocalMcpConnection): string {
  return Object.entries(connection.grants)
    .map(
      ([group, grant]) =>
        `${group}: ${grant.capabilities.join(", ")} (${"projectPaths" in grant ? (grant.projectPaths === "*" ? "all Projects" : grant.projectPaths.join(", ")) : `${grant.chatId}; ${grant.designIds === "*" ? "all designs" : grant.designIds.join(", ") || "no designs"}`})`,
    )
    .join("; ");
}
export type LocalMcpDraft = {
  label: string;
  kind: "projects" | "all-projects" | "designs";
  projectPaths: string[];
  chatId: string;
  designIds: string;
  write: boolean;
  baseGrants?: LocalMcpGrants;
};
export const emptyLocalMcpDraft = (): LocalMcpDraft => ({ label: "", kind: "projects", projectPaths: [], chatId: "", designIds: "*", write: false });
export function setLocalMcpDraftKind(draft: LocalMcpDraft, kind: LocalMcpDraft["kind"]): LocalMcpDraft {
  const { baseGrants: _ignored, ...rest } = draft;
  return { ...rest, kind };
}
export function toggleLocalMcpDraftProject(draft: LocalMcpDraft, projectPath: string): LocalMcpDraft {
  const { baseGrants: _ignored, ...rest } = draft;
  return {
    ...rest,
    projectPaths: draft.projectPaths.includes(projectPath) ? draft.projectPaths.filter((p) => p !== projectPath) : [...draft.projectPaths, projectPath],
  };
}
export function localMcpDraftValid(draft: LocalMcpDraft): boolean {
  if (!draft.label.trim()) return false;
  if (draft.kind === "designs") return draft.chatId.trim().length > 0;
  if (draft.kind === "all-projects") return true;
  if (draft.baseGrants)
    return Object.values(draft.baseGrants).some((scope) =>
      Boolean(scope && "projectPaths" in scope && (scope.projectPaths === "*" || scope.projectPaths.length > 0)),
    );
  return draft.projectPaths.length > 0;
}
export function localMcpConfiguration(draft: LocalMcpDraft): LocalMcpConfiguration {
  if (draft.baseGrants && draft.kind !== "designs") {
    return {
      label: draft.label,
      grants: {
        ...(draft.baseGrants.projects ? { projects: { projectPaths: draft.baseGrants.projects.projectPaths, capabilities: ["read"] } } : {}),
        ...(draft.baseGrants.worktrees
          ? {
              worktrees: {
                projectPaths: draft.baseGrants.worktrees.projectPaths,
                capabilities: draft.write ? ["read", "create"] : ["read"],
              },
            }
          : {}),
        ...(draft.baseGrants.chats
          ? {
              chats: {
                projectPaths: draft.baseGrants.chats.projectPaths,
                capabilities: draft.write ? ["read", "create", "start"] : ["read"],
              },
            }
          : {}),
      },
    };
  }
  const projectPaths: LocalMcpProjectPaths = draft.kind === "all-projects" ? "*" : draft.projectPaths;
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
            projects: { projectPaths, capabilities: ["read"] },
            worktrees: { projectPaths, capabilities: draft.write ? ["read", "create"] : ["read"] },
            chats: { projectPaths, capabilities: draft.write ? ["read", "create", "start"] : ["read"] },
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

const sameProjectPaths = (a: LocalMcpProjectPaths, b: LocalMcpProjectPaths): boolean =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => item === b[index]));

const hasMixedProjectGrants = (grants: LocalMcpGrants): boolean => {
  if (grants.designs) return false;
  const groups = [grants.projects, grants.worktrees, grants.chats];
  if (groups.some((scope) => !scope)) return groups.some(Boolean);
  const first = grants.projects!.projectPaths;
  return groups.some((scope) => !sameProjectPaths(scope!.projectPaths, first));
};

export function localMcpDraftFor(connection?: LocalMcpConfiguration): LocalMcpDraft {
  if (!connection) return emptyLocalMcpDraft();
  const designs = connection.grants.designs;
  const projectScopes = Object.values(connection.grants).filter(
    (scope): scope is Exclude<typeof scope, undefined> & { projectPaths: LocalMcpProjectPaths } => "projectPaths" in scope,
  );
  const mixed = hasMixedProjectGrants(connection.grants);
  const allProjects = !designs && !mixed && projectScopes.length > 0 && projectScopes.every((scope) => scope.projectPaths === "*");
  return {
    label: connection.label,
    kind: designs ? "designs" : allProjects ? "all-projects" : "projects",
    chatId: designs?.chatId ?? "",
    designIds: designs?.designIds === "*" ? "*" : (designs?.designIds.join(", ") ?? "*"),
    projectPaths: [...new Set(projectScopes.flatMap((scope) => (scope.projectPaths === "*" ? [] : scope.projectPaths)))],
    write: Object.values(connection.grants).some((scope) => scope.capabilities.some((cap) => cap !== "read")),
    ...(mixed ? { baseGrants: connection.grants } : {}),
  };
}
export function localMcpClientDetail(client: LocalMcpClient): string {
  if (client.problem) return client.problem;
  if (client.state === "missing") return "Configuration missing. Open setup to reconnect.";
  if (!client.enabled || !client.connection) return "";
  const draft = localMcpDraftFor(client.connection);
  const scope =
    draft.kind === "designs"
      ? `Designs in ${draft.chatId}`
      : draft.kind === "all-projects"
        ? "All Projects"
        : draft.baseGrants
          ? "Custom Project scope"
          : `${draft.projectPaths.length} ${draft.projectPaths.length === 1 ? "Project" : "Projects"}`;
  return `${scope} · ${draft.write ? "Read and write" : "Read only"}`;
}
