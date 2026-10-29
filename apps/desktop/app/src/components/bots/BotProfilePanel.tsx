import { useEffect, useRef, useState, type ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Brain02Icon, GitBranchIcon } from "@hugeicons/core-free-icons";
import { MEMORY_LINE_CAP, type BotSummary, type BotsSnapshot } from "@milagre/shared/bots";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeFor } from "../../lib/computer-bridge";
import { ScrollArea } from "../primitives/ScrollArea";
import { BotAvatar } from "./BotAvatar";
import { BOT_CHAT_STATUS, projectLabel } from "./BotChatCard";

const GATE_LABEL = { merge: "Merge", publish: "Publish", post: "Post", delete: "Delete", spend: "Spend" } as const;
const BUTTON = "rounded-[8px] px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-40";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-ink-3">{title}</h3>
      {children}
    </section>
  );
}

/** A bot's profile beside its thread: its brief, the Chats it opened, its memory, its standing sign-offs. */
export function BotProfilePanel({ bot, snapshot, onOpenChat }: { bot: BotSummary; snapshot: BotsSnapshot; onOpenChat?: (chatKey: string) => void }) {
  const bridge = bridgeFor(null);
  const [brief, setBrief] = useState<string | null>(null);
  const [briefDraft, setBriefDraft] = useState("");
  const [memory, setMemory] = useState<{ text: string; lines: number } | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(ipcErrorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const readMemory = () =>
    bridge.readBotMemory(bot.id).then(
      (value) => {
        setMemory({ text: value.text, lines: value.lines });
        return true;
      },
      (cause) => {
        setError(ipcErrorMessage(cause));
        return false;
      },
    );
  // App keys the panel by bot, so each bot's profile reads its own brief and memory once.
  useEffect(() => {
    let live = true;
    bridge.readBotBrief(bot.id).then(
      (value) => {
        if (!live) return;
        setBrief(value.text);
        setBriefDraft(value.text);
      },
      (cause) => live && setError(ipcErrorMessage(cause)),
    );
    void readMemory();
    return () => {
      live = false;
    };
  }, [bot.id]);

  const chats = snapshot.chats.filter((chat) => chat.botId === bot.id).sort((a, b) => b.createdAt - a.createdAt);
  const grants = snapshot.grants.filter((grant) => grant.botId === bot.id && grant.revokedAt === null);
  const briefChanged = brief !== null && briefDraft !== brief;

  return (
    <aside data-bot-profile={bot.id} aria-label={`${bot.name}'s profile`} className="flex min-h-0 w-full flex-col">
      <ScrollArea className="min-h-0 flex-1 px-4 pt-3 pb-4">
        <div className="flex items-center gap-3">
          <BotAvatar color={bot.color} body={bot.body} size={44} />
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-ink">{bot.name}</h2>
            <p className="truncate text-[12.5px] text-ink-3">{bot.role}</p>
          </div>
        </div>

        <Section title="Brief">
          <textarea
            aria-label="Brief"
            value={briefDraft}
            disabled={brief === null}
            onChange={(event) => setBriefDraft(event.target.value)}
            rows={6}
            className="w-full resize-y rounded-[8px] border border-transparent bg-transparent px-0 py-0.5 text-[13px] leading-[1.5] text-ink outline-none hover:border-line focus:border-accent focus:px-2"
          />
          {briefChanged && (
            <div className="mt-1 flex justify-end gap-1">
              <button type="button" onClick={() => setBriefDraft(brief ?? "")} className={`${BUTTON} text-ink-2 hover:bg-hover`}>
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => bridge.updateBot(bot.id, { brief: briefDraft })).then((saved) => saved && setBrief(briefDraft))}
                className={`${BUTTON} bg-ink text-surface hover:opacity-85`}
              >
                Save
              </button>
            </div>
          )}
        </Section>

        <Section title={`Chats ${bot.name} opened`}>
          {chats.length === 0 && <p className="text-[13px] text-ink-3">None yet.</p>}
          {chats.map((chat) => (
            <button
              key={chat.chatKey}
              type="button"
              data-profile-chat={chat.chatKey}
              onClick={() => onOpenChat?.(chat.chatKey)}
              title={projectLabel(chat.projectPath)}
              className="-mx-1.5 flex h-8 w-[calc(100%+12px)] items-center gap-2 rounded-[8px] px-1.5 text-left hover:bg-hover"
            >
              <HugeiconsIcon icon={GitBranchIcon} size={14} strokeWidth={1.8} color="currentColor" className="shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{chat.title}</span>
              <span className="shrink-0 text-[12px] text-ink-3">{BOT_CHAT_STATUS[chat.status]}</span>
            </button>
          ))}
        </Section>

        <Section title="Memory">
          <div className="flex h-8 items-center gap-2">
            <HugeiconsIcon icon={Brain02Icon} size={14} strokeWidth={1.8} color="currentColor" className="shrink-0 text-ink-3" />
            <span data-memory-lines className="min-w-0 flex-1 truncate text-[13px] text-ink">
              MEMORY.md{memory ? ` · ${memory.lines} of ${MEMORY_LINE_CAP} lines` : ""}
            </span>
            <button
              type="button"
              disabled={!memory}
              // Read again first: the bot may have written since the panel opened, and the sheet saves the whole file.
              onClick={() => void readMemory().then((fresh) => fresh && setMemoryOpen(true))}
              className={`${BUTTON} font-semibold text-ink hover:bg-hover`}
            >
              Open
            </button>
          </div>
        </Section>

        {grants.length > 0 && (
          <Section title={`Always for ${bot.name}`}>
            {grants.map((grant) => (
              <div key={grant.id} data-grant={grant.id} className="flex h-8 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={grant.target}>
                  {GATE_LABEL[grant.gate]} · {projectLabel(grant.target)}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => bridge.revokeBotGrant(grant.id))}
                  className={`${BUTTON} text-red-ink hover:bg-red-tint`}
                >
                  Revoke
                </button>
              </div>
            ))}
          </Section>
        )}

        <div className="mt-6 border-t border-line pt-3">
          {confirmDelete ? (
            <div data-delete-confirm role="alertdialog" aria-label={`Delete ${bot.name}`}>
              <p className="text-[13px] text-ink">Delete {bot.name}? Its Chats stay in Milagre as yours.</p>
              <div className="mt-2 flex justify-end gap-1">
                <button type="button" onClick={() => setConfirmDelete(false)} className={`${BUTTON} text-ink-2 hover:bg-hover`}>
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => bridge.removeBot(bot.id))}
                  className={`${BUTTON} bg-ink text-surface hover:opacity-85`}
                >
                  Delete
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className={`${BUTTON} -ml-2.5 text-ink-2 hover:bg-hover hover:text-ink`}>
              Delete bot
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="mt-3 text-[12px] text-red-ink">
            {error}
          </p>
        )}
      </ScrollArea>
      {memoryOpen && memory && (
        <MemorySheet
          botName={bot.name}
          text={memory.text}
          onClose={() => setMemoryOpen(false)}
          onSave={async (text) => {
            // The text the sheet opened is the base: the runtime refuses the save when the bot wrote since.
            try {
              await bridge.saveBotMemory(bot.id, text, memory.text);
            } catch (cause) {
              return ipcErrorMessage(cause);
            }
            setMemoryOpen(false);
            await readMemory();
            return null;
          }}
        />
      )}
    </aside>
  );
}

