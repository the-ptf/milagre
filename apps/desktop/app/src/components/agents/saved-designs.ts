import { useEffect, useState } from "react";
import type { ArtifactRef } from "../../model";
import { bridgeForKey } from "../../lib/computer-bridge";
import { DESIGN_DELETED, type DesignDeleted } from "./design-events";

const KEPT_CHATS = 64;
export function remember<T>(kept: Map<string, T>, key: string, value: T, limit = KEPT_CHATS) {
  kept.delete(key);
  kept.set(key, value);
  for (const oldest of kept.keys()) {
    if (kept.size <= limit) break;
    kept.delete(oldest);
  }
}

type SavedDesigns = {
  chatId: string | null;
  refs: ArtifactRef[];
  htmlAliases?: string[];
  revisionKey?: string;
  deleted?: string[];
};
const NO_SAVED_DESIGNS: SavedDesigns = { chatId: null, refs: [] };
const lastSavedDesigns = new Map<string, SavedDesigns>();
const htmlAliasOf = new Map<string, boolean>();

/**
 * The Chat's saved designs as the host lists them, re-read when `revisionKey` (the designs its steps name) changes,
 * with the ids of steps that named its HTML page and the designs deleted here since. Shows the last list read while
 * the next one loads.
 */
export function useSavedDesigns(chatId: string | null, fromSteps: Map<string, ArtifactRef>, revisionKey: string, enabled: boolean): SavedDesigns {
  const [savedDesigns, setSavedDesigns] = useState<SavedDesigns>(() => (chatId ? lastSavedDesigns.get(chatId) : undefined) ?? NO_SAVED_DESIGNS);
  useEffect(() => {
    if (savedDesigns.chatId) remember(lastSavedDesigns, savedDesigns.chatId, savedDesigns);
  }, [savedDesigns]);
  useEffect(() => {
    if (!chatId || !window.milagre) return;
    const list = bridgeForKey(chatId).artifacts?.list;
    if (!list) return;
    let live = true;
    list({ chatId })
      .then(async (refs) => {
        const known = new Set(refs.map((ref) => ref.id));
        const unknown = [...fromSteps.values()].filter((ref) => !ref.format && !known.has(ref.id));
        const aliases = await Promise.all(
          unknown.map(async (ref) => {
            const key = `${chatId}\n${ref.id}`;
            const html = htmlAliasOf.get(key);
            if (html !== undefined) return html ? ref.id : null;
            try {
              const artifact = await bridgeForKey(chatId).artifacts.get({ chatId, id: ref.id });
              remember(htmlAliasOf, key, artifact.format === "html", 1024);
              return artifact.format === "html" ? ref.id : null;
            } catch {
              return null;
            }
          }),
        );
        if (live)
          setSavedDesigns((current) => ({
            chatId,
            refs,
            htmlAliases: aliases.filter((id): id is string => id !== null),
            revisionKey,
            deleted: current.chatId === chatId ? current.deleted : [],
          }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [chatId, revisionKey, enabled]);
  useEffect(() => {
    const deleted = (event: Event) => {
      const detail = (event as CustomEvent<DesignDeleted>).detail;
      if (detail.chatId !== chatId) return;
      setSavedDesigns((current) =>
        current.chatId === chatId
          ? { ...current, refs: current.refs.filter((item) => item.id !== detail.id), deleted: [...(current.deleted ?? []), detail.id] }
          : { chatId, refs: [], htmlAliases: [], deleted: [detail.id] },
      );
    };
    window.addEventListener(DESIGN_DELETED, deleted);
    return () => {
      window.removeEventListener(DESIGN_DELETED, deleted);
    };
  }, [chatId, enabled]);
  const shownDesigns = savedDesigns.chatId === chatId ? savedDesigns : ((chatId ? lastSavedDesigns.get(chatId) : undefined) ?? NO_SAVED_DESIGNS);
  return shownDesigns;
}
