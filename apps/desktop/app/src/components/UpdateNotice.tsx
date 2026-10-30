import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "motion/react";
import { AUTO_UPDATE_WAITING } from "@milagre/shared/auto-update";
import type { UpdateState } from "../electron";
import { useMotionScale } from "../lib/ease";
import { useDismiss } from "../lib/use-dismiss";
import { HIDDEN_FACE, MORPH_SURFACE, morphFace, useSize } from "./motion/morph";
import { UpdateReleaseNotes } from "./UpdateReleaseNotes";
import { Cancel01Icon, GiftIcon } from "@hugeicons/core-free-icons";
import { Button, IconButton } from "./primitives/Button";
import { Icon } from "./primitives/Icon";
import { InlineError } from "./primitives/InlineError";

const Updates = createContext<UpdateState | null>(null);
const SlotRegistry = createContext<((slot: HTMLElement) => () => void) | null>(null);
export const useAppUpdates = () => useContext(Updates);
export const showUpdateNotice = () => window.dispatchEvent(new Event("milagre:show-update"));

export function UpdateSettingsBadge() {
  const state = useAppUpdates();
  if (!state?.version || !["downloaded", "downloading", "error"].includes(state.status)) return null;
  return <span role="status" aria-label="Update available" className="absolute right-1 top-1 size-1.5 rounded-full bg-accent" />;
}

/** Lives above every screen so updates remain reachable without an open Project. */
export function UpdateShell({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UpdateState | null>(null);
  // The open Chat offers a spot above its composer; the latest one mounted holds the pill.
  const [slots, setSlots] = useState<HTMLElement[]>([]);
  // A Chat stays mounted but hidden behind Settings, the canvas or a diff; its slot then has no box and gives the pill up.
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
    // Read now so an open Chat takes the pill in this commit; the observer follows later hides and shows.
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
        <UpdateNotice state={state} slot={slots.findLast((slot) => shown.has(slot)) ?? null} />
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

function UpdateNotice({ state, slot }: { state: UpdateState | null; slot: HTMLElement | null }) {
  const [presentation, setPresentation] = useState({ version: "", open: false, dismissed: false });
  const [notesVersion, setNotesVersion] = useState<string | null>(null);
  const notesTrigger = useRef<HTMLButtonElement>(null);
  const [requestError, setRequestError] = useState("");
  const [pending, setPending] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // Escape collapses back to the pill; full dismissal hands focus to Settings.
  const refocus = useRef(false);
  const reduce = useReducedMotion();
  const motionScale = useMotionScale();
  // Both faces stay mounted and report their sizes; the surface takes the size of the one on show.
  const [pillSize, measurePill] = useSize();
  const [cardSize, measureCard] = useSize();
  const ready = state?.status === "downloaded";
  const installing = state?.status === "installing";
  const downloading = state?.status === "downloading";
  const failed = state?.status === "error";
  const version = state?.version ?? "";
  if ((ready || (failed && version)) && presentation.version !== version) {
    setPresentation({ version, open: true, dismissed: false });
    setRequestError("");
  }
  const open = presentation.open || installing;
  const close = (returnFocus = false) => {
    if (installing || pending) return;
    refocus.current = returnFocus;
    setPresentation((previous) => ({ ...previous, open: false }));
  };
  const dismiss = () => {
    if (installing || pending) return;
    setPresentation((previous) => ({ ...previous, open: false, dismissed: true }));
    document.querySelector<HTMLButtonElement>("[data-update-settings]")?.focus();
  };
  useDismiss(
    open && !notesVersion,
    () => close(),
    (target) => !!root.current?.contains(target),
  );
  useEffect(() => {
    const show = () => {
      setPresentation((previous) => ({ ...previous, open: true, dismissed: false }));
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
  if (presentation.dismissed && !open && !installing) return null;
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
  const face = (shown: boolean) => ({ ...morphFace(shown, reduce, motionScale), style: anchor });
  const size = open ? cardSize : pillSize;
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
      {/* One surface morphs between the pill and the card; both faces stay mounted and crossfade inside it. */}
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
            <Icon icon={GiftIcon} size={18} className="text-ink-2" />
            <h2 className="flex-1 text-15 font-semibold">{title}</h2>
            {!installing && !pending && <IconButton label="Dismiss update" icon={Cancel01Icon} className="-mr-1" onClick={dismiss} />}
          </div>
          <div id="update-description" className="mt-3 text-13 leading-relaxed text-ink-2" aria-live="polite">
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
            {ready && <p className="mt-2">{state.auto ? AUTO_UPDATE_WAITING : "Restarting Milagre will stop running agents."}</p>}
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
                <div className="h-full rounded-full bg-ink transition-[width] duration-base motion-reduce:transition-none" style={{ width: `${percent}%` }} />
              </div>
              <span className="text-12 tabular-nums text-ink-2">{percent}%</span>
            </div>
          )}
          <InlineError className="mt-3 leading-relaxed">{error}</InlineError>
          <div className="mt-5 flex gap-2">
            {version && (
              <Button ref={notesTrigger} variant="secondary" className="flex-1" onClick={() => setNotesVersion(version)}>
                What's new
              </Button>
            )}
            {(ready || failed || installing) && (
              <Button data-install={ready || installing ? "" : undefined} className="flex-1" disabled={busy} onClick={() => void act()}>
                {installing || pending ? "Restarting…" : ready ? "Install & restart" : "Try again"}
              </Button>
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
          className={`absolute bottom-0 flex items-center rounded-full font-medium whitespace-nowrap ${open ? HIDDEN_FACE : "visible transition-colors duration-fast"} hover:bg-hover focus-visible:-outline-offset-2 ${
            slot ? "h-6 gap-1.5 px-2.5 text-12" : "gap-2 px-3 py-2 text-12"
          }`}
        >
          <Icon icon={GiftIcon} size={slot ? 14 : 18} />
          <span>{downloading ? `Downloading update · ${percent}%` : title}</span>
          {ready && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-ink" />}
        </motion.button>
      </div>
    </div>
  );
  return (
    <>
      {slot ? createPortal(notice, slot) : notice}
      {notesVersion && (
        <UpdateReleaseNotes
          version={notesVersion}
          onClose={() => {
            setNotesVersion(null);
            notesTrigger.current?.focus();
          }}
        />
      )}
    </>
  );
}
