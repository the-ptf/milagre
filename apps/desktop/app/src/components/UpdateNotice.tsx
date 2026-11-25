import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import { AUTO_UPDATE_WAITING } from "@milagre/shared/auto-update";
import { useProviderUpdates, type ProviderUpdateTransport } from "@milagre/shared/use-provider-updates";
import { updatePill, type ProviderUpdateItem } from "@milagre/shared/provider-update-view";
import type { UpdateState } from "../electron";
import { useMotionScale } from "../lib/ease";
import { useDismiss } from "../lib/use-dismiss";
import { HIDDEN_FACE, MORPH_SURFACE, morphFace, useSize } from "./motion/morph";
import { UpdateReleaseNotes } from "./UpdateReleaseNotes";
import { ProviderUpdateBody, ProviderUpdateRow, UpdateLogos, UpdateMark, updateTitle } from "./ProviderUpdateCard";
import { Cancel01Icon, Download04Icon, GiftIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Button, IconButton } from "./primitives/Button";
import { Icon } from "./primitives/Icon";
import { InlineError } from "./primitives/InlineError";
import { ProgressBar } from "./primitives/ProgressBar";
import { SpinnerRing } from "./primitives/SpinnerRing";

const Updates = createContext<UpdateState | null>(null);
const SlotRegistry = createContext<((slot: HTMLElement) => () => void) | null>(null);
export const useAppUpdates = () => useContext(Updates);
export const showUpdateNotice = () => window.dispatchEvent(new Event("milagre:show-update"));
/** Fired after a provider CLI update installs, so the model picker reads the CLIs again. */
export const PROVIDERS_UPDATED = "milagre:providers-updated";
const DONE_LINGER_MS = 4000;
const DONE_CLOSE_MS = 1600;

type Providers = ReturnType<typeof useProviderUpdates>;

export function UpdateSettingsBadge() {
  const state = useAppUpdates();
  if (!state?.version || !["downloaded", "downloading", "error"].includes(state.status)) return null;
  return <span role="status" aria-label="Update available" className="absolute right-1 top-1 size-1.5 rounded-full bg-accent" />;
}

