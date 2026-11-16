import { CommentOptions } from "./CommentOptions";
import { useEffect, useEffectEvent, useState } from "react";
import { createPortal } from "react-dom";
import { CommentAdd01Icon, Comment01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { ImageAttachment } from "../../model";
import type { ParsedPageComment } from "@milagre/shared/page-comments";
import { pageCommentsMessage } from "@milagre/shared/page-comments";
import { isTurnEnd } from "@milagre/shared/agent-runs";
import Tooltip from "../primitives/Tooltip";
import { Button, IconButton } from "../primitives/Button";
import { Icon } from "../primitives/Icon";
import { CommentPin } from "./CommentPin";
import type { PagePinPosition } from "@milagre/shared/page-picker";
import { TOAST } from "../../lib/toast";
import { isRemoteKey, onAnyAgentEvent, useBridge, useScope } from "../../lib/computer-bridge";
import { mediaUrl } from "../../lib/media";
import { useRemoteMedia } from "../../lib/remote-media";
import type { BrowserTab } from "../../lib/browser-panel";
import { browserOverlay, cancelPagePick, capturePageElement, pickOnPage, setPagePins, pagePinPositions } from "../../lib/browser-webviews";
import {
  addPendingComment,
  pageComments,
  pagePins,
  removePendingComments,
  completePendingComments,
  setCommenting,
  setShowResolved,
  openPageComment,
  editPageComment,
  setSentComments,
  usePageComments,
  useSentComment,
} from "../../lib/page-comments";

const SEND_PAGE_COMMENTS = "milagre:send-page-comments";

const SEND_AT_ONCE = 50;

export type SendPageComments = (text: string, images: ImageAttachment[]) => Promise<boolean>;

export function CommentControls({ chatKey, live, onSend }: { chatKey: string; live: boolean; onSend?: SendPageComments }) {
  const { commenting, pending: allPending, showResolved } = usePageComments(chatKey);
  const pending = allPending.filter((pin) => pin.text.trim());
  const bridge = useBridge();
  const api = typeof bridge?.pageComments?.add === "function" ? bridge.pageComments : undefined;
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const send = async () => {
    if (!onSend || !api || sending) return;
    const batch = pageComments(chatKey)
      .pending.filter((pin) => pin.text.trim())
      .slice(0, SEND_AT_ONCE);
    if (!batch.length) return;
    setSending(true);
    setFailed(false);
    setCommenting(chatKey, false);
    try {
      const images = batch.flatMap((comment) =>
        comment.shot ? [{ id: `page-comment-${comment.id}`, name: `page-comment-${comment.id}.png`, dataUrl: comment.shot }] : [],
      );
      const text = pageCommentsMessage(batch, { screenshots: images.length > 0 });
      if (!(await onSend(text, images))) throw Error("not sent");
      setSentComments(chatKey, [...pageComments(chatKey).sent, ...(await api.add({ chatId: chatKey, comments: batch }))]);
      completePendingComments(chatKey, batch);
      setCommenting(chatKey, false);
    } catch {
      setFailed(true);
    } finally {
      setSending(false);
    }
  };
  const sendCurrent = useEffectEvent(() => void send());
  useEffect(() => {
    const listener = (event: Event) => {
      if ((event as CustomEvent<string>).detail === chatKey) sendCurrent();
    };
    window.addEventListener(SEND_PAGE_COMMENTS, listener);
    return () => window.removeEventListener(SEND_PAGE_COMMENTS, listener);
  }, [chatKey]);
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
          <Button
            variant={failed ? "danger" : "primary"}
            size={24}
            data-slot="browser-send-comments"
            disabled={!onSend || sending}
            onClick={() => void send()}
            className="pr-1.5"
          >
            {failed ? "Retry send" : "Send"}
            <span className={`rounded-full px-1.5 text-11 tabular-nums ${failed ? "bg-on-red/20" : "bg-on-ink/20"}`}>
              {pending.length > count ? `${count} of ${pending.length}` : count}
            </span>
          </Button>
        </Tooltip>
      )}
      <CommentOptions shown={!!showResolved} onChange={(value) => setShowResolved(chatKey, value)}>
        <Tooltip label={`${label}. Right-click or hold for comment options`} side="bottom" align="end">
          <IconButton
            label={label}
            icon={CommentAdd01Icon}
            tone="accent"
            aria-pressed={commenting}
            data-slot="browser-comment-toggle"
            disabled={!live}
            onClick={() => setCommenting(chatKey, !commenting)}
          />
        </Tooltip>
      </CommentOptions>
    </>
  );
}

