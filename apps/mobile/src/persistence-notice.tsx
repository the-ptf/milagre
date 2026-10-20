import { persistenceFailureDetail } from "@milagre/shared/model-copy";
import { useState } from "react";
import type { PersistenceFailure } from "@milagre/shared/model";
import type { Client } from "./client";
import { ErrorNotice } from "./ui";

/** Kept in the measured composer dock, outside scrollable history and pending approval cards. */
export function PersistenceNotice({
  client,
  scope,
  name,
  failure,
  offline,
}: {
  client: Client;
  scope: string;
  name: string;
  failure?: PersistenceFailure;
  offline: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  if (!failure) return null;
  async function retry() {
    setPending(true);
    setError("");
    try {
      await client.call("scope:retry-save", [scope]);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setPending(false);
    }
  }
  const saving = pending || failure.saving;
  const detail = error ? persistenceFailureDetail({ error, saving: false }) : persistenceFailureDetail(failure);
  return (
    <ErrorNotice
      message={`Changes to ${name} haven't been saved on your computer. ${offline ? "Computer disconnected. Reconnect to check saving." : `Changes are kept in memory. Keep your computer running until saving succeeds.\n${detail}`}`}
      retry={() => void retry()}
      retryTitle={saving && !offline ? "Saving..." : "Retry saving"}
      disabled={offline || saving}
      loading={saving && !offline}
    />
  );
}
