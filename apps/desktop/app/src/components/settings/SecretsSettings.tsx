import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock01Icon, Delete02Icon, Edit02Icon, Key01Icon, LockKeyIcon } from "@hugeicons/core-free-icons";
import { ipcErrorMessage } from "@milagre/shared/result";
import { ago } from "@milagre/shared/main-sync";
import { SECRETS_COPY, secretFlags, secretScopeText, type SecretSummary } from "@milagre/shared/secrets";
import { useComputers } from "../../lib/computers";
import { useAddSecretRequest } from "../../lib/secrets-intent";
import type { RecentProject } from "../../lib/project-list";
import { Button, IconButton } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { Skeleton } from "../primitives/Skeleton";
import { AddSecretDialog, DeleteSecretDialog, EditSecretDialog, ImportSecretsDialog, ReplaceSecretDialog, SecretLogDialog } from "./SecretDialogs";
import { useFilePicker, type ScopeChoice } from "./SecretFields";
import { SecretSharing } from "./SecretSharing";
import { Group } from "./SettingsGroup";

type Open =
  | { kind: "add" }
  | { kind: "import"; file: { path: string; fileName: string } }
  | { kind: "replace" | "edit" | "log" | "delete"; secret: SecretSummary };

type Vault = { unlocked: boolean | null; secrets: SecretSummary[] | null; error: string };

async function readVault(): Promise<Vault> {
  try {
    const { unlocked } = await window.milagre.secrets.status();
    return { unlocked, secrets: unlocked ? await window.milagre.secrets.list() : [], error: "" };
  } catch (failure) {
    return { unlocked: null, secrets: [], error: ipcErrorMessage(failure) };
  }
}

/** This computer's vault: whether it is unlocked, its secrets, and the Projects with a Git origin a scope can name. */
function useSecrets() {
  const [vault, setVault] = useState<Vault>({ unlocked: null, secrets: null, error: "" });
  const [projects, setProjects] = useState<RecentProject[]>([]);
  const reload = useCallback(() => readVault().then(setVault), []);
  useEffect(() => {
    readVault().then(setVault, () => {});
    window.milagre.listRecentProjects().then(
      (list) => setProjects(list ?? []),
      () => {},
    );
    return window.milagre.secrets.onChanged(() => void readVault().then(setVault));
  }, []);
  return { ...vault, projects, reload };
}

function scopeChoices(projects: RecentProject[]): ScopeChoice[] {
  const seen = new Set<string>();
  return projects.flatMap((project) => {
    if (!project.origin || seen.has(project.origin)) return [];
    seen.add(project.origin);
    return [{ origin: project.origin, name: project.name }];
  });
}

/** A scope's text with each origin named after its Project here, when there is one. */
function scopeText(secret: SecretSummary, choices: ScopeChoice[]): string {
  if (secret.projects === "all" || secret.projects.length !== 1) return secretScopeText(secret.projects);
  const origin = secret.projects[0]!;
  return choices.find((choice) => choice.origin === origin)?.name ?? origin;
}