export function UpdateShell({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [slots, setSlots] = useState<HTMLElement[]>([]);
  const [shown, setShown] = useState<ReadonlySet<HTMLElement>>(() => new Set());
  const [register] = useState(() => (slot: HTMLElement) => {
    setSlots((previous) => [...previous, slot]);
    const mark = (visible: boolean) =>
      setShown((previous) => {
        if (previous.has(slot) === visible) return previous;
        const next = new Set(previous);
        if (visible) next.add(slot);
        else next.delete(slot);
        return next;
      });
    mark(slot.checkVisibility());
    const observer = new IntersectionObserver((entries) => mark(entries.at(-1)?.isIntersecting ?? false));
    observer.observe(slot);
    return () => {
      observer.disconnect();
      setSlots((previous) => previous.filter((item) => item !== slot));
      mark(false);
    };
  });
  useEffect(() => {
    let changed = false;
    const off = window.milagre.onUpdateState((next) => {
      changed = true;
      setState(next);
    });
    async function load() {
      try {
        const next = await window.milagre.getUpdateState();
        if (!changed) setState(next);
      } catch {}
    }
    void load();
    return () => {
      changed = true;
      off();
    };
  }, []);
  const transport = useMemo<ProviderUpdateTransport>(
    () => ({
      read: async () => (await window.milagre.getProviderUpdates?.()) ?? [],
      install: async (update) => {
        const result = await window.milagre.updateCli(update.provider, update.version);
        if (result.ok) window.dispatchEvent(new Event(PROVIDERS_UPDATED));
        return result;
      },
      watch: (listener) => window.milagre.onCliProgress?.((progress) => listener(progress)) ?? (() => {}),
    }),
    [],
  );
  const providers = useProviderUpdates(transport);
  return (
    <Updates.Provider value={state}>
      <SlotRegistry.Provider value={register}>
        {children}
        <UpdateNotice state={state} providers={providers} slot={slots.findLast((slot) => shown.has(slot)) ?? null} />
      </SlotRegistry.Provider>
    </Updates.Provider>
  );
}

export function UpdatePillSlot({ className = "" }: { className?: string }) {
  const register = useContext(SlotRegistry);
  const ref = useCallback((slot: HTMLDivElement | null) => (slot && register ? register(slot) : undefined), [register]);
  return <div ref={ref} className={`pointer-events-none absolute left-1/2 z-30 -translate-x-1/2 ${className}`} />;
}

function appTitle(state: UpdateState) {
  switch (state.status) {
    case "installing":
      return "Restarting Milagre";
    case "downloaded":
      return "Update available";
    case "downloading":
      return "Downloading update";
    case "error":
      return "Update failed";
    case "checking":
      return "Checking for updates";
    default:
      return "Up to date";
  }
}

function appDescription(state: UpdateState, version: string) {
  switch (state.status) {
    case "downloaded":
      return `${version ? `v${version}` : "The update"} is ready to install.`;
    case "installing":
      return "Saving your work and restarting with the new version.";
    case "downloading":
      return "You can keep working while Milagre downloads the update.";
    case "up-to-date":
      return "You have the latest version of Milagre.";
    case "checking":
      return "Looking for a newer version of Milagre.";
    default:
      return "The update could not finish.";
  }
}

function AppUpdateBody({
  state,
  error,
  busy,
  pending,
  onAct,
  onNotes,
  notesTrigger,
}: {
  state: UpdateState;
  error: string | undefined;
  busy: boolean;
  pending: boolean;
  onAct: () => void;
  onNotes: () => void;
  notesTrigger: Ref<HTMLButtonElement>;
}) {
  const version = state.version ?? "";
  const ready = state.status === "downloaded";
  const installing = state.status === "installing";
  const percent = Math.round(Math.max(0, Math.min(100, state.progress || 0)));
  return (
    <>
      <div id="update-description" className="mt-3 text-13 text-ink-2" aria-live="polite">
        <p>{appDescription(state, version)}</p>
        {ready && <p className="mt-2">{state.auto ? AUTO_UPDATE_WAITING : "Restarting Milagre will stop running agents."}</p>}
      </div>
      {state.status === "downloading" && (
        <div className="mt-4 flex items-center gap-3">
          <ProgressBar value={percent / 100} size={6} label="Update download" className="flex-1" />
          <span className="text-12 tabular-nums text-ink-2">{percent}%</span>
        </div>
      )}
      <InlineError className="mt-3">{error}</InlineError>
      <div className="mt-5 flex gap-2">
        {version && (
          <Button ref={notesTrigger} variant="secondary" className="flex-1" onClick={onNotes}>
            What's new
          </Button>
        )}
        {(ready || state.status === "error" || installing) && (
          <Button data-install={ready || installing ? "" : undefined} className="flex-1" disabled={busy} onClick={onAct}>
            {installing || pending ? "Restarting…" : ready ? "Install & restart" : "Try again"}
          </Button>
        )}
      </div>
    </>
  );
}

function AppUpdateRow({ state, cliLeft, busy, onAct }: { state: UpdateState; cliLeft: boolean; busy: boolean; onAct: () => void }) {
  const percent = Math.round(Math.max(0, Math.min(100, state.progress || 0)));
  const detail =
    state.status === "downloading"
      ? `Downloading · ${percent}%`
      : state.status === "error"
        ? (state.error ?? "The update could not finish.")
        : state.status === "installing"
          ? "Restarting…"
          : "Restarts Milagre";
  return (
    <li className="flex items-center gap-2.5 rounded-control px-2 py-2 hover:bg-hover">
      <Icon icon={GiftIcon} size={18} className="text-ink-2" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-13 font-medium">Milagre {state.version}</span>
        <span className={`truncate text-12 ${state.status === "error" ? "text-red-ink" : "text-ink-3"}`}>{detail}</span>
      </div>
      {state.status === "downloaded" && (
        <Button variant="secondary" size={24} disabled={busy || cliLeft} onClick={onAct}>
          Restart
        </Button>
      )}
      {state.status === "installing" && <SpinnerRing size={12} />}
    </li>
  );
}

function UpdatesList({
  state,
  app,
  items,
  providers,
  busy,
  onAct,
}: {
  state: UpdateState | null;
  app: boolean;
  items: ProviderUpdateItem[];
  providers: Providers;
  busy: boolean;
  onAct: () => void;
}) {
  const updating = items.some((item) => item.status === "updating");
  const left = items.filter((item) => item.status === "available" || item.status === "failed");
  const cliFirst = updating || items.some((item) => item.status === "available");
  const ready = app && state?.status === "downloaded";
  return (
    <>
      <ul className="-mx-2 mt-3 flex flex-col gap-0.5">
        {app && state && <AppUpdateRow state={state} cliLeft={cliFirst} busy={busy} onAct={onAct} />}
        {items.map((item) => (
          <ProviderUpdateRow key={item.provider} item={item} locked={updating} onInstall={() => void providers.install(item.provider)} />
        ))}
      </ul>
      {ready && cliFirst && <p className="mt-2.5 text-12 text-ink-3">Milagre restarts last, after the CLIs finish. Restarting stops running agents.</p>}
      {left.length > 0 ? (
        <Button className="mt-4 w-full" disabled={updating} onClick={() => void providers.installAll()}>
          {left.length === items.length ? "Update all" : `Update ${left.length} more`}
        </Button>
      ) : (
        ready &&
        !updating && (
          <Button data-install="" className="mt-4 w-full" disabled={busy} onClick={onAct}>
            Install & restart
          </Button>
        )
      )}
    </>
  );
}

function CliPill({ items, app, appState, size }: { items: ProviderUpdateItem[]; app: boolean; appState: UpdateState | null; size: 14 | 18 }) {
  const pill = updatePill(items, app ? 1 : 0);
  const pending = items.some((item) => item.status !== "done");
  if (!pill) return null;
  if (pill.kind === "updating")
    return (
      <>
        <SpinnerRing size={size - 2} />
        <span>{pill.label}</span>
        {pill.percent !== null && <span className="tabular-nums text-ink-3">{pill.percent}%</span>}
      </>
    );
  if (pill.kind === "failed")
    return (
      <>
        <span aria-hidden="true" className="size-1.5 rounded-full bg-red" />
        <span>{pill.label}</span>
      </>
    );
  if (pill.kind === "done" || (!pending && app))
    return app && appState ? (
      <>
        <Icon icon={GiftIcon} size={size} />
        <span>Update available</span>
        <span aria-hidden="true" className="size-1.5 rounded-full bg-ink" />
      </>
    ) : (
      <>
        <Icon icon={Tick02Icon} size={size} className="text-green" />
        <span>{pill.label}</span>
      </>
    );
  return (
    <>
      <UpdateLogos providers={pill.providers} app={app} size={size} />
      <span>{pill.label}</span>
      <span aria-hidden="true" className="size-1.5 rounded-full bg-ink" />
    </>
  );
}

function noticeTitle(app: UpdateState | null, single: ProviderUpdateItem | undefined, pending: number) {
  if (app) return appTitle(app);
  if (single) return updateTitle(single);
  return pending ? `${pending} update${pending === 1 ? "" : "s"}` : "Everything is up to date";
}

function UpdateNotice({ state, providers, slot }: { state: UpdateState | null; providers: Providers; slot: HTMLElement | null }) {
  const [presentation, setPresentation] = useState({ version: "", open: false, app: false, dismissed: false });
  const [notesVersion, setNotesVersion] = useState<string | null>(null);
  const notesTrigger = useRef<HTMLButtonElement>(null);
  const [requestError, setRequestError] = useState("");
  const [pending, setPending] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const reduce = useReducedMotion();
  const motionScale = useMotionScale();
  const [pillSize, measurePill] = useSize();
  const [cardSize, measureCard] = useSize();
  const status = state?.status;
  const ready = status === "downloaded";
  const installing = status === "installing";
  const version = state?.version ?? "";
  if ((ready || (status === "error" && version)) && presentation.version !== version) {
    setPresentation({ version, open: true, app: true, dismissed: false });
    setRequestError("");
  }
  const items = providers.items;
  const cliBusy = items.some((item) => item.status === "updating");
  const open = presentation.open || installing;
  const appShown =
    !!state &&
    status !== "idle" &&
    status !== "unavailable" &&
    (installing || !presentation.dismissed) &&
    (ready || installing || status === "downloading" || status === "error" || (open && presentation.app));
  const single = !appShown && items.length === 1 ? items[0] : undefined;
  const mode = items.length === 0 ? "app" : single ? "cli" : "list";
  const allDone = items.length > 0 && items.every((item) => item.status === "done");
  const close = (returnFocus = false) => {
    if (installing || pending) return;
    refocus.current = returnFocus;
    setPresentation((previous) => ({ ...previous, open: false, app: false }));
  };
  const dismiss = () => {
    if (installing || pending || cliBusy) return;
    setPresentation((previous) => ({ ...previous, open: false, app: false, dismissed: previous.dismissed || appShown }));
    providers.dismiss();
    document.querySelector<HTMLButtonElement>("[data-update-settings]")?.focus();
  };
  useDismiss(
    open && !notesVersion,
    () => close(),
    (target) => !!root.current?.contains(target),
  );
  useEffect(() => {
    const show = () => {
      setPresentation((previous) => ({ ...previous, open: true, app: true, dismissed: false }));
      requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>("[role=dialog] button")?.focus());
    };
    window.addEventListener("milagre:show-update", show);
    return () => window.removeEventListener("milagre:show-update", show);
  }, []);
  const { clearDone } = providers;
  const closeAfterDone = open && mode === "cli";
  useEffect(() => {
    if (!allDone || appShown || (open && !closeAfterDone)) return;
    const timer = closeAfterDone
      ? setTimeout(() => setPresentation((previous) => ({ ...previous, open: false, app: false })), DONE_CLOSE_MS)
      : setTimeout(clearDone, DONE_LINGER_MS);
    return () => clearTimeout(timer);
  }, [allDone, appShown, open, closeAfterDone, clearDone]);
  useEffect(() => {
    if (!open && items.some((item) => item.status === "done") && !allDone) clearDone();
  }, [open, items, allDone, clearDone]);
  const notesShown = useRef(false);
  useLayoutEffect(() => {
    if (notesVersion) notesShown.current = true;
    else if (notesShown.current) {
      notesShown.current = false;
      notesTrigger.current?.focus();
    }
  }, [notesVersion]);
  useLayoutEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    root.current?.querySelector<HTMLButtonElement>("[data-face=pill]")?.focus();
  }, [open]);
  if (!appShown && !items.length) return null;
  const error = requestError || state?.error;
  const busy = pending || installing || status === "downloading" || status === "checking";
  async function act() {
    if (pending || installing) return;
    setPending(true);
    setRequestError("");
    try {
      if (ready) await window.milagre.installUpdate();
      else await window.milagre.checkForUpdates();
    } catch {
      setRequestError(ready ? "Could not restart Milagre. Try again." : "Could not check for updates. Try again.");
    } finally {
      setPending(false);
    }
  }
  const pendingCount = items.filter((item) => item.status !== "done").length + (appShown ? 1 : 0);
  const title = noticeTitle(mode === "app" ? state : null, single, pendingCount);
  const percent = Math.round(Math.max(0, Math.min(100, state?.progress || 0)));
  const appPill = installing || (status === "downloading" && !cliBusy) || mode === "app";
  const anchor = slot ? { left: "50%", x: "-50%" } : { left: 0 };
  const face = (shown: boolean) => ({ ...morphFace(shown, reduce, motionScale), style: anchor });
  const size = open ? cardSize : pillSize;
  const glyph: 14 | 18 = slot ? 14 : 18;
  const notice = (
    <div
      ref={root}
      data-update-notice=""
      className={`no-drag text-ink ${slot ? "pointer-events-auto" : "fixed bottom-4 left-4 z-50"}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open && !installing && !pending) {
          event.stopPropagation();
          close(true);
        }
      }}
    >
      <div
        style={size ? { width: size.width, height: size.height, borderRadius: open ? 14 : size.height / 2 } : undefined}
        className={`relative overflow-hidden bg-surface ${MORPH_SURFACE} ${
          open ? "shadow-overlay" : slot ? "shadow-[0_0_0_1px_var(--line-strong)]" : "shadow-btn"
        }`}
      >
        <motion.section
          ref={measureCard}
          data-face="card"
          role={open ? "dialog" : undefined}
          aria-label={open ? title : undefined}
          aria-describedby={open ? "update-description" : undefined}
          {...face(open)}
          className={`absolute bottom-0 w-[360px] max-w-[calc(100vw-2rem)] p-5 ${open ? "visible" : HIDDEN_FACE}`}
        >
          <div className="flex items-center gap-3">
            {single ? <UpdateMark item={single} /> : <Icon icon={mode === "app" ? GiftIcon : Download04Icon} size={18} className="text-ink-2" />}
            <h2 className="flex-1 text-15 font-semibold">{title}</h2>
            {!installing && !pending && !cliBusy && <IconButton label="Dismiss update" icon={Cancel01Icon} className="-mr-1" onClick={dismiss} />}
          </div>
          {mode === "app" && state && (
            <AppUpdateBody
              state={state}
              error={error}
              busy={busy}
              pending={pending}
              onAct={() => void act()}
              onNotes={() => setNotesVersion(version)}
              notesTrigger={notesTrigger}
            />
          )}
          {single && <ProviderUpdateBody item={single} onInstall={() => void providers.install(single.provider)} />}
          {mode === "list" && <UpdatesList state={state} app={appShown} items={items} providers={providers} busy={busy} onAct={() => void act()} />}
        </motion.section>
        <motion.button
          ref={measurePill}
          data-face="pill"
          type="button"
          aria-haspopup="dialog"
          onClick={() => {
            setPresentation((previous) => ({ ...previous, open: true }));
            requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>("[role=dialog] button")?.focus());
          }}
          {...face(!open)}
          className={`absolute bottom-0 flex items-center rounded-full font-medium whitespace-nowrap ${open ? HIDDEN_FACE : "visible transition-colors duration-fast"} hover:bg-hover focus-visible:-outline-offset-2 ${
            slot ? "h-6 gap-1.5 px-2.5 text-12" : "gap-2 px-3 py-2 text-12"
          }`}
        >
          {appPill && state ? (
            <>
              <Icon icon={GiftIcon} size={glyph} />
              <span>{status === "downloading" ? `Downloading update · ${percent}%` : appTitle(state)}</span>
              {ready && <span aria-hidden="true" className="size-1.5 rounded-full bg-ink" />}
            </>
          ) : (
            <CliPill items={items} app={appShown} appState={state} size={glyph} />
          )}
        </motion.button>
      </div>
    </div>
  );
  return (
    <>
      {slot ? createPortal(notice, slot) : notice}
      {notesVersion && <UpdateReleaseNotes version={notesVersion} onClose={() => setNotesVersion(null)} />}
    </>
  );
}
