import type { ReactNode } from "react";
import { ipcErrorMessage } from "@milagre/shared/result";
import { DotBackground } from "../components/DotBackground";
import { Notice as NoticeCard } from "../components/Notice";
import { PersistenceNotices, type UnsavedScope } from "../components/PersistenceNotice";
import { Button } from "../components/primitives/Button";
import { Dialog } from "../components/primitives/Dialog";
import { InlineError } from "../components/primitives/InlineError";
import type { RuntimeConnection } from "../electron";

export function StartupErrorScreen({
  error,
  splash,
  onRetry,
  onOpenAnother,
}: {
  error: string;
  splash: ReactNode;
  onRetry: () => void;
  onOpenAnother: () => void;
}) {
  return (
    <main data-startup-error className="flex min-h-screen items-center justify-center p-8 text-ink">
      {splash}
      <section className="w-full max-w-xl rounded-window bg-surface p-6 shadow-overlay" aria-labelledby="startup-error-title">
        <h1 id="startup-error-title" className="text-17 font-semibold">
          Project could not open
        </h1>
        <p role="alert" className="mt-3 break-words text-13 text-ink-2">
          {error}
        </p>
        <div className="mt-6 flex gap-3">
          <Button onClick={onRetry}>Retry</Button>
          <Button variant="secondary" onClick={onOpenAnother}>
            Open another project
          </Button>
        </div>
      </section>
    </main>
  );
}

/** No Project open and none loading: the sidebar beside a prompt to pick or add one. */
export function ChooseProjectScreen({
  splash,
  saveNotices,
  sidebar,
  notice,
  onAddProject,
  children,
}: {
  splash: ReactNode;
  saveNotices: ReactNode;
  sidebar: ReactNode;
  notice: ReactNode;
  onAddProject: () => void;
  children: ReactNode;
}) {
  return (
    <DotBackground>
      {splash}
      {saveNotices}
      <div aria-hidden className="title-drag fixed inset-x-0 top-0 z-50 h-[var(--window-chrome-height)]" />
      <div data-project-chooser className="flex h-screen w-full gap-3 text-ink">
        <div className="flex shrink-0 pt-[var(--window-chrome-height)] pb-3 pl-3">{sidebar}</div>
        <main className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <InlineError>{notice}</InlineError>
          <h1 className="text-22 font-semibold tracking-[-0.02em]">Choose a Project</h1>
          <p className="text-13 text-ink-3">Open a Project or Link from the sidebar, or add a Project.</p>
          <Button onClick={onAddProject}>Add Project</Button>
        </main>
      </div>
      {children}
    </DotBackground>
  );
}

/** The provider update card and the host's outdated or disconnected notices, over the unsaved-Chats notices. */
export function HostNotices({
  scopes,
  hostConnection,
  restartingHost,
  setRestartingHost,
  setNotice,
}: {
  scopes: UnsavedScope[];
  hostConnection: RuntimeConnection;
  restartingHost: boolean;
  setRestartingHost: (restarting: boolean) => void;
  setNotice: (notice: string) => void;
}) {
  return (
    <>
      <PersistenceNotices scopes={scopes}>
        {hostConnection.connected && hostConnection.hostOutdated && (
          <NoticeCard
            data-host-outdated
            className="no-drag"
            action={
              <Button
                size={28}
                className="shrink-0"
                disabled={restartingHost}
                onClick={() => {
                  setRestartingHost(true);
                  void window.milagre
                    .restartHost()
                    .catch((error) => setNotice(`Couldn't restart the host: ${ipcErrorMessage(error)}`))
                    .finally(() => setRestartingHost(false));
                }}
              >
                {restartingHost ? "Restarting…" : "Restart host"}
              </Button>
            }
          >
            {hostConnection.message ?? "Restart Milagre's background host to load large projects."}
          </NoticeCard>
        )}
        {!hostConnection.connected && (
          <NoticeCard data-host-disconnected className="no-drag">
            {hostConnection.failed ? (
              <>
                <p className="font-medium">Couldn't restart Milagre's background host</p>
                <p className="mt-1 text-ink-2">{hostConnection.message} Your draft is kept here. Quit and reopen Milagre to try again.</p>
              </>
            ) : (
              <>
                <p className="font-medium">Reconnecting to your computer</p>
                <p className="mt-1 text-ink-2">Your draft is kept here. Messages will be available when the host reconnects.</p>
              </>
            )}
          </NoticeCard>
        )}
      </PersistenceNotices>
    </>
  );
}

export function QuitErrorDialog({ error, setError }: { error: string; setError: (error: string) => void }) {
  return (
    <Dialog
      role="alertdialog"
      title="Chats could not be saved"
      width={448}
      actions={
        <Button autoFocus onClick={() => void window.milagre.retryQuit().catch((failure) => setError(ipcErrorMessage(failure)))}>
          Retry saving and quit
        </Button>
      }
    >
      <p className="mt-3 text-13">Keep Milagre open while you fix the storage problem, then retry saving.</p>
      <p className="mt-3 break-words text-13 text-ink-2">{error}</p>
    </Dialog>
  );
}
