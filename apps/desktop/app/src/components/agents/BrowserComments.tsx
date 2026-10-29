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
import type { BrowserTab } from "../../lib/browser-panel";
import { browserOverlay, cancelPagePick, capturePageElement, pickOnPage, setPagePins } from "../../lib/browser-webviews";
import {
  addPendingComment,
  pageComments,
  pagePins,
  removePendingComments,
  setCommenting,
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
            !onSend ? "Open this Chat to send" : failed ? "Didn't send. Try again" : `Send ${count === 1 ? "your comment" : `${count} comments`} to the agent`
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
            <span className="rounded-full bg-surface/20 px-1.5 text-11 tabular-nums">{count}</span>
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
  const [kept, setDraft] = useState<{ tabId: string; url: string; element: PageElement; shot: string | null } | null>(null);
  // A comment being written belongs to the page it was picked on: another tab or address drops it.
  const draft = kept && kept.tabId === tab.id && kept.url === tab.url ? kept : null;
  // Pins follow the Chat's comments and the page's address.
  useEffect(() => {
    if (live) setPagePins(tab.id, pagePins(comments, tab.url));
  }, [comments, tab.id, tab.url, live]);
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
      if (!cancelled) setDraft({ tabId: tab.id, url: tab.url, element, shot });
    });
    return () => {
      cancelled = true;
      cancelPagePick(tab.id);
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- tab.url is read when a pick lands, not a reason to pick again
  }, [picking, tab.id, chatKey]);
  // Leaving comment mode, or the page, drops a comment that wasn't added.
  useEffect(() => {
    if (!comments.commenting || !live || (kept && !draft)) setDraft(null);
  }, [comments.commenting, live, kept, draft]);
  const overlay = live ? browserOverlay(tab.id) : null;
  if (!overlay) return null;
  // Comment mode says what to do, at the top of the page, until an element is picked.
  if (!draft)
    return picking
      ? createPortal(
          <div
            data-slot="browser-comment-hint"
            className="absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-ink/90 px-3 py-1.5 text-12 whitespace-nowrap text-surface shadow-md"
          >
            Click an element to comment on it · Esc to stop
          </div>,
          overlay,
        )
      : null;
  return createPortal(
    <CommentBox
      key={draft.element.selector + draft.element.box.y}
      element={draft.element}
      onCancel={() => setDraft(null)}
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
        setDraft(null);
      }}
    />,
    overlay,
  );
}

const BOX_WIDTH = 300;

/** The box a comment is written in, beside the element it is on: below it when there is room, above otherwise. */
function CommentBox({ element, onAdd, onCancel }: { element: PageElement; onAdd: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
  const { box, viewport } = element;
  const below = box.y + box.height + 8 + 120 <= viewport.height;
  const left = Math.max(8, Math.min(box.x + Math.min(box.width, 24), viewport.width - BOX_WIDTH - 8));
  const top = below ? box.y + box.height + 8 : Math.max(8, box.y - 8 - 120);
  const add = () => {
    if (text.trim()) onAdd(text.trim());
  };
  const where = [element.components?.at(-1) ? `<${element.components.at(-1)}>` : element.tag, element.source].filter(Boolean).join(" · ");
  return (
    <div
      data-slot="browser-comment-box"
      role="dialog"
      aria-label="Comment on this element"
      style={{ left, top, width: BOX_WIDTH, borderRadius: below ? "3px 10px 10px 10px" : "10px 10px 10px 3px" }}
      className="pointer-events-auto absolute flex flex-col gap-2 border border-line-strong bg-surface p-3 text-ink shadow-raised"
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
  const remote = isRemoteKey(useScope());
  const src = image?.dataUrl ?? (image?.path && !remote ? mediaUrl(image.path) : undefined);
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
          {saved?.resolved ? `Resolved · ${saved.resolved.note}` : `${comment.label} · waiting on the agent`}
        </div>
      </div>
    </div>
  );
}