export function useSentPageComments(chatKey: string) {
  const bridge = useBridge();
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

export function PageCommenting({ chatKey, tab, live }: { chatKey: string; tab: BrowserTab; live: boolean }) {
  const comments = usePageComments(chatKey);
  const pins = pagePins(comments, tab.url);
  const [positions, setPositions] = useState<PagePinPosition[]>([]);
  const pinsKey = JSON.stringify(pins);
  useEffect(() => {
    if (!live) return;
    setPagePins(tab.id, []);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const next = await pagePinPositions(tab.id, JSON.parse(pinsKey));
      if (disposed) return;
      setPositions((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
      timer = setTimeout(() => void read(), 100);
    };
    if (JSON.parse(pinsKey).length) void read();
    else setPositions([]);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [live, tab.id, pinsKey]);
  const openHere = pins.some((pin) => pin.id === comments.open);
  const picking = comments.commenting && live && !openHere;
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
      if (cancelled) return;
      const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
      addPendingComment(chatKey, { id, url: tab.url, title: tab.title, element, shot, text: "" });
      openPageComment(chatKey, id);
    });
    return () => {
      cancelled = true;
      cancelPagePick(tab.id);
    };
  }, [picking, tab.id, tab.url, tab.title, chatKey]);
  const overlay = live ? browserOverlay(tab.id) : null;
  if (!overlay) return null;
  const controls = {
    onOpen: (id: string | null) => openPageComment(chatKey, id),
    onText: (id: string, text: string) => editPageComment(chatKey, id, text),
    onRemove: (id: string) => {
      removePendingComments(chatKey, new Set([id]));
      openPageComment(chatKey, null);
    },
    onSend: () => window.dispatchEvent(new CustomEvent(SEND_PAGE_COMMENTS, { detail: chatKey })),
  };
  return createPortal(
    <>
      {picking && (
        <div data-slot="browser-comment-hint" className={`absolute bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap ${TOAST}`}>
          Click anywhere to place a comment pin · Esc to stop
        </div>
      )}
      {positions.map((position) => {
        const pin = pins.find((pin) => pin.id === position.id);
        if (!pin) return null;
        const open = comments.open === pin.id;
        return (
          <CommentPin
            key={pin.id}
            number={pin.n}
            open={open}
            scale={1}
            sent={pin.state !== "pending"}
            offsetX={Math.max(8, Math.min(position.x, position.width - 264)) - position.x}
            pin={{
              key: position.id,
              x: position.x / position.width,
              y: (open ? Math.min(position.y, Math.max(8, position.height - 230)) : position.y) / position.height,
              text: pin.text,
              design: { title: tab.title || "page" },
              ...(pin.note !== undefined ? { resolved: pin.note } : {}),
            }}
            comments={controls}
          />
        );
      })}
    </>,
    overlay,
  );
}

export const isPageCommentImage = (image: ImageAttachment) => /^page-comment-[a-f0-9]{8}\.png$/.test(image.name);

export function PageCommentsCard({ comments, images }: { comments: ParsedPageComment[]; images?: ImageAttachment[] }) {
  const pages = [...new Set(comments.map((comment) => comment.title || comment.url))];
  const first = comments[0]!;
  return (
    <div data-slot="page-comments" className="w-full max-w-md overflow-hidden rounded-card border border-line bg-surface text-13">
      <div className="flex items-start gap-2 border-b border-line px-3 py-2">
        <Icon icon={Comment01Icon} size={16} className="mt-px shrink-0 text-ink-2" />
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
  const { sources } = useRemoteMedia(remote && !image?.dataUrl && image?.path ? scope : null, image?.path ? [image.path] : []);
  const src = image?.dataUrl ?? (image?.path ? (remote ? sources[image.path] : mediaUrl(image.path)) : undefined);
  return (
    <div data-slot="page-comment" data-resolved={saved?.resolved ? "" : undefined} className="flex gap-3 border-b border-line px-3 py-3 last:border-b-0">
      <div className="relative h-10 w-14 shrink-0">
        <div className="h-full w-full overflow-hidden rounded-chip border border-line-strong bg-paper">
          {src ? <img src={src} alt="" className="h-full w-full object-contain" /> : null}
        </div>
        <span
          className={`absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full text-10 font-semibold shadow-pin ${saved?.resolved ? "bg-green-ink text-on-green" : "bg-accent-ink text-on-accent"}`}
        >
          {saved?.resolved ? <Icon icon={Tick02Icon} size={12} /> : comment.number}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-6 whitespace-pre-wrap break-words" title={comment.text.length > 300 ? comment.text : undefined}>
          {comment.text}
        </div>
        <div className={`mt-0.5 truncate text-12 ${saved?.resolved ? "text-green-ink" : "text-ink-3"}`} title={saved?.resolved?.note}>
          {saved?.resolved ? `Resolved · ${saved.resolved.note}` : `${comment.label} · not resolved yet`}
        </div>
      </div>
    </div>
  );
}