/** MEMORY.md, editable. Lines the user writes are marked as theirs, so the bot keeps them. */
function MemorySheet({
  botName,
  text,
  onClose,
  onSave,
}: {
  botName: string;
  text: string;
  onClose: () => void;
  /** Resolves to the error to show in the sheet, or null once saved. */
  onSave: (text: string) => Promise<string | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      data-memory-sheet
      aria-label={`${botName}'s memory`}
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
      onClick={(event) => {
        if (event.target === dialog.current && !saving) onClose();
      }}
      className="m-auto w-[600px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[16px] bg-surface p-0 text-ink shadow-overlay backdrop:bg-black/20 backdrop:backdrop-blur-overlay"
    >
      <form
        className="flex max-h-[calc(100vh-64px)] flex-col p-5"
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          setError(null);
          void onSave(draft)
            .then(setError)
            .finally(() => setSaving(false));
        }}
      >
        <h2 className="text-[16px] font-semibold">MEMORY.md</h2>
        <textarea
          aria-label="Memory"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={18}
          className="mt-3 min-h-0 w-full flex-1 resize-none rounded-control border border-line bg-field px-3 py-2 font-mono text-[12px] leading-[1.5] outline-none focus:border-accent"
        />
        {error && (
          <p role="alert" data-memory-error className="mt-3 text-[12px] text-red-ink">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" disabled={saving} onClick={onClose} className="rounded-control px-3 py-2 text-[13px] hover:bg-hover-2">
            Cancel
          </button>
          <button type="submit" disabled={saving} className="rounded-control bg-ink px-3 py-2 text-[13px] font-medium text-surface disabled:opacity-40">
            Save
          </button>
        </div>
      </form>
    </dialog>
  );
}
