export type LocalMcpProjectPaths = "*" | string[];
export type LocalMcpGrants = {
  projects?: { projectPaths: LocalMcpProjectPaths; capabilities: ("read" | "create")[] };
  worktrees?: { projectPaths: LocalMcpProjectPaths; capabilities: ("read" | "create")[] };
  chats?: { projectPaths: LocalMcpProjectPaths; capabilities: ("read" | "create" | "start")[] };
  designs?: { chatId: string; designIds: "*" | string[]; capabilities: ("read" | "write")[] };
  /** The computer's Connectors whose tools this client may use, by id (`linear` for Milagre's Linear); omitted gives none. */
  connectors?: { ids: "*" | string[]; capabilities: "use"[] };
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
const grantScope = (grant: NonNullable<LocalMcpGrants[keyof LocalMcpGrants]>): string =>
  "projectPaths" in grant
    ? grant.projectPaths === "*"
      ? "all Projects"
      : grant.projectPaths.join(", ")
    : "ids" in grant
      ? grant.ids === "*"
        ? "all connectors"
        : grant.ids.join(", ")
      : `${grant.chatId}; ${grant.designIds === "*" ? "all designs" : grant.designIds.join(", ") || "no designs"}`;
export function localMcpDescription(connection: LocalMcpConnection): string {
  return Object.entries(connection.grants)
    .map(([group, grant]) => `${group}: ${grant.capabilities.join(", ")} (${grantScope(grant)})`)
    .join("; ");
}
/** Whether Restrict to read has something to take away and something to keep. */
export function localMcpWritable(connection: LocalMcpConnection): boolean {
  const grants = Object.values(connection.grants);
  return grants.some((scope) => scope.capabilities.some((cap) => cap !== "read")) && grants.some((scope) => scope.capabilities.some((cap) => cap === "read"));
}
export type LocalMcpDraft = {
  label: string;
  kind: "projects" | "all-projects" | "designs";
  projectPaths: string[];
  chatId: string;
  designIds: string;
  write: boolean;
  connectors: "none" | "all" | "some";
  connectorIds: string[];
  baseGrants?: LocalMcpGrants;
};
export const emptyLocalMcpDraft = (): LocalMcpDraft => ({
  label: "",
  kind: "projects",
  projectPaths: [],
  chatId: "",
  designIds: "*",
  write: false,
  connectors: "none",
  connectorIds: [],
});
export function toggleLocalMcpDraftConnector(draft: LocalMcpDraft, id: string): LocalMcpDraft {
  return { ...draft, connectorIds: draft.connectorIds.includes(id) ? draft.connectorIds.filter((item) => item !== id) : [...draft.connectorIds, id] };
}
const connectorGrant = (draft: LocalMcpDraft): LocalMcpGrants =>
  draft.connectors === "all"
    ? { connectors: { ids: "*", capabilities: ["use"] } }
    : draft.connectors === "some" && draft.connectorIds.length
      ? { connectors: { ids: draft.connectorIds, capabilities: ["use"] } }
      : {};
const hasConnectors = (draft: LocalMcpDraft) => Object.keys(connectorGrant(draft)).length > 0;
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
  if (draft.kind === "all-projects" || hasConnectors(draft)) return true;
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
        ...connectorGrant(draft),
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
            ...connectorGrant(draft),
          }
        : projectPaths === "*" || projectPaths.length
          ? {
              projects: { projectPaths, capabilities: ["read"] },
              worktrees: { projectPaths, capabilities: draft.write ? ["read", "create"] : ["read"] },
              chats: { projectPaths, capabilities: draft.write ? ["read", "create", "start"] : ["read"] },
              ...connectorGrant(draft),
            }
          : connectorGrant(draft),
  };
}
export function localMcpReadOnly(connection: LocalMcpConnection): LocalMcpConfiguration {
  const grants = Object.fromEntries(
    Object.entries(connection.grants)
      .filter(([, scope]) => (scope.capabilities as string[]).includes("read"))
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
  const connectors = connection.grants.connectors;
  return {
    label: connection.label,
    kind: designs ? "designs" : allProjects ? "all-projects" : "projects",
    chatId: designs?.chatId ?? "",
    designIds: designs?.designIds === "*" ? "*" : (designs?.designIds.join(", ") ?? "*"),
    projectPaths: [...new Set(projectScopes.flatMap((scope) => (scope.projectPaths === "*" ? [] : scope.projectPaths)))],
    write: [connection.grants.projects, connection.grants.worktrees, connection.grants.chats, designs].some((scope) =>
      scope?.capabilities.some((cap) => cap !== "read"),
    ),
    connectors: !connectors ? "none" : connectors.ids === "*" ? "all" : "some",
    connectorIds: connectors && connectors.ids !== "*" ? [...connectors.ids] : [],
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
          : draft.projectPaths.length
            ? `${draft.projectPaths.length} ${draft.projectPaths.length === 1 ? "Project" : "Projects"}`
            : "";
  const connectors =
    draft.connectors === "all"
      ? "All connectors"
      : draft.connectors === "some"
        ? `${draft.connectorIds.length} ${draft.connectorIds.length === 1 ? "connector" : "connectors"}`
        : "";
  return [scope && `${scope} · ${draft.write ? "Read and write" : "Read only"}`, connectors].filter(Boolean).join(" · ");
}
