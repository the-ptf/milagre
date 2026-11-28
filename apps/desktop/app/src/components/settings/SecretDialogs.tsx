import { useEffect, useId, useState, type FormEvent } from "react";
import { ipcErrorMessage } from "@milagre/shared/result";
import { SECRETS_COPY, loginHost, secretNameProblem, type SecretInput, type SecretSummary, type SecretUse } from "@milagre/shared/secrets";
import { ago } from "@milagre/shared/main-sync";
import { projectOfKey, sessionIdFromKey } from "@milagre/shared/agent-runs";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { EmptyState } from "../primitives/EmptyState";
import { Input } from "../primitives/Field";
import { InlineError } from "../primitives/InlineError";
import { Skeleton } from "../primitives/Skeleton";
import {
  EMPTY_SOURCE,
  FieldBlock,
  OptInsField,
  ScopeField,
  SourceField,
  scopeReady,
  sourceReady,
  type ScopeChoice,
  type SecretOptIns,
  type SecretScope,
  type SecretSource,
} from "./SecretFields";

export const NO_OPT_INS: SecretOptIns = { ambient: false, askEachUse: false, unattended: false };

export function secretTitle(secret: SecretSummary): string {
  return secret.login ? `${loginHost(secret.login.origin)}${secret.login.username ? ` · ${secret.login.username}` : ""}` : secret.name;
}

function optInsOf(secret: SecretSummary): SecretOptIns {
  return { ambient: secret.delivery === "ambient", askEachUse: secret.askEachUse, unattended: secret.unattended };
}

export function fieldsOf(scope: SecretScope, optIns: SecretOptIns, file: boolean, note: string) {
  return {
    projects: scope,
    delivery: optIns.ambient && !file ? ("ambient" as const) : ("on-demand" as const),
    askEachUse: optIns.askEachUse,
    unattended: optIns.unattended,
    note: note.trim() || null,
  };
}

function sourceInput(source: SecretSource, kept?: SecretSummary): Pick<SecretInput, "value" | "file" | "kind" | "fileName" | "login"> {
  if (source.mode === "file") return { file: source.path };
  if (kept?.kind === "login") return { value: source.value, kind: "login", login: kept.login };
  if (kept?.kind === "file") return { value: source.value, kind: "file", fileName: kept.fileName };
  return { value: source.value, kind: "text" };
}

/** A save in flight and its error, for a dialog whose primary action calls the host. */
export function useSaving(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      onDone();
    } catch (failure) {
      setError(ipcErrorMessage(failure));
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function FormActions({ busy, ready, label, onClose }: { busy: boolean; ready: boolean; label: string; onClose: () => void }) {
  return (
    <>
      <Button variant="secondary" onClick={onClose}>
        Cancel
      </Button>
      <Button type="submit" disabled={busy || !ready} data-secret-save>
        {label}
      </Button>
    </>
  );
}

export function AddSecretDialog({
  choices,
  existing,
  onClose,
  onSaved,
}: {
  choices: ScopeChoice[];
  existing: SecretSummary[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const nameId = useId();
  const noteId = useId();
  const [name, setName] = useState("");
  const [source, setSource] = useState<SecretSource>(EMPTY_SOURCE);
  const [note, setNote] = useState("");
  const [scope, setScope] = useState<SecretScope>("all");
  const [optIns, setOptIns] = useState<SecretOptIns>(NO_OPT_INS);
  const saving = useSaving(onSaved);
  const trimmed = name.trim();
  const problem = trimmed ? secretNameProblem(trimmed) : null;
  const replaces = !problem && existing.some((secret) => secret.name === trimmed);
  const file = source.mode === "file";
  const ready = Boolean(trimmed) && !problem && sourceReady(source) && scopeReady(scope);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || saving.busy) return;
    void saving.run(() => window.milagre.secrets.set({ name: trimmed, ...sourceInput(source), ...fieldsOf(scope, optIns, file, note) }));
  };
  return (
    <Dialog
      as="form"
      data-secret-dialog="add"
      title={SECRETS_COPY.add}
      width={520}
      footer="bar"
      onSubmit={submit}
      onClose={onClose}
      actions={<FormActions busy={saving.busy} ready={ready} label={SECRETS_COPY.add} onClose={onClose} />}
      className="grid gap-5 pt-4"
    >
      <FieldBlock label={SECRETS_COPY.name} htmlFor={nameId}>
        <Input
          id={nameId}
          data-secret-name
          autoFocus
          value={name}
          placeholder="NPM_TOKEN"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          aria-invalid={Boolean(problem)}
          onChange={(event) => setName(event.target.value)}
          className="font-mono"
        />
        {problem ? <InlineError size={12}>{problem}</InlineError> : replaces && <p className="text-12 text-ink-3">{SECRETS_COPY.saveAs.replaces(trimmed)}</p>}
      </FieldBlock>
      <SourceField source={source} onChange={setSource} />
      <FieldBlock label={SECRETS_COPY.note} htmlFor={noteId}>
        <Input id={noteId} data-secret-note value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
      </FieldBlock>
      <ScopeField scope={scope} onChange={setScope} choices={choices} />
      <OptInsField value={optIns} onChange={setOptIns} file={file} />
      <InlineError size={12}>{saving.error}</InlineError>
    </Dialog>
  );
}

export function ReplaceSecretDialog({ secret, onClose, onSaved }: { secret: SecretSummary; onClose: () => void; onSaved: () => void }) {
  const [source, setSource] = useState<SecretSource>(EMPTY_SOURCE);
  const saving = useSaving(onSaved);
  const file = source.mode === "file" || secret.kind === "file";
  const login = secret.kind === "login";
  const ready = sourceReady(source);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || saving.busy) return;
    void saving.run(() =>
      window.milagre.secrets.set({
        name: secret.name,
        ...sourceInput(source, secret),
        ...fieldsOf(secret.projects, optInsOf(secret), file, secret.note ?? ""),
      }),
    );
  };
  return (
    <Dialog
      as="form"
      data-secret-dialog="replace"
      title={login ? SECRETS_COPY.logins.replacePassword : SECRETS_COPY.replace}
      description={<span className={login ? undefined : "font-mono"}>{secretTitle(secret)}</span>}
      width={480}
      onSubmit={submit}
      onClose={onClose}
      actions={<FormActions busy={saving.busy} ready={ready} label={login ? SECRETS_COPY.logins.replacePassword : SECRETS_COPY.replace} onClose={onClose} />}
      className="grid gap-3 pt-4"
    >
      <SourceField source={source} onChange={setSource} allowFile={!login} label={login ? SECRETS_COPY.logins.password : undefined} />
      <InlineError size={12}>{saving.error}</InlineError>
    </Dialog>
  );
}

