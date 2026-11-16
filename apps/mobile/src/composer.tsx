import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PermissionMode } from "@milagre/shared/model";
import type { ComposerQuote } from "@milagre/shared/prompt-parts";
import type { Attachment } from "./attachments";
import { readPermission, savedChatDefaults, savePermission } from "./hosts-native";
import { createLinkOperations } from "./link-operations";
import { defaultPreferences, type TurnPreferences } from "./turn-options";

/**
 * Drafts, attachments and quotes change on every keystroke, so they live in a context of their own that only the
 * composer reads: typing re-renders the composer, not the Chat around it, which reads them through `readDrafts`.
 */
export function ComposerProvider({ children }: { children: React.ReactNode }) {
  const [linkOperations] = useState(createLinkOperations);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [attachments, setAttachments] = useState<Record<string, Attachment[]>>({});
  const [quotes, setQuotes] = useState<Record<string, ComposerQuote[]>>({});
  const [preferences, setPreferences] = useState<Record<string, TurnPreferences>>({});
  const [compactRequests, setCompactRequests] = useState<Record<string, number>>({});
  const requestCompact = useCallback((chatId: string) => setCompactRequests((current) => ({ ...current, [chatId]: (current[chatId] ?? 0) + 1 })), []);
  const [permission, setPermission] = useState<PermissionMode>("ask");
  useEffect(() => {
    void readPermission().then((saved) => {
      if (saved) setPermission(saved);
    });
  }, []);
  const [modelDefaults, setModelDefaults] = useState(() => savedChatDefaults.readModel());
  const defaults = useMemo(() => ({ ...defaultPreferences, ...modelDefaults, permissionMode: permission }), [modelDefaults, permission]);
  const setDefaultModel = useCallback((choice: TurnPreferences) => {
    const { provider, model, effort, fastMode, ultracode } = choice;
    setModelDefaults({ provider, model, effort, fastMode, ultracode });
    void savedChatDefaults.saveModel(choice);
  }, []);
  const setDefaultPermission = useCallback((mode: PermissionMode) => {
    setPermission(mode);
    void savePermission(mode);
  }, []);
  const held = useMemo(() => ({ drafts, attachments, quotes }), [drafts, attachments, quotes]);
  const latest = useRef(held);
  useLayoutEffect(() => {
    latest.current = held;
  }, [held]);
  const readDrafts = useCallback(() => latest.current, []);
  const value = useMemo(
    () => ({
      setDrafts,
      setAttachments,
      setQuotes,
      readDrafts,
      preferences,
      setPreferences,
      defaults,
      setDefaultPermission,
      setDefaultModel,
      linkOperations,
      compactRequests,
      requestCompact,
    }),
    [readDrafts, preferences, defaults, setDefaultPermission, setDefaultModel, linkOperations, compactRequests, requestCompact],
  );
  return (
    <ComposerContext.Provider value={value}>
      <ComposerDraftsContext.Provider value={held}>{children}</ComposerDraftsContext.Provider>
    </ComposerContext.Provider>
  );
}
type ComposerDrafts = {
  drafts: Record<string, string>;
  attachments: Record<string, Attachment[]>;
  /** Passages quoted from the transcript, kept beside each Chat's draft until it is sent. */
  quotes: Record<string, ComposerQuote[]>;
};
type Composer = {
  linkOperations: ReturnType<typeof createLinkOperations>;
  /** The last permission mode picked starts every Chat, as desktop's default does, and survives a relaunch. */
  defaults: TurnPreferences;
  setDefaultModel: (choice: TurnPreferences) => void;
  setDefaultPermission: (mode: PermissionMode) => void;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setAttachments: React.Dispatch<React.SetStateAction<Record<string, Attachment[]>>>;
  setQuotes: React.Dispatch<React.SetStateAction<Record<string, ComposerQuote[]>>>;
  /** The drafts as they stand now, for a send or a pick: reading them this way doesn't re-render on each keystroke. */
  readDrafts: () => ComposerDrafts;
  preferences: Record<string, TurnPreferences>;
  setPreferences: React.Dispatch<React.SetStateAction<Record<string, TurnPreferences>>>;
  /** How many times Compact now was pressed per chat key; the chat screen acts on each change. */
  compactRequests: Record<string, number>;
  requestCompact: (chatId: string) => void;
};
const ComposerContext = createContext<Composer | null>(null);
const ComposerDraftsContext = createContext<ComposerDrafts | null>(null);
export function useComposer() {
  const composer = useContext(ComposerContext);
  if (!composer) throw new Error("SessionProvider is required");
  return composer;
}
export function useComposerDrafts() {
  const held = useContext(ComposerDraftsContext);
  if (!held) throw new Error("SessionProvider is required");
  return held;
}
