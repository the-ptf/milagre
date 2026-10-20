import { persistenceFailureDetail } from "@milagre/shared/model-copy";
import { useState, type ReactNode } from "react";
import type { PersistenceFailure } from "@milagre/shared/model";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeForKey } from "../lib/computer-bridge";
import { Notice } from "./Notice";
import { ScrollArea } from "./primitives/ScrollArea";

export type UnsavedScope = { scope: string; name: string; failure: PersistenceFailure; offline: boolean };

export function SaveFailure({ scope, name, failure, offline }: UnsavedScope) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const saving = pending || failure.saving;
  async function retry() {
    setPending(true);
    setError("");
    try {
      await bridgeForKey(scope).retrySave(scope);
    } catch (reason) {
      setError(ipcErrorMessage(reason));
    } finally {
      setPending(false);
    }
  }
  return (
    <Notice
      data-save-failure
      className="mb-2"
      action={
        <button
          type="button"
          disabled={offline || saving}
          onClick={() => void retry()}
          className="shrink-0 rounded-control bg-ink px-3 py-2 text-xs font-medium text-surface disabled:opacity-40"
        >
          {saving && !offline ? "Saving..." : "Retry saving"}
        </button>
      }
    >
      <p className="font-medium">Changes to {name} haven't been saved on your computer.</p>
      <p className="mt-1 text-ink-2">
        {offline ? "Computer disconnected. Reconnect to check saving." : "Changes are kept in memory. Keep your computer running until saving succeeds."}
      </p>
      {!offline && <p className="mt-1 text-xs text-ink-3">{error ? persistenceFailureDetail({ error, saving: false }) : persistenceFailureDetail(failure)}</p>}
    </Notice>
  );
}

/** Save warnings outlive view changes and cannot be dismissed while data remains unsaved. */
export function PersistenceNotices({ scopes, children }: { scopes: UnsavedScope[]; children?: ReactNode }) {
  if (!scopes.length && !children) return null;
  return (
    <div className="fixed inset-x-4 top-12 z-50 mx-auto max-w-2xl [-webkit-app-region:no-drag]">
      <ScrollArea className="flex max-h-[40vh] flex-col gap-2">
        {children}
        {scopes.map((scope) => (
          <SaveFailure key={scope.scope} {...scope} />
        ))}
      </ScrollArea>
    </div>
  );
}
