import { useId, useState, type FormEvent } from "react";
import { SECRETS_COPY, loginHost, loginName, loginSite } from "@milagre/shared/secrets";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { Input } from "../primitives/Field";
import { InlineError } from "../primitives/InlineError";
import { FormActions, fieldsOf, NO_OPT_INS, useSaving } from "./SecretDialogs";
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

export function AddLoginDialog({ choices, onClose, onSaved }: { choices: ScopeChoice[]; onClose: () => void; onSaved: () => void }) {
  const siteId = useId();
  const userId = useId();
  const noteId = useId();
  const [site, setSite] = useState("");
  const [username, setUsername] = useState("");
  const [source, setSource] = useState<SecretSource>(EMPTY_SOURCE);
  const [note, setNote] = useState("");
  const [scope, setScope] = useState<SecretScope>("all");
  const [unattended, setUnattended] = useState(false);
  const saving = useSaving(onSaved);
  const { origin, error: siteError } = loginSite(site);
  const ready = Boolean(origin) && sourceReady(source) && scopeReady(scope);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!origin || source.mode !== "value" || !ready || saving.busy) return;
    const login = { origin, username: username.trim() };
    const optIns: SecretOptIns = { ...NO_OPT_INS, unattended };
    void saving.run(() =>
      window.milagre.secrets.set({
        name: loginName(origin, login.username),
        kind: "login",
        login,
        value: source.value,
        ...fieldsOf(scope, optIns, false, note),
      }),
    );
  };
  return (
    <Dialog
      as="form"
      data-secret-dialog="add-login"
      title={SECRETS_COPY.logins.add}
      width={520}
      footer="bar"
      onSubmit={submit}
      onClose={onClose}
      actions={<FormActions busy={saving.busy} ready={ready} label={SECRETS_COPY.logins.add} onClose={onClose} />}
      className="grid gap-5 pt-4"
    >
      <FieldBlock label={SECRETS_COPY.logins.site} htmlFor={siteId}>
        <Input
          id={siteId}
          data-login-site
          autoFocus
          value={site}
          placeholder={SECRETS_COPY.logins.sitePlaceholder}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={Boolean(siteError)}
          onChange={(event) => setSite(event.target.value)}
          className="font-mono"
        />
        {siteError ? (
          <InlineError size={12}>{siteError}</InlineError>
        ) : (
          origin && origin !== site.trim() && <p className="text-12 text-ink-3">{loginHost(origin)}</p>
        )}
      </FieldBlock>
      <FieldBlock label={SECRETS_COPY.logins.username} htmlFor={userId}>
        <Input
          id={userId}
          data-login-username
          value={username}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          onChange={(event) => setUsername(event.target.value)}
        />
      </FieldBlock>
      <SourceField source={source} onChange={setSource} allowFile={false} label={SECRETS_COPY.logins.password} />
      <FieldBlock label={SECRETS_COPY.note} htmlFor={noteId}>
        <Input id={noteId} data-secret-note value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
      </FieldBlock>
      <ScopeField scope={scope} onChange={setScope} choices={choices} />
      <OptInsField value={{ ...NO_OPT_INS, unattended }} onChange={(next) => setUnattended(next.unattended)} file={false} login />
      <InlineError size={12}>{saving.error}</InlineError>
    </Dialog>
  );
}

type LoginImport = { imported: string[]; skipped: { name: string; site: string; reason: string }[] };

export function ImportLoginsDialog({
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
  const [result, setResult] = useState<LoginImport | null>(null);
  const saving = useSaving(onImported);
  const ready = scopeReady(scope);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || saving.busy) return;
    void saving.run(async () => setResult(await window.milagre.secrets.importLogins({ file: file.path, projects: scope })));
  };
  if (result)
    return (
      <Dialog
        data-secret-dialog="import-logins-result"
        title={SECRETS_COPY.logins.imported(result.imported.length)}
        description={<span className="font-mono">{file.fileName}</span>}
        width={480}
        onClose={onClose}
        actions={<Button onClick={onClose}>Done</Button>}
        className="grid gap-4 pt-3"
      >
        {result.skipped.length > 0 && (
          <section className="grid gap-1.5">
            <h3 className="text-12 font-medium text-ink-2">{SECRETS_COPY.skipped}</h3>
            <ul data-secret-skipped className="divide-y divide-line rounded-card border border-line">
              {result.skipped.map((entry) => (
                <li key={`${entry.name}:${entry.site}`} className="grid gap-0.5 px-3 py-2">
                  <span className="truncate font-mono text-12 text-ink">{entry.site}</span>
                  <span className="text-12 text-ink-3">{entry.reason}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="text-12 text-ink-3">{SECRETS_COPY.logins.deleteExport}</p>
      </Dialog>
    );
  return (
    <Dialog
      as="form"
      data-secret-dialog="import-logins"
      title={SECRETS_COPY.logins.importPasswords}
      description={<span className="font-mono">{file.fileName}</span>}
      width={520}
      footer="bar"
      onSubmit={submit}
      onClose={onClose}
      actions={<FormActions busy={saving.busy} ready={ready} label={SECRETS_COPY.logins.import} onClose={onClose} />}
      className="grid gap-5 pt-4"
    >
      <ScopeField scope={scope} onChange={setScope} choices={choices} />
      <p className="text-12 text-ink-3">{SECRETS_COPY.logins.deleteExport}</p>
      <InlineError size={12}>{saving.error}</InlineError>
    </Dialog>
  );
}