export function EditSecretDialog({
  secret,
  choices,
  onClose,
  onSaved,
}: {
  secret: SecretSummary;
  choices: ScopeChoice[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const noteId = useId();
  const [note, setNote] = useState(secret.note ?? "");
  const [scope, setScope] = useState<SecretScope>(secret.projects);
  const [optIns, setOptIns] = useState<SecretOptIns>(optInsOf(secret));
  const saving = useSaving(onSaved);
  const file = secret.kind === "file";
  const login = secret.kind === "login";
  const ready = scopeReady(scope);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || saving.busy) return;
    void saving.run(() => window.milagre.secrets.update({ name: secret.name, ...fieldsOf(scope, optIns, file, note) }));
  };
  return (
    <Dialog
      as="form"
      data-secret-dialog="edit"
      title={SECRETS_COPY.edit}
      description={<span className={login ? undefined : "font-mono"}>{secretTitle(secret)}</span>}
      width={520}
      footer="bar"
      onSubmit={submit}
      onClose={onClose}
      actions={<FormActions busy={saving.busy} ready={ready} label="Save" onClose={onClose} />}
      className="grid gap-5 pt-4"
    >
      <FieldBlock label={SECRETS_COPY.note} htmlFor={noteId}>
        <Input id={noteId} data-secret-note value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
      </FieldBlock>
      <ScopeField scope={scope} onChange={setScope} choices={choices} />
      <OptInsField value={optIns} onChange={setOptIns} file={file} login={login} />
      <InlineError size={12}>{saving.error}</InlineError>
    </Dialog>
  );
}

export function DeleteSecretDialog({ secret, onClose, onDeleted }: { secret: SecretSummary; onClose: () => void; onDeleted: () => void }) {
  const saving = useSaving(onDeleted);
  return (
    <Dialog
      role="alertdialog"
      data-secret-dialog="delete"
      title={SECRETS_COPY.remove}
      description={
        secret.login ? SECRETS_COPY.logins.removeConfirm(loginHost(secret.login.origin), secret.login.username) : SECRETS_COPY.removeConfirm(secret.name)
      }
      width={420}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            data-secret-delete-confirm
            disabled={saving.busy}
            onClick={() => void saving.run(() => window.milagre.secrets.remove({ name: secret.name }))}
          >
            {SECRETS_COPY.remove}
          </Button>
        </>
      }
    >
      <InlineError size={12} className="mt-3">
        {saving.error}
      </InlineError>
    </Dialog>
  );
}

