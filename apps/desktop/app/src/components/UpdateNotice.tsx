import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import type { UpdateState } from "../electron";
import { useDismiss } from "../lib/use-dismiss";
import { HIDDEN_FACE, MORPH_SURFACE, morphFace, useSize } from "./motion/morph";

const Updates = createContext<UpdateState | null>(null);
const SlotRegistry = createContext<((slot: HTMLElement) => () => void) | null>(null);
export const useAppUpdates = () => useContext(Updates);
export const showUpdateNotice = () => window.dispatchEvent(new Event("milagre:show-update"));

/** Lives above every screen so updates remain reachable without an open Project. */
export function UpdateShell({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UpdateState | null>(null);
  // The open Chat offers a spot above its composer; the latest one mounted holds the pill.
  const [slots, setSlots] = useState<HTMLElement[]>([]);
  const [register] = useState(() => (slot: HTMLElement) => {
    setSlots((previous) => [...previous, slot]);
    return () => setSlots((previous) => previous.filter((item) => item !== slot));
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
      } catch {
        /* A live state event can still recover the notice. */
      }
    }
    void load();
    return () => {
      changed = true;
      off();
    };
  }, []);
  return (
    <Updates.Provider value={state}>
      <SlotRegistry.Provider value={register}>
        {children}
        <UpdateNotice state={state} slot={slots.at(-1) ?? null} />
      </SlotRegistry.Provider>
    </Updates.Provider>
  );
}

/** Centres the pill above the composer, out of the chip row's flow. Without one, the pill sits at the window's bottom left. */
export function UpdatePillSlot({ className = "" }: { className?: string }) {
  const register = useContext(SlotRegistry);
  const ref = useCallback((slot: HTMLDivElement | null) => (slot && register ? register(slot) : undefined), [register]);
  return <div ref={ref} className={`pointer-events-none absolute left-1/2 z-30 -translate-x-1/2 ${className}`} />;
}

function Gift({ size = 20 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M12 8v13M12 8H7a3 3 0 1 1 3-3l2 3Zm0 0h5a3 3 0 1 0-3-3l-2 3Z" />
    </svg>
  );
}

