export type SecretKind = "text" | "file" | "login";

/** The site a login is typed into and the username it signs in with. */
export interface SecretLogin {
  origin: string;
  username: string;
}
export type SecretDelivery = "on-demand" | "ambient";

/** A secret without its value: what agents, peers and the phone may see. */
export interface SecretSummary {
  name: string;
  kind: SecretKind;
  fileName: string | null;
  login?: SecretLogin;
  hint: string | null;
  projects: "all" | string[];
  delivery: SecretDelivery;
  askEachUse: boolean;
  unattended: boolean;
  note: string | null;
  version: number;
  changedOn: string;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface SecretScopeTarget {
  name: string;
  kind?: SecretKind;
  value?: string;
  projects: "all" | string[];
  unattended?: boolean;
}

export declare const SECRET_LIMITS: Readonly<{ count: number; valueBytes: number; noteChars: number; fileNameChars: number; projects: number }>;
export declare const SECRET_KINDS: readonly SecretKind[];
export declare const SECRET_DELIVERIES: readonly SecretDelivery[];
export declare const REDACT_MIN_CHARS: number;
export function secretNameProblem(name: unknown): string | null;
export function secretHint(value: unknown): string | null;
export function secretReaches(secret: SecretScopeTarget, target: { origin: string | null; unattended?: boolean }): boolean;
export function parseDotenv(text: string): { name: string; value: string }[];
export function secretRedactor(
  secrets: { name: string; kind?: SecretKind; value: string }[],
): ((text: string) => string) & { pending: (text: string) => number };

export declare const SECRETS_COPY: Readonly<{
  title: string;
  intro: string;
  usage: string;
  locked: string;
  empty: string;
  add: string;
  importEnv: string;
  replace: string;
  remove: string;
  removeConfirm: (name: string) => string;
  name: string;
  value: string;
  file: string;
  note: string;
  projects: string;
  allProjects: string;
  chosenProjects: string;
  noProjects: string;
  ambient: { label: string; help: string };
  askEachUse: { label: string; help: string };
  unattended: { label: string; help: string };
  log: string;
  noUses: string;
  neverUsed: string;
  lastUsed: (when: string) => string;
  open: string;
  edit: string;
  chooseFile: string;
  valuePlaceholder: string;
  imported: (count: number) => string;
  skipped: string;
  saveAs: { label: (name: string) => string; project: string; all: string; none: string; replaces: (name: string) => string };
  changedOn: (name: string) => string;
  logins: {
    title: string;
    intro: string;
    empty: string;
    add: string;
    importPasswords: string;
    import: string;
    site: string;
    sitePlaceholder: string;
    username: string;
    password: string;
    replacePassword: string;
    passwordPlaceholder: string;
    badSite: string;
    exportHelp: string;
    deleteExport: string;
    phoneImport: string;
    imported: (count: number) => string;
    removeConfirm: (site: string, username: string) => string;
    nobody: string;
  };
  sharing: { title: string; intro: string; empty: string; online: string; offline: string; removing: (name: string) => string };
}>;

/** A paired computer and whether this computer shares its secrets with it: `secrets:sharing`, `secrets:share`. */
export interface SecretSharingComputer {
  id: string;
  name: string;
  online: boolean;
  shared: boolean;
  pendingRemoval: boolean;
}

/** One use from the log: `secrets:log`. */
export interface SecretUse {
  at: number;
  names: string[];
  chatId: string;
  computer: string;
  command: string | null;
  delivery: SecretDelivery;
}

/** What `secrets:set` takes: a value, or (from a computer, not the phone) an absolute `file` path the host reads. */
export interface SecretInput {
  name: string;
  value?: string;
  file?: string;
  kind?: SecretKind;
  fileName?: string | null;
  login?: SecretLogin;
  projects: "all" | string[];
  delivery?: SecretDelivery;
  askEachUse?: boolean;
  unattended?: boolean;
  note?: string | null;
}

/** What `secrets:update` changes: everything but the name, kind and value. */
export type SecretPatch = Partial<Pick<SecretSummary, "projects" | "delivery" | "askEachUse" | "unattended" | "note">>;

export function secretScopeText(projects: "all" | string[]): string;
export function secretFlags(secret: Pick<SecretSummary, "delivery" | "askEachUse" | "unattended">): string[];

export function carriesSecretValue(method: string, args: unknown[]): boolean;

export function loginName(origin: string, username: string): string;
export function parseLoginCsv(text: string): { origin: string; username: string; password: string; note: string | null }[];
export function loginHost(origin: string): string;
/** `origin` is set for a usable address, `error` for a typed one that isn't, both null while empty. */
export function loginSite(site: string): { origin: string | null; error: string | null };
