import { useCallback, useEffect, useMemo, useState } from "react";
import { designFeedbackMessage, newCommentId, sentNumbers, type ArtifactComment, type DesignComment, type HtmlArtifact } from "@milagre/shared/artifact";
import type { ArtifactRef } from "../../model";
import { bridgeForKey } from "../../lib/computer-bridge";
import type { DesignPin, PinControls } from "./ArtifactCanvas";

/** The two bodies of the Artifact panel: the canvas of every design, and the Chat's HTML page. */
export type DockPage = "canvas" | "page";

const unsent = new Map<string, { pins: DesignPin[]; choice: ArtifactRef | null }>();

export function htmlSentPins(comments: ArtifactComment[], page: { id: string; version: number; title: string } | null): DesignPin[] {
  if (!page) return [];
  return comments.flatMap((comment) =>
    comment.design.id === page.id && comment.design.version === page.version && comment.x !== undefined && comment.y !== undefined
      ? [
          {
            key: `sent:${comment.id}`,
            commentId: comment.id,
            design: { id: comment.design.id, title: comment.design.title, version: comment.design.version, format: "html" as const },
            x: comment.x,
            y: comment.y,
            text: comment.text,
            ...(comment.anchor ? { anchor: comment.anchor } : {}),
            ...(comment.near ? { near: comment.near } : {}),
            ...(comment.tab ? { tab: comment.tab } : {}),
            ...(comment.resolved ? { resolved: comment.resolved.note } : {}),
          },
        ]
      : [],
  );
}

type FeedbackOptions = {
  page: DockPage;
  chatId: string;
  designs: ArtifactRef[];
  html: HtmlArtifact | null;
  versions: Record<string, number | null>;
  onVersion: (id: string, version: number | null) => void;
  sent: DesignPin[];
  hostComments: ArtifactComment[];
  openComment?: string;
  openNonce: number;
  onSend?: (text: string) => Promise<boolean>;
  onCommentsAdded: () => void;
  onSent: () => void;
};

export type DockFeedback = ReturnType<typeof useDockFeedback>;

/**
 * What waits for Send on one body of the Artifact panel: its pins, the chosen design (the canvas only), comment mode
 * and the open pin. Each body keeps its own, and what waits outlives the panel closing, by Chat and body.
 */
export function useDockFeedback({
  page,
  chatId,
  designs,
  html,
  versions,
  onVersion,
  sent,
  hostComments,
  openComment,
  openNonce,
  onSend,
  onCommentsAdded,
  onSent,
}: FeedbackOptions) {
  const unsentKey = page === "canvas" ? chatId : `${chatId}#artifacts`;
  const [kept] = useState(() => unsent.get(unsentKey));
  const [pins, setPins] = useState<DesignPin[]>(() => kept?.pins.filter((pin) => pin.text.trim()) ?? []);
  const [choice, setChoice] = useState<ArtifactRef | null>(kept?.choice ?? null);
  const [commenting, setCommenting] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const pinFor = useCallback(
    (key: string | null | undefined) => {
      if (!key || page !== "page") return key ?? null;
      const commentId = sent.find((pin) => pin.key === key)?.commentId;
      return commentId ? `sent:${commentId}` : key;
    },
    [page, sent],
  );
  const [openPin, setOpenPin] = useState<string | null>(() => pinFor(openComment));
  const [reveal, setReveal] = useState<{ key: string; nonce: number } | null>(() => {
    const key = pinFor(openComment);
    return key ? { key, nonce: openNonce } : null;
  });
  useEffect(() => {
    if (!openComment) return;
    const key = pinFor(openComment);
    setOpenPin(key);
    if (key) setReveal({ key, nonce: openNonce });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- asked again by the nonce, not by the sent list changing.
  }, [openComment, openNonce]);
  useEffect(() => {
    if (pins.length || choice) unsent.set(unsentKey, { pins, choice });
    else unsent.delete(unsentKey);
  }, [unsentKey, pins, choice]);
  useEffect(() => {
    if (!kept || page !== "canvas") return;
    for (const item of [...(kept.choice ? [kept.choice] : []), ...kept.pins.filter((pin) => pin.text.trim()).map((pin) => pin.design)]) {
      const newest = designs.find((design) => design.id === item.id)?.version;
      if (newest !== undefined && item.version < newest && versions[item.id] == null) onVersion(item.id, item.version);
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once, as the panel opens with the kept feedback.
  }, []);
  const designIds = designs.map((design) => design.id).join("|");
  useEffect(() => {
    if (page !== "canvas") return;
    const ids = new Set(designIds.split("|"));
    setPins((current) => (current.every((pin) => ids.has(pin.design.id)) ? current : current.filter((pin) => ids.has(pin.design.id))));
    setChoice((current) => (current && !ids.has(current.id) ? null : current));
  }, [page, designIds]);
  const toggleComment = useCallback(() => setCommenting((value) => !value), []);
  const written = pins.filter((pin) => pin.text.trim());
  const count = written.length + (choice ? 1 : 0);
  const send = async () => {
    if (!onSend || sending || !count) return;
    setSending(true);
    setError("");
    try {
      const comments: DesignComment[] = written.map(({ key, design, x, y, text, nodeId, anchor, near, tab }) => ({
        id: key,
        design,
        x,
        y,
        text,
        ...(nodeId ? { nodeId } : {}),
        ...(anchor ? { anchor } : {}),
        ...(near ? { near } : {}),
        ...(tab ? { tab } : {}),
      }));
      if (await onSend(designFeedbackMessage({ choice, comments }))) {
        if (comments.length)
          void bridgeForKey(chatId)
            .artifacts.addComments?.({ chatId, comments })
            .then(onCommentsAdded, () => {});
        setPins([]);
        setOpenPin(null);
        setChoice(null);
        setCommenting(false);
        onSent();
      } else setError("The feedback didn't send. Try again.");
    } finally {
      setSending(false);
    }
  };
  const controls: PinControls = {
    showResolved,
    pins,
    sent: page === "page" ? htmlSentPins(hostComments, html) : sent,
    open: openPin,
    onPin: (design, x, y, nodeId, onPage) => {
      const key = newCommentId();
      setPins((current) => [
        ...current.filter((pin) => pin.key !== openPin || pin.text.trim()),
        {
          key,
          design,
          x,
          y,
          text: "",
          ...(nodeId ? { nodeId } : {}),
          ...(onPage?.anchor ? { anchor: onPage.anchor } : {}),
          ...(onPage?.near ? { near: onPage.near } : {}),
          ...(onPage?.tab ? { tab: onPage.tab } : {}),
        },
      ]);
      setOpenPin(key);
      return key;
    },
    onOpen: setOpenPin,
    onText: (key, text) => setPins((current) => current.map((pin) => (pin.key === key ? { ...pin, text } : pin))),
    onRemove: (key) => {
      setPins((current) => current.filter((pin) => pin.key !== key));
      setOpenPin((current) => (current === key ? null : current));
    },
    onSend: () => void send(),
  };
  const numbers = useMemo(() => {
    const byId = sentNumbers(hostComments);
    return new Map([...byId].map(([id, number]) => [`sent:${id}`, number] as const));
  }, [hostComments]);
  return {
    controls,
    numbers,
    reveal,
    count,
    send,
    sending,
    error,
    choice,
    setChoice,
    commenting,
    setCommenting,
    toggleComment,
    showResolved,
    setShowResolved,
  };
}
