import { persistenceFailureDetail } from "@milagre/shared/model-copy";
import { useState, type ReactNode } from "react";
import type { PersistenceFailure } from "@milagre/shared/model";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeForKey } from "../lib/computer-bridge";
import { Button } from "./primitives/Button";
import { InlineError } from "./primitives/InlineError";
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
    // A blocking failure with a way out: the error card, on a surface (with the overlay shadow) because it floats over the app.
    <div data-save-failure className="mb-2 rounded-card bg-surface shadow-overlay" style={{ animation: "fade-up var(--duration-slow) var(--ease-enter) both" }}>
      <InlineError
        variant="card"
        action={
          <Button variant="secondary" size={28} disabled={offline || saving} onClick={() => void retry()}>
            {saving && !offline ? "Saving…" : "Retry saving"}
          </Button>
        }
      >
        <span className="block font-medium">Changes to {name} haven't been saved on your computer.</span>
        <span className="mt-1 block">
          {offline ? "Computer disconnected. Reconnect to check saving." : "Changes are kept in memory. Keep your computer running until saving succeeds."}
        </span>
        {!offline && (
          <span className="mt-1 block text-12">{error ? persistenceFailureDetail({ error, saving: false }) : persistenceFailureDetail(failure)}</span>
        )}
      </InlineError>
    </div>
  );
}

/** Save warnings outlive view changes and cannot be dismissed while data remains unsaved. */
export function PersistenceNotices({ scopes, children }: { scopes: UnsavedScope[]; children?: ReactNode }) {
  if (!scopes.length && !children) return null;
  return (
    <div className="fixed inset-x-4 top-12 z-50 mx-auto max-w-2xl no-drag">
      <ScrollArea className="flex max-h-[40vh] flex-col gap-2">
        {children}
        {scopes.map((scope) => (
          <SaveFailure key={scope.scope} {...scope} />
        ))}
      </ScrollArea>
    </div>
  );
}