function UpdateNotice({ state, slot }: { state: UpdateState | null; slot: HTMLElement | null }) {
  const [presentation, setPresentation] = useState({ version: "", open: false });
  const [requestError, setRequestError] = useState("");
  const [pending, setPending] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // Closing from the keyboard or the dismiss button hands focus back to the pill.
  const refocus = useRef(false);
  const reduce = useReducedMotion();
  // Both faces stay mounted and report their sizes; the surface takes the size of the one on show.
  const [pillSize, measurePill] = useSize();
  const [cardSize, measureCard] = useSize();
  const ready = state?.status === "downloaded";
  const installing = state?.status === "installing";
  const downloading = state?.status === "downloading";
  const failed = state?.status === "error";
  const version = state?.version ?? "";
  if ((ready || (failed && version)) && presentation.version !== version) {
    setPresentation({ version, open: true });
    setRequestError("");
  }
  const open = presentation.open || installing;
  const close = (returnFocus = false) => {
    if (installing || pending) return;
    refocus.current = returnFocus;
    setPresentation((previous) => ({ ...previous, open: false }));
  };
  useDismiss(
    open,
    () => close(),
    (target) => !!root.current?.contains(target),
  );
  useEffect(() => {
    const show = () => {
      setPresentation((previous) => ({ ...previous, open: true }));
      requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>("[role=dialog] button")?.focus());
    };
    window.addEventListener("milagre:show-update", show);
    return () => window.removeEventListener("milagre:show-update", show);
  }, []);
  useLayoutEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    root.current?.querySelector<HTMLButtonElement>("[data-face=pill]")?.focus();
  }, [open]);
  if (!state || (!open && !ready && !installing && !downloading && !failed)) return null;
  if (state.status === "idle" || state.status === "unavailable") return null;
  const title = installing
    ? "Restarting Milagre"
    : ready
      ? "Update available"
      : downloading
        ? "Downloading update"
        : failed
          ? "Update failed"
          : state.status === "checking"
            ? "Checking for updates"
            : "Up to date";
  const percent = Math.round(Math.max(0, Math.min(100, state.progress || 0)));
  const error = requestError || state.error;
  const busy = pending || installing || downloading || state.status === "checking";
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
  // Both faces hang from the pill's spot: centred above the composer, or the window's bottom left.
  const anchor = slot ? { left: "50%", x: "-50%" } : { left: 0 };
  const face = (shown: boolean) => ({ ...morphFace(shown, reduce), style: anchor });
  const size = open ? cardSize : pillSize;
  const notice = (
    <div
      ref={root}
      data-update-notice=""
      className={`text-ink [-webkit-app-region:no-drag] ${slot ? "pointer-events-auto" : "fixed bottom-4 left-4 z-50"}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open && !installing && !pending) {
          event.stopPropagation();
          close(true);
        }
      }}
    >
      {/* One surface morphs between the pill and the card; both faces stay mounted and crossfade inside it. */}
      <div
        style={size ? { width: size.width, height: size.height, borderRadius: open ? 16 : size.height / 2 } : undefined}
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
            <span className="text-ink-2">
              <Gift />
            </span>
            <h2 className="flex-1 text-[16px] font-medium tracking-[-0.02em]">{title}</h2>
            {!installing && !pending && (
              <button
                type="button"
                aria-label="Dismiss update"
                onClick={() => close(true)}
                className="-mr-1 rounded-md p-1 text-ink-3 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
              >
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="m6 6 12 12M18 6 6 18" />
                </svg>
              </button>
            )}
          </div>
          <div id="update-description" className="mt-3 text-[13px] leading-relaxed text-ink-2" aria-live="polite">
            <p>
              {ready
                ? `${version ? `v${version}` : "The update"} is ready to install.`
                : installing
                  ? "Saving your work and restarting with the new version."
                  : downloading
                    ? "You can keep working while Milagre downloads the update."
                    : state.status === "up-to-date"
                      ? "You have the latest version of Milagre."
                      : state.status === "checking"
                        ? "Looking for a newer version of Milagre."
                        : "The update could not finish."}
            </p>
            {ready && <p className="mt-2">Restarting Milagre will stop running agents.</p>}
          </div>
          {downloading && (
            <div className="mt-4 flex items-center gap-3">
              <div
                role="progressbar"
                aria-label="Update download"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-1.5 flex-1 overflow-hidden rounded-full bg-hover"
              >
                <div className="h-full rounded-full bg-ink transition-[width] motion-reduce:transition-none" style={{ width: `${percent}%` }} />
              </div>
              <span className="text-[12px] tabular-nums text-ink-2">{percent}%</span>
            </div>
          )}
          {error && (
            <p role="alert" className="mt-3 text-[13px] leading-relaxed text-red-500">
              {error}
            </p>
          )}
          <div className="mt-5 flex gap-2">
            {version && (
              <a
                href={`https://github.com/the-ptf/milagre-ade/releases/tag/v${encodeURIComponent(version)}`}
                target="_blank"
                rel="noreferrer"
                className="flex flex-1 items-center justify-center rounded-control border border-line-strong px-3 py-2.5 text-[13px] font-medium transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-ink"
              >
                What's new
              </a>
            )}
            {(ready || failed || installing) && (
              <button
                type="button"
                data-install={ready || installing ? "" : undefined}
                disabled={busy}
                onClick={() => void act()}
                className="flex-1 rounded-control bg-ink px-3 py-2.5 text-[13px] font-medium text-surface transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-wait disabled:opacity-60"
              >
                {installing || pending ? "Restarting…" : ready ? "Install & restart" : "Try again"}
              </button>
            )}
          </div>
        </motion.section>
        <motion.button
          ref={measurePill}
          data-face="pill"
          type="button"
          aria-haspopup="dialog"
          onClick={showUpdateNotice}
          {...face(!open)}
          className={`absolute bottom-0 flex items-center rounded-full font-medium whitespace-nowrap ${open ? HIDDEN_FACE : "visible transition-colors"} hover:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink ${
            slot ? "h-6 gap-1.5 px-2.5 text-[12px]" : "gap-2 px-3 py-2 text-[12px]"
          }`}
        >
          <Gift size={slot ? 14 : 20} />
          <span>{downloading ? `Downloading update · ${percent}%` : title}</span>
          {ready && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-ink" />}
        </motion.button>
      </div>
    </div>
  );
  return slot ? createPortal(notice, slot) : notice;
}
