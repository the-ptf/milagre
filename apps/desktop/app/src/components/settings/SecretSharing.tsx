import { useCallback, useEffect, useState } from "react";
import { ipcErrorMessage } from "@milagre/shared/result";
import { SECRETS_COPY, type SecretSharingComputer } from "@milagre/shared/secrets";
import { subscribeComputers } from "../../lib/computers-store";
import { Checkbox } from "../primitives/Checkbox";
import { EmptyState } from "../primitives/EmptyState";
import { InlineError } from "../primitives/InlineError";
import { Skeleton } from "../primitives/Skeleton";
import { Group } from "./SettingsGroup";

/** The paired computers this computer's secrets go to, read again when secrets or computers change. */
function useSharing() {
  const [list, setList] = useState<SecretSharingComputer[] | null>(null);
  const [error, setError] = useState("");
  const read = useCallback(async () => {
    try {
      setList(await window.milagre.secrets.sharing());
      setError("");
    } catch (failure) {
      setError(ipcErrorMessage(failure));
    }
  }, []);
  useEffect(() => {
    void read();
    const stopSecrets = window.milagre.secrets.onChanged(() => void read());
    const stopComputers = subscribeComputers(() => void read());
    return () => {
      stopSecrets();
      stopComputers();
    };
  }, [read]);
  return { list, setList, error, setError };
}

function SharingRow({ computer, busy, onChange }: { computer: SecretSharingComputer; busy: boolean; onChange: (on: boolean) => void }) {
  const id = `secret-share-${computer.id}`;
  return (
    <div data-secret-share={computer.id} className="flex min-h-12 items-center gap-3 px-4 py-2">
      <Checkbox id={id} checked={computer.shared} disabled={busy} onCheckedChange={(next) => onChange(next === true)} />
      <label htmlFor={id} className={`grid min-w-0 flex-1 gap-0.5 ${busy ? "" : "cursor-pointer"}`}>
        <span className="truncate text-13 font-medium text-ink">{computer.name}</span>
        {computer.pendingRemoval && <span className="text-12 text-ink-3">{SECRETS_COPY.sharing.removing(computer.name)}</span>}
      </label>
      <span className="flex shrink-0 items-center gap-1.5 text-12 text-ink-3">
        <span className={`size-1.5 rounded-full ${computer.online ? "bg-green" : "bg-ink-4"}`} />
        {computer.online ? SECRETS_COPY.sharing.online : SECRETS_COPY.sharing.offline}
      </span>
    </div>
  );
}

/** Settings › Secrets › Share with: one checkbox per paired computer (docs/secrets.md, Sharing between computers). */
export function SecretSharing() {
  const { list, setList, error, setError } = useSharing();
  const [busy, setBusy] = useState<string | null>(null);
  const share = async (computer: string, on: boolean) => {
    setBusy(computer);
    setError("");
    try {
      setList(await window.milagre.secrets.share({ computer, on }));
    } catch (failure) {
      setError(ipcErrorMessage(failure));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Group title={SECRETS_COPY.sharing.title} footer={list?.length ? SECRETS_COPY.sharing.intro : undefined}>
        {list === null ? (
          <div className="p-4">
            <Skeleton className="h-6" />
          </div>
        ) : list.length === 0 ? (
          <EmptyState data-secrets-share-empty size="compact" title={SECRETS_COPY.sharing.empty} />
        ) : (
          <div data-secrets-share className="divide-y divide-line">
            {list.map((computer) => (
              <SharingRow key={computer.id} computer={computer} busy={busy !== null} onChange={(on) => void share(computer.id, on)} />
            ))}
          </div>
        )}
      </Group>
      <InlineError size={12} className="mt-2 px-1">
        {error}
      </InlineError>
    </>
  );
}