function Badge({ children, warning = false }: { children: string; warning?: boolean }) {
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-10 font-medium ${warning ? "bg-orange-tint text-orange-ink" : "bg-field text-ink-2"}`}>
      {children}
    </span>
  );
}

function SecretRow({
  secret,
  choices,
  now,
  here,
  onOpen,
}: {
  secret: SecretSummary;
  choices: ScopeChoice[];
  now: number;
  here: string;
  onOpen: (open: Open) => void;
}) {
  const flags = secretFlags(secret);
  const unattended = secretFlags({ delivery: "on-demand", askEachUse: false, unattended: true })[0];
  const scope = scopeText(secret, choices);
  const used = secret.lastUsedAt === null ? SECRETS_COPY.neverUsed : SECRETS_COPY.lastUsed(ago(secret.lastUsedAt, now));
  return (
    <li data-secret={secret.name} className="flex items-center gap-3 px-4 py-3">
      <div className="grid min-w-0 flex-1 gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate font-mono text-13 font-medium text-ink">{secret.name}</span>
          {secret.kind === "file"
            ? secret.fileName && <span className="truncate font-mono text-12 text-ink-3">{secret.fileName}</span>
            : secret.hint && <span className="font-mono text-12 text-ink-3">…{secret.hint}</span>}
          {flags.map((flag) => (
            <Badge key={flag} warning={flag === unattended}>
              {flag}
            </Badge>
          ))}
        </div>
        {secret.note && <p className="break-words text-12 text-ink-2">{secret.note}</p>}
        <p className="truncate text-12 text-ink-3">
          <span title={secret.projects === "all" ? undefined : secret.projects.join("\n")}>{scope}</span> · {used}
          {secret.changedOn !== here && <> · {SECRETS_COPY.changedOn(secret.changedOn)}</>}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label={SECRETS_COPY.replace} icon={Key01Icon} data-secret-replace onClick={() => onOpen({ kind: "replace", secret })} />
        <IconButton label={SECRETS_COPY.edit} icon={Edit02Icon} data-secret-edit onClick={() => onOpen({ kind: "edit", secret })} />
        <IconButton label={SECRETS_COPY.log} icon={Clock01Icon} data-secret-log onClick={() => onOpen({ kind: "log", secret })} />
        <IconButton
          label={SECRETS_COPY.remove}
          icon={Delete02Icon}
          variant="danger-ghost"
          data-secret-delete
          onClick={() => onOpen({ kind: "delete", secret })}
        />
      </div>
    </li>
  );
}

/** Settings › Secrets: this computer's named secrets for agents (docs/secrets.md). Values go in and never come back. */
export function SecretsSettings() {
  const { unlocked, secrets, projects, error, reload } = useSecrets();
  const { thisMac } = useComputers();
  const [open, setOpen] = useState<Open | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const choices = useMemo(() => scopeChoices(projects), [projects]);
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.path, project.name])), [projects]);
  const picker = useFilePicker((path, fileName) => setOpen({ kind: "import", file: { path, fileName } }));
  const openAdd = useCallback(() => setOpen({ kind: "add" }), []);
  useAddSecretRequest(openAdd);
  const close = () => setOpen(null);
  const saved = () => {
    setOpen(null);
    setNow(Date.now());
    void reload();
  };
  const locked = unlocked === false;
  return (
    <>
      <p className="mt-2 text-13 text-ink-2">{SECRETS_COPY.intro}</p>
      <p className="mt-1.5 text-12 text-ink-3">{SECRETS_COPY.usage}</p>
      {locked ? (
        <div data-secrets-locked className="mt-6 flex items-start gap-3 rounded-card border border-line bg-surface p-4">
          <Icon icon={LockKeyIcon} size={16} className="mt-0.5 shrink-0 text-ink-3" />
          <p className="text-13 text-ink-2">{SECRETS_COPY.locked}</p>
        </div>
      ) : (
        <Group
          action={
            <span className="flex gap-2">
              <Button size={28} variant="secondary" data-secrets-import disabled={unlocked !== true} onClick={picker.open}>
                {SECRETS_COPY.importEnv}
              </Button>
              <Button size={28} data-secrets-add disabled={unlocked !== true} onClick={openAdd}>
                {SECRETS_COPY.add}
              </Button>
            </span>
          }
        >
          {secrets === null ? (
            <div className="grid gap-2 p-4">
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </div>
          ) : secrets.length === 0 ? (
            <EmptyState data-secrets-empty icon={Key01Icon} title={SECRETS_COPY.empty} />
          ) : (
            <ul data-secrets-list className="divide-y divide-line">
              {secrets.map((secret) => (
                <SecretRow key={secret.name} secret={secret} choices={choices} now={now} here={thisMac} onOpen={setOpen} />
              ))}
            </ul>
          )}
        </Group>
      )}
      <InlineError size={12} className="mt-2 px-1">
        {error}
      </InlineError>
      {!locked && <SecretSharing />}
      {picker.element}
      {open?.kind === "add" && unlocked && <AddSecretDialog choices={choices} existing={secrets ?? []} onClose={close} onSaved={saved} />}
      {open?.kind === "import" && <ImportSecretsDialog file={open.file} choices={choices} onClose={close} onImported={() => void reload()} />}
      {open?.kind === "replace" && <ReplaceSecretDialog secret={open.secret} onClose={close} onSaved={saved} />}
      {open?.kind === "edit" && <EditSecretDialog secret={open.secret} choices={choices} onClose={close} onSaved={saved} />}
      {open?.kind === "log" && <SecretLogDialog secret={open.secret} projectNames={projectNames} onClose={close} />}
      {open?.kind === "delete" && <DeleteSecretDialog secret={open.secret} onClose={close} onDeleted={saved} />}
    </>
  );
}
