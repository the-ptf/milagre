import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { CommentAdd01Icon, Comment01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { ImageAttachment } from "../../model";
import type { PageElement, ParsedPageComment } from "@milagre/shared/page-comments";
import { pageCommentsMessage } from "@milagre/shared/page-comments";
import { isTurnEnd } from "@milagre/shared/agent-runs";
import Tooltip from "../primitives/Tooltip";
import { isRemoteKey, onAnyAgentEvent, useBridge, useScope } from "../../lib/computer-bridge";
import { mediaUrl } from "../../lib/media";
import { useRemoteMedia } from "../../lib/remote-media";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { StreamedPoint } from "./BrowserViewer";
import type { BrowserTab } from "../../lib/browser-panel";
import { browserOverlay, cancelPagePick, capturePageElement, pickOnPage, setPagePins } from "../../lib/browser-webviews";
import {
  addPendingComment,
  pageComments,
  pagePins,
  removePendingComments,
  setCommenting,
  setPageDraft,
  setSentComments,
  usePageComments,
  useSentComment,
  type PendingPageComment,
} from "../../lib/page-comments";

const SEND_KEYS = /Mac/.test(navigator.userAgent) ? "⌘↵" : "Ctrl+↵";

/** The most comments one message carries (what the host takes at once); more wait for the next Send. */
const SEND_AT_ONCE = 50;

/** Sends the Chat's page comments as one message with their screenshots; true once it went. */
export type SendPageComments = (text: string, images: ImageAttachment[]) => Promise<boolean>;

/** The toolbar's comment toggle and, while comments wait, their Send button (design browser-comment-a). */
export function CommentControls({ chatKey, live, onSend }: { chatKey: string; live: boolean; onSend?: SendPageComments }) {
  const { commenting, pending } = usePageComments(chatKey);
  const bridge = useBridge();
  const api = typeof bridge?.pageComments?.add === "function" ? bridge.pageComments : undefined;
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const send = async () => {
    if (!onSend || !api || sending) return;
    const batch = pageComments(chatKey).pending.slice(0, SEND_AT_ONCE);
    if (!batch.length) return;
    setSending(true);
    setFailed(false);
    try {
      const images = batch.flatMap((comment) =>
        comment.shot ? [{ id: `page-comment-${comment.id}`, name: `page-comment-${comment.id}.png`, dataUrl: comment.shot }] : [],
      );
      const text = pageCommentsMessage(batch, { screenshots: images.length > 0 });
      if (!(await onSend(text, images))) throw Error("not sent");
      // Recorded once the message went, under the ids it names, so the agent can resolve them.
      setSentComments(chatKey, [...pageComments(chatKey).sent, ...(await api.add({ chatId: chatKey, comments: batch }))]);
      removePendingComments(chatKey, new Set(batch.map((comment) => comment.id)));
      setCommenting(chatKey, false);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };
  const label = commenting ? "Stop commenting" : "Comment on the page";
  const count = Math.min(pending.length, SEND_AT_ONCE);
  return (
    <>
      {pending.length > 0 && (
        <Tooltip
          label={
            !onSend
              ? "Open this Chat to send"
              : failed
                ? "Didn't send. Try again"
                : pending.length > count
                  ? `Send the first ${count} of ${pending.length} comments to the agent. Send again for the rest.`
                  : `Send ${count === 1 ? "your comment" : `${count} comments`} to the agent`
          }
          side="bottom"
          align="end"
        >
          <button
            type="button"
            data-slot="browser-send-comments"
            disabled={!onSend || sending}
            onClick={() => void send()}
            className={`flex h-7 shrink-0 items-center gap-1.5 rounded-control pr-1.5 pl-2.5 text-12 font-medium disabled:opacity-50 ${failed ? "bg-red text-white" : "bg-ink text-surface"}`}
          >
            {failed ? "Retry" : "Send"}
            <span className="rounded-full bg-surface/20 px-1.5 text-11 tabular-nums">{pending.length > count ? `${count} of ${pending.length}` : count}</span>
          </button>
        </Tooltip>
      )}
      <Tooltip label={label} side="bottom" align="end">
        <button
          type="button"
          aria-label={label}
          aria-pressed={commenting}
          data-slot="browser-comment-toggle"
          disabled={!live}
          onClick={() => setCommenting(chatKey, !commenting)}
          className={`flex size-7 shrink-0 items-center justify-center rounded-control disabled:opacity-35 ${commenting ? "bg-accent/10 text-accent" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
        >
          <HugeiconsIcon icon={CommentAdd01Icon} size={16} aria-hidden />
        </button>
      </Tooltip>
    </>
  );
}

/**
 * Keeps the host's list of the Chat's sent page comments fresh while its agent works, for the pins and the transcript
 * cards: on mount, after each of the agent's steps (a resolution shows within a second) and at turn end.
 */
export function useSentPageComments(chatKey: string) {
  // Read once: a bridge that hands out a new object per read would restart the effect every render.
  const bridge = useBridge();
  // A host from before page comments (or a window without them) has no list: the pins then show only what is pending.
  const [api] = useState(() => (typeof bridge?.pageComments?.list === "function" ? bridge.pageComments : undefined));
  useEffect(() => {
    if (!api) return;
    let soon: ReturnType<typeof setTimeout> | undefined;
    const read = () =>
      void api.list({ chatId: chatKey }).then(
        (sent) => setSentComments(chatKey, sent),
        () => {},
      );
    read();
    const off = onAnyAgentEvent(({ chatId, event }) => {
      if (chatId !== chatKey) return;
      if (isTurnEnd(event)) read();
      else if (event.type === "step-completed") {
        clearTimeout(soon);
        soon = setTimeout(read, 400);
      }
    });
    return () => {
      clearTimeout(soon);
      off();
    };
  }, [api, chatKey]);
}

/** The comments on the page on screen: its pins, and in comment mode the picker and the box a comment is written in. */
export function PageCommenting({ chatKey, tab, live }: { chatKey: string; tab: BrowserTab; live: boolean }) {
  const comments = usePageComments(chatKey);
  // A comment being written belongs to the page it was picked on: it shows again when that tab and address do.
  const kept = comments.drafts[tab.id];
  const draft = kept && kept.url === tab.url ? kept : null;
  // Pins follow the Chat's comments and the page's address.
  useEffect(() => {
    if (live)
      setPagePins(tab.id, [
        ...pagePins(comments, tab.url),
        ...(draft
          ? [{ n: comments.pending.length + 1, selector: draft.element.selector, point: draft.element.point, text: draft.text, state: "pending" as const }]
          : []),
      ]);
  }, [comments, draft, tab.id, tab.url, live]);
  // Comment mode: pick an element, write its comment, pick the next, until Escape or the toggle ends it.
  const picking = comments.commenting && live && !draft;
  useEffect(() => {
    if (!picking) return;
    let cancelled = false;
    void pickOnPage(tab.id).then(async (element) => {
      if (cancelled || element === undefined) return;
      if (!element) {
        setCommenting(chatKey, false);
        return;
      }
      const shot = await capturePageElement(tab.id, element.box);
      if (!cancelled) setPageDraft(chatKey, tab.id, { url: tab.url, element, shot, text: "" });
    });
    return () => {
      cancelled = true;
      cancelPagePick(tab.id);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- tab.url is read when a pick lands, not a reason to pick again
  }, [picking, tab.id, chatKey]);
  // The tab went to another address: what was picked on the old one is gone.
  useEffect(() => {
    if (kept && !draft) setPageDraft(chatKey, tab.id, null);
  }, [kept, draft, chatKey, tab.id]);
  const overlay = live ? browserOverlay(tab.id) : null;
  if (!overlay) return null;
  // Comment mode says what to do, at the bottom of the page, until an element is picked.
  if (!draft)
    return picking
      ? createPortal(
          <div
            data-slot="browser-comment-hint"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-ink/90 px-3 py-1.5 text-12 whitespace-nowrap text-surface shadow-md"
          >
            Click anywhere to place a comment pin · Esc to stop
          </div>,
          overlay,
        )
      : null;
  return createPortal(
    <CommentBox
      key={draft.element.selector + draft.element.box.y}
      element={draft.element}
      text={draft.text}
      onText={(text) => setPageDraft(chatKey, tab.id, { ...draft, text })}
      onCancel={() => setPageDraft(chatKey, tab.id, null)}
      onAdd={(text) => {
        const comment: PendingPageComment = {
          id: crypto.randomUUID().replace(/-/g, "").slice(0, 8),
          url: draft.url,
          title: tab.title,
          element: draft.element,
          text,
          shot: draft.shot,
        };
        addPendingComment(chatKey, comment);
        setPageDraft(chatKey, tab.id, null);
      }}
    />,
    overlay,
  );
}

const BOX_WIDTH = 300;

/**
 * Comment mode on a streamed Browser panel page (another computer's): the hint until a point is picked, then the box its
 * comment is written in. Send has that computer read the element at the point, screenshot it and send the comment to the
 * Chat's agent, as the phone does; the page's own comments and pins stay on that computer.
 */
export function StreamedPageComment({
  chatId,
  targetId,
  picked,
  onCancel,
  onSent,
}: {
  chatId: string;
  targetId: string;
  picked: StreamedPoint | null;
  onCancel: () => void;
  onSent: () => void;
}) {
  const bridge = useBridge();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (picked) field.current?.focus();
  }, [picked]);
  if (!picked)
    return (
      <div
        data-slot="browser-comment-hint"
        className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-ink/90 px-3 py-1.5 text-12 whitespace-nowrap text-surface shadow-md"
      >
        Click anywhere to place a comment pin · Esc to stop
      </div>
    );
  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    const api = bridge?.pageComments;
    if (typeof api?.sendFromPage !== "function") {
      setError("This computer's Milagre is too old to take comments from here. Update it, then try again.");
      return;
    }
    setSending(true);
    setError("");
    try {
      await api.sendFromPage({ chatId, targetId, x: picked.x, y: picked.y, text: body });
      onSent();
    } catch (failure) {
      setError(ipcErrorMessage(failure) || "The comment didn't send.");
    } finally {
      setSending(false);
    }
  };
  const below = picked.top + 8 + 140 <= picked.viewport.height;
  const left = Math.max(8, Math.min(picked.left + 24, picked.viewport.width - BOX_WIDTH - 8));
  const top = below ? picked.top + 8 : Math.max(8, picked.top - 8 - 140);
  return (
    <div
      data-slot="browser-comment-box"
      role="dialog"
      aria-label="Comment at this pin"
      style={{ left, top, width: Math.min(BOX_WIDTH, picked.viewport.width - 16), borderRadius: below ? "3px 10px 10px 10px" : "10px 10px 10px 3px" }}
      className="absolute flex flex-col gap-2 border border-line-strong bg-surface p-3 text-ink shadow-raised"
    >
      <textarea
        ref={field}
        value={text}
        rows={2}
        placeholder="What should change here?"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
        className="min-h-[38px] w-full resize-none bg-transparent text-13 leading-[1.45] outline-none placeholder:text-ink-3"
      />
      {error && (
        <p role="alert" className="text-12 text-red-ink">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <button type="button" disabled={sending} onClick={onCancel} className="rounded-control px-2 py-1 text-12 text-ink-2 hover:bg-hover">
          Cancel
        </button>
        <button
          type="button"
          data-slot="browser-comment-send"
          disabled={!text.trim() || sending}
          onClick={() => void send()}
          className="flex items-center gap-1.5 rounded-control bg-accent px-2.5 py-1 text-12 font-medium text-white disabled:opacity-50"
        >
          {sending ? "Sending" : "Send"} <span className="text-11 text-white/75">{SEND_KEYS}</span>
        </button>
      </div>
    </div>
  );
}

/** The box a comment is written in, beside the element it is on: below it when there is room, above otherwise. */
function CommentBox({
  element,
  text,
  onText,
  onAdd,
  onCancel,
}: {
  element: PageElement;
  text: string;
  onText: (text: string) => void;
  onAdd: (text: string) => void;
  onCancel: () => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
  const { box, viewport } = element;
  const x = box.x + (element.point?.x ?? 0.5) * box.width;
  const y = box.y + (element.point?.y ?? 0.5) * box.height;
  const below = y + 8 + 120 <= viewport.height;
  const left = Math.max(8, Math.min(x + 24, viewport.width - BOX_WIDTH - 8));
  const top = below ? y + 8 : Math.max(8, y - 8 - 120);
  const add = () => {
    if (text.trim()) onAdd(text.trim());
  };
  const where = [element.label || element.tag, element.source].filter(Boolean).join(" · ");
  return (
    <div
      data-slot="browser-comment-box"
      role="dialog"
      aria-label="Comment at this pin"
      style={{ left, top, width: BOX_WIDTH, borderRadius: below ? "3px 10px 10px 10px" : "10px 10px 10px 3px" }}
      className="pointer-events-auto absolute flex flex-col gap-2 border border-line-strong bg-surface p-3 text-ink shadow-raised"
    >
      <textarea
        ref={field}
        value={text}
        rows={2}
        placeholder="What should change here?"
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            add();
          }
        }}
        className="min-h-[38px] w-full resize-none bg-transparent text-13 leading-[1.45] outline-none placeholder:text-ink-3"
      />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-11 text-ink-3" title={element.selector}>
          On {where}
        </span>
        <button type="button" onClick={onCancel} className="rounded-control px-2 py-1 text-12 text-ink-2 hover:bg-hover">
          Cancel
        </button>
        <button
          type="button"
          data-slot="browser-comment-add"
          disabled={!text.trim()}
          onClick={add}
          className="flex items-center gap-1.5 rounded-control bg-accent px-2.5 py-1 text-12 font-medium text-white disabled:opacity-50"
        >
          Add <span className="text-11 text-white/75">{SEND_KEYS}</span>
        </button>
      </div>
    </div>
  );
}

/** The images a page-comments message carries for its comments, by comment id. */
export const isPageCommentImage = (image: ImageAttachment) => /^page-comment-[a-f0-9]{8}\.png$/.test(image.name);

/**
 * Page comments the user sent, shown as what they were instead of the text the agent reads (design
 * browser-comment-sent): each comment with its element's screenshot and whether the agent resolved it.
 */
export function PageCommentsCard({ comments, images }: { comments: ParsedPageComment[]; images?: ImageAttachment[] }) {
  const pages = [...new Set(comments.map((comment) => comment.title || comment.url))];
  const first = comments[0]!;
  return (
    <div data-slot="page-comments" className="w-full max-w-md overflow-hidden rounded-card border border-line bg-surface text-13">
      <div className="flex items-start gap-2 border-b border-line px-3 py-2">
        <HugeiconsIcon icon={Comment01Icon} size={15} className="mt-0.5 shrink-0 text-ink-2" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">
            {comments.length === 1 ? "A comment" : `${comments.length} comments`} on {pages.length === 1 ? pages[0] : `${pages.length} pages`}
          </div>
          {pages.length === 1 && <div className="truncate text-12 text-ink-3">{first.url.replace(/^https?:\/\//, "")}</div>}
        </div>
      </div>
      {comments.map((comment) => (
        <PageCommentRow key={comment.id} comment={comment} image={images?.find((item) => item.name === `page-comment-${comment.id}.png`)} />
      ))}
    </div>
  );
}

function PageCommentRow({ comment, image }: { comment: ParsedPageComment; image?: ImageAttachment }) {
  const saved = useSentComment(comment.id);
  const scope = useScope();
  const remote = isRemoteKey(scope);
  // Another computer's screenshot is read from it, as reply images are.
  const { sources } = useRemoteMedia(remote && !image?.dataUrl && image?.path ? scope : null, image?.path ? [image.path] : []);
  const src = image?.dataUrl ?? (image?.path ? (remote ? sources[image.path] : mediaUrl(image.path)) : undefined);
  return (
    <div data-slot="page-comment" data-resolved={saved?.resolved ? "" : undefined} className="flex gap-3 border-b border-line px-3 py-2.5 last:border-b-0">
      <div className="relative h-10 w-14 shrink-0">
        <div className="h-full w-full overflow-hidden rounded-chip border border-line-strong bg-white">
          {src ? <img src={src} alt="" className="h-full w-full object-contain" /> : null}
        </div>
        <span
          className={`absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full text-10 font-semibold text-white ring-[1.5px] ring-surface ${saved?.resolved ? "bg-green" : "bg-accent"}`}
        >
          {saved?.resolved ? <HugeiconsIcon icon={Tick02Icon} size={10} strokeWidth={3} aria-hidden /> : comment.number}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-6 whitespace-pre-wrap break-words" title={comment.text.length > 300 ? comment.text : undefined}>
          {comment.text}
        </div>
        <div className={`mt-0.5 truncate text-12 ${saved?.resolved ? "text-green" : "text-ink-3"}`} title={saved?.resolved?.note}>
          {saved?.resolved ? `Resolved · ${saved.resolved.note}` : `${comment.label} · not resolved yet`}
        </div>
      </div>
    </div>
  );
}
