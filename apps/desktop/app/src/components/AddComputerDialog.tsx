import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { LaptopIcon } from "@hugeicons/core-free-icons";
import { ipcErrorMessage } from "@milagre/shared/result";
import { privatePairingLink } from "@milagre/shared/pairing-link";
import { SettingCheckbox } from "./primitives/Checkbox";
import type { AddComputerResult, ComputerPreview, ComputerView } from "../electron";
import { thisComputer } from "../lib/shortcut-hints";

const FIELD =
  "h-9 w-full rounded-[9px] bg-field px-2.5 text-[12.5px] text-ink outline-none ring-1 ring-line-strong focus-visible:ring-accent placeholder:text-ink-3";

/**
 * Add computer (design add-computer v1): paste another Mac's pairing link, see the computer it names, and pair with it,
 * waiting while its owner clicks Allow there. Mounted only while open: other screens look for the page's one dialog.
 */
export function AddComputerDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (computer: ComputerView) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [link, setLink] = useState("");
  const [privateOnly, setPrivateOnly] = useState(false);
  let selectedLink = link.trim();
  let selectionError = "";
  try {
    if (selectedLink && privateOnly) selectedLink = privatePairingLink(selectedLink);
  } catch (cause) {
    selectionError = ipcErrorMessage(cause);
  }
  const [preview, setPreview] = useState<ComputerPreview | null>(null);
  const [name, setName] = useState("");
  const typedName = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const reads = useRef(0);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => window.milagre.onComputerAddPending(() => setWaiting(true)), []);
  // A parent that unmounts the dialog mid-pairing still stops it: nothing is left waiting on the other Mac's Allow.
  const addingNow = useRef(false);
  useEffect(() => {
    addingNow.current = adding;
  }, [adding]);
  useEffect(
    () => () => {
      if (addingNow.current) void window.milagre.computers.cancelAdd();
    },
    [],
  );

  // Each change to the link is read again before anything is sent; an older answer that arrives late is dropped.
  useEffect(() => {
    const text = selectedLink;
    const read = ++reads.current;
    setPreview(null);
    setError(null);
    if (selectionError) return setError(selectionError);
    if (!text) return;
    window.milagre.computers.preview(text).then(
      (found) => {
        if (read !== reads.current) return;
        setPreview(found);
        if (!typedName.current) setName(found.name);
      },
      (cause) => {
        if (read === reads.current) setError(ipcErrorMessage(cause));
      },
    );
  }, [selectedLink, selectionError]);

  const close = () => {
    if (adding) void window.milagre.computers.cancelAdd();
    onClose();
  };
  async function add() {
    if (!preview || adding) return;
    setAdding(true);
    setWaiting(false);
    setError(null);
    const result: AddComputerResult = await window.milagre.computers.add(selectedLink, { name: name.trim() || preview.name }).catch((cause: unknown) => ({
      ok: false as const,
      code: "failed",
      message: ipcErrorMessage(cause),
    }));
    // Cleared before onAdded unmounts the dialog, or the unmount cleanup would cancel a pairing that already succeeded.
    addingNow.current = false;
    setAdding(false);
    setWaiting(false);
    if (result.ok) onAdded(result.computer);
    else if (result.code !== "cancelled") setError(result.message);
  }
  async function paste() {
    try {
      setLink(await navigator.clipboard.readText());
    } catch {
      /* the field still takes ⌘V */
    }
  }

  return createPortal(
    <dialog
      ref={dialog}
      data-add-computer
      aria-labelledby="add-computer-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        // A press on the scrim (the dialog itself, outside its padded content) closes it, unless a pairing is under way.
        if (event.target === dialog.current && !adding) close();
      }}
      className="m-auto w-[460px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[14px] bg-surface p-0 text-ink shadow-overlay backdrop:bg-black/20 backdrop:backdrop-blur-overlay"
    >
      <div className="p-5">
        <h2 id="add-computer-title" className="text-[16px] font-semibold">
          Add computer
        </h2>
        <p className="mt-1 text-[13px] text-ink-2">See and drive another computer's chats from this window.</p>
        <ol className="mt-4 list-decimal space-y-1 pl-[18px] text-[13px] text-ink-2">
          <li>On the other computer, open Milagre Settings › Devices.</li>
          <li>Click Pair a device, then Copy link.</li>
          <li>Paste it here. The link works for 10 minutes.</li>
        </ol>
        <label className="mt-4 block text-[12px] text-ink-3" htmlFor="add-computer-link">
          Pairing link
        </label>
        <div className="mt-1.5 flex gap-2">
          <input
            id="add-computer-link"
            aria-label="Pairing link"
            value={link}
            disabled={adding}
            spellCheck={false}
            autoFocus
            placeholder="milagre://pair?…"
            onChange={(event) => setLink(event.target.value)}
            className={`${FIELD} font-mono`}
          />
          <button
            type="button"
            disabled={adding}
            onClick={() => void paste()}
            className="shrink-0 rounded-control px-3 text-[13px] ring-1 ring-line-strong hover:bg-hover-2"
          >
            Paste
          </button>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3 text-[13px]">
          <span>LAN or Tailscale only</span>
          <SettingCheckbox
            label="LAN or Tailscale only"
            checked={privateOnly}
            disabled={adding}
            onChange={(value) => {
              if (!adding) setPrivateOnly(value);
            }}
          />
        </div>
        <p className="mt-1 text-[12px] text-ink-3">Automatic tries private routes first. Private pairing needs both devices on the same network or tailnet.</p>
        {preview && (
          <div data-add-computer-found className="mt-3 flex items-center gap-3 rounded-[10px] bg-hover px-3 py-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-hover-2 text-ink-2">
              <HugeiconsIcon icon={LaptopIcon} size={17} strokeWidth={1.8} color="currentColor" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium">{preview.name}</span>
              <span className="block text-[12px] text-ink-3">Reached through {preview.relayHost} · end-to-end encrypted</span>
            </span>
          </div>
        )}
        {preview && (
          <>
            <label className="mt-3.5 block text-[12px] text-ink-3" htmlFor="add-computer-name">
              Show it as
            </label>
            <input
              id="add-computer-name"
              aria-label="Show it as"
              value={name}
              disabled={adding}
              onChange={(event) => {
                typedName.current = true;
                setName(event.target.value);
              }}
              className={`${FIELD} mt-1.5`}
            />
          </>
        )}
        {error && (
          <p role="alert" data-add-computer-error className="mt-3 text-[13px] text-red-ink">
            {error}
          </p>
        )}
        {waiting && preview ? (
          <div className="mt-[18px] flex items-center justify-between gap-3">
            <p role="status" data-add-computer-waiting className="text-[13px] text-ink-2">
              Waiting for {preview.name} to allow {thisComputer}…
            </p>
            <button type="button" onClick={() => void window.milagre.computers.cancelAdd()} className="rounded-control px-3 py-2 text-[13px] hover:bg-hover-2">
              Cancel
            </button>
          </div>
        ) : (
          <div className="mt-[18px] flex justify-end gap-2">
            <button type="button" onClick={close} className="rounded-control px-3 py-2 text-[13px] hover:bg-hover-2">
              Cancel
            </button>
            <button
              type="button"
              disabled={!preview || adding}
              onClick={() => void add()}
              className="rounded-control bg-ink px-3 py-2 text-[13px] font-medium text-surface disabled:opacity-40"
            >
              {adding ? "Connecting…" : "Add computer"}
            </button>
          </div>
        )}
        {preview && (
          <p className="mt-3.5 text-[12px] text-ink-3">
            This window gets full control of {preview.name}'s Projects, like its own window. Remove it any time from {preview.name}'s Settings › Devices.
          </p>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