/** Where a use came from: the Chat's Project by its name here (or its folder) and the Chat's number. */
function chatLabel(chatId: string, projectNames: ReadonlyMap<string, string>): string {
  const project = projectOfKey(chatId);
  const name = projectNames.get(project) ?? project.split("/").findLast(Boolean) ?? project;
  const id = sessionIdFromKey(chatId);
  return Number.isFinite(id) ? `${name} · Chat ${id}` : name;
}

export function SecretLogDialog({ secret, projectNames, onClose }: { secret: SecretSummary; projectNames: ReadonlyMap<string, string>; onClose: () => void }) {
  const [uses, setUses] = useState<SecretUse[] | null>(null);
  const [error, setError] = useState("");
  const [now] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    window.milagre.secrets.log({ name: secret.name }).then(
      (list) => live && setUses(list),
      (failure) => live && setError(ipcErrorMessage(failure)),
    );
    return () => {
      live = false;
    };
  }, [secret.name]);
  return (
    <Dialog
      data-secret-dialog="log"
      title={SECRETS_COPY.log}
      description={<span className="font-mono">{secret.name}</span>}
      width={560}
      onClose={onClose}
      className="pt-3"
    >
      {error ? (
        <InlineError size={12}>{error}</InlineError>
      ) : uses === null ? (
        <div className="grid gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : uses.length === 0 ? (
        <EmptyState size="compact" title={SECRETS_COPY.noUses} />
      ) : (
        <ul className="divide-y divide-line rounded-card border border-line">
          {uses.map((use) => (
            <li key={`${use.at}:${use.chatId}:${use.command ?? ""}`} data-secret-use className="grid gap-0.5 px-3 py-2">
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <span className="truncate text-13 text-ink">{chatLabel(use.chatId, projectNames)}</span>
                <time dateTime={new Date(use.at).toISOString()} title={new Date(use.at).toLocaleString()} className="shrink-0 text-12 text-ink-3 tabular-nums">
                  {ago(use.at, now)}
                </time>
              </div>
              <div className="flex min-w-0 items-baseline gap-2 text-12 text-ink-3">
                <span className="min-w-0 flex-1 truncate font-mono text-ink-2">{use.command ?? SECRETS_COPY.ambient.label}</span>
                <span className="shrink-0">{use.computer}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

type ImportResult = { imported: string[]; skipped: { name: string; reason: string }[] };

export function ImportSecretsDialog({
  file,
  choices,
  onClose,
  onImported,
}: {
  file: { path: string; fileName: string };
  choices: ScopeChoice[];
  onClose: () => void;
  onImported: () => void;
}) {
  const [scope, setScope] = useState<SecretScope>("all");
  const [optIns, setOptIns] = useState<SecretOptIns>(NO_OPT_INS);
  const [result, setResult] = useState<ImportResult | null>(null);
  const saving = useSaving(onImported);
  const ready = scopeReady(scope);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || saving.busy) return;
    void saving.run(async () => setResult(await window.milagre.secrets.importEnv({ file: file.path, ...fieldsOf(scope, optIns, false, "") })));
  };
  if (result)
    return (
      <Dialog
        data-secret-dialog="import-result"
        title={SECRETS_COPY.imported(result.imported.length)}
        description={<span className="font-mono">{file.fileName}</span>}
        width={480}
        onClose={onClose}
        actions={<Button onClick={onClose}>Done</Button>}
        className="grid gap-4 pt-3"
      >
        {result.imported.length > 0 && (
          <ul data-secret-imported className="flex flex-wrap gap-1.5">
            {result.imported.map((name) => (
              <li key={name} className="rounded-chip bg-field px-2 py-0.5 font-mono text-12 text-ink-2">
                {name}
              </li>
            ))}
          </ul>
        )}
        {result.skipped.length > 0 && (
          <section className="grid gap-1.5">
            <h3 className="text-12 font-medium text-ink-2">{SECRETS_COPY.skipped}</h3>
            <ul data-secret-skipped className="divide-y divide-line rounded-card border border-line">
              {result.skipped.map((entry) => (
                <li key={entry.name} className="grid gap-0.5 px-3 py-2">
                  <span className="font-mono text-12 text-ink">{entry.name}</span>
                  <span className="text-12 text-ink-3">{entry.reason}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </Dialog>
    );
  return (
    <Dialog
      as="form"
      data-secret-dialog="import"
      title={SECRETS_COPY.importEnv}
      description={<span className="font-mono">{file.fileName}</span>}
      width={520}
      footer="bar"
      onSubmit={submit}
      onClose={onClose}
      actions={<FormActions busy={saving.busy} ready={ready} label="Import" onClose={onClose} />}
      className="grid gap-5 pt-4"
    >
      <ScopeField scope={scope} onChange={setScope} choices={choices} />
      <OptInsField value={optIns} onChange={setOptIns} file={false} />
      <InlineError size={12}>{saving.error}</InlineError>
    </Dialog>
  );
}
