import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AgentRuns } from "@milagre/shared/agent-runs";
import { isLinkScopeKey } from "@milagre/shared/chat-scopes";
import type { TileMenuControls } from "../components/agents/TileFamilyMenu";
import { projectOfKey, sessionIdFromKey } from "../lib/agent-runs";
import { activeChatKeys, draftTileKey, gridChats, isDraftTileKey, readChatLayout, saveChatLayout, type ChatLayout } from "../lib/chat-grid";
import { dropSide, gridDrop, placeDropped, readGridPins, readSplitChats, saveGridPins, saveSplitChats, type GridDropTarget } from "../lib/grid-drop";
import { useEvent } from "../lib/stable";
import { chatFamily } from "../lib/subchat-rows";
import { besideParent, familySplit, swapTile } from "../lib/subchat-split";
import type { CoordinatorState, LinkState, LinkedWork } from "../model";

const NO_KEYS: string[] = [];

type States = Record<string, CoordinatorState | LinkState>;

function useLayoutState() {
  const [layout, setLayout] = useState<ChatLayout>(() => readChatLayout(localStorage));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => saveChatLayout(localStorage, layout), [layout]);
  const [gridPins, setGridPins] = useState<readonly string[]>(() => readGridPins(localStorage));
  const changeGridPins = (change: (pins: readonly string[]) => readonly string[]) =>
    setGridPins((current) => {
      const next = change(current);
      saveGridPins(localStorage, next);
      return next;
    });
  const [splitKeys, setSplitKeys] = useState<readonly string[]>(() => readSplitChats(localStorage));
  useEffect(() => saveSplitChats(localStorage, splitKeys), [splitKeys]);
  const [closingTile, setClosingTile] = useState<string | null>(null);
  const [splitTarget, setSplitTarget] = useState<string | null>(null);
  return { layout, setLayout, layoutRef, gridPins, changeGridPins, splitKeys, setSplitKeys, closingTile, setClosingTile, splitTarget, setSplitTarget };
}

type LayoutState = ReturnType<typeof useLayoutState>;

function useGridTiles(state: LayoutState, gridOn: boolean, gridFocusKey: string | null, runs: AgentRuns, linkedWork: LinkedWork, gridStates: States) {
  const { gridPins, changeGridPins } = state;
  const livePins = useMemo(
    () =>
      gridPins.filter((key) => {
        const scope = gridStates[projectOfKey(key)];
        const session = scope?.sessions?.[sessionIdFromKey(key)];
        return !scope || Boolean(session && !session.archived);
      }),
    [gridPins, gridStates],
  );
  const activeKeys = useMemo(
    () => (gridOn ? [...activeChatKeys(runs, linkedWork, gridStates), ...livePins] : NO_KEYS),
    [gridOn, runs, linkedWork, gridStates, livePins],
  );
  const pinnedTiles = useMemo(() => new Set(livePins), [livePins]);
  const toggleGridPin = useEvent((key: string) => changeGridPins((pins) => (pins.includes(key) ? pins.filter((item) => item !== key) : [...pins, key])));
  const [gridTiles, setGridTiles] = useState<readonly string[]>(NO_KEYS);
  const nextGridTiles = gridChats(gridTiles, activeKeys, gridOn ? gridFocusKey : null);
  if (nextGridTiles !== gridTiles) setGridTiles(nextGridTiles);
  return { pinnedTiles, toggleGridPin, gridTiles, setGridTiles };
}

function useSplit(state: LayoutState, chatView: boolean, gridFocusKey: string | null, gridStates: States) {
  const { layout, setLayout, splitKeys, setSplitKeys, closingTile, setClosingTile, splitTarget, setSplitTarget } = state;
  const [splitFocus, setSplitFocus] = useState(gridFocusKey);
  const leftForDraft =
    chatView && splitFocus !== gridFocusKey && splitFocus !== null && !isDraftTileKey(splitFocus) && gridFocusKey !== null && isDraftTileKey(gridFocusKey);
  const focusMoved = chatView && splitFocus !== gridFocusKey;
  if (focusMoved) {
    setSplitFocus(gridFocusKey);
    if (closingTile !== null) setClosingTile(null);
  }
  const split = focusMoved && layout === "split" && closingTile === splitFocus ? splitKeys.filter((key) => key !== closingTile) : splitKeys;
  const liveSplit = useMemo(
    () =>
      split.filter((key) => {
        if (key === gridFocusKey) return true;
        const scope = gridStates[projectOfKey(key)];
        const session = scope?.sessions?.[sessionIdFromKey(key)];
        return !isDraftTileKey(key) && (!scope || Boolean(session && !session.archived));
      }),
    [split, gridStates, gridFocusKey],
  );
  const splitShown = layout === "split" && gridFocusKey !== null && liveSplit.length > 1 && liveSplit.includes(gridFocusKey);
  if (splitTarget !== null && gridFocusKey === splitTarget) setSplitTarget(null);
  if (
    layout === "split" &&
    chatView &&
    !splitShown &&
    closingTile === null &&
    splitTarget === null &&
    gridFocusKey !== null &&
    (!isDraftTileKey(gridFocusKey) || leftForDraft)
  ) {
    setLayout("single");
    if (splitKeys !== NO_KEYS) setSplitKeys(NO_KEYS);
  } else if (split !== splitKeys) setSplitKeys(split);
  return { splitOn: splitShown && chatView, liveSplit };
}

export type ChatLayoutInputs = {
  view: "chat" | "canvas" | "routines";
  viewRef: RefObject<string>;
  projectPath: string | undefined;
  projectRef: RefObject<unknown>;
  linkOpenRef: RefObject<unknown>;
  linkOpen: boolean;
  focusedChatKey: string | null;
  gridStates: States;
  runs: AgentRuns;
  linkedWork: LinkedWork;
  openLinkedChat: (key: string) => void;
  openAlone: (key: string) => void;
};

function useDropTarget(
  inputs: ChatLayoutInputs,
  shownTilesRef: RefObject<readonly string[]>,
  focusedChatKeyRef: RefObject<string | null>,
  drop: (key: string, target: GridDropTarget) => void,
) {
  const { viewRef, linkOpenRef, projectRef } = inputs;
  useEffect(
    () =>
      gridDrop.register({
        hit: (x, y, key) => {
          if (viewRef.current !== "chat" || linkOpenRef.current || !projectRef.current) return null;
          const under = document.elementFromPoint(x, y);
          const tile = under?.closest<HTMLElement>("[data-chat-tile]");
          if (tile) {
            const tileKey = tile.dataset.chatTile ?? "";
            return tileKey === key ? null : { tile: tileKey, ...dropSide(tile.getBoundingClientRect(), x, 12) };
          }
          const focused = focusedChatKeyRef.current;
          if (shownTilesRef.current.length || !focused || focused === key) return null;
          const pane = under?.closest<HTMLElement>("[data-chat-pane]");
          return pane ? { tile: null, ...dropSide(pane.getBoundingClientRect(), x, 0) } : null;
        },
        drop,
      }),
    [],
  );
}

function useTileMenu(inputs: ChatLayoutInputs, endSplit: () => void, swapSplitTile: (tile: string, next: string) => void) {
  const { gridStates, runs, linkedWork } = inputs;
  const openAlone = useEvent((key: string) => inputs.openAlone(key));
  const familyReadsRef = useRef<TileMenuControls["reads"]>(() => ({ sessions: undefined, runs: {}, work: { delegations: [] } }));
  familyReadsRef.current = (key) => ({
    sessions: isLinkScopeKey(projectOfKey(key)) ? undefined : (gridStates[projectOfKey(key)] as CoordinatorState | undefined)?.sessions,
    runs,
    work: linkedWork,
  });
  return useMemo<TileMenuControls>(
    () => ({
      reads: (key) => familyReadsRef.current(key),
      onOpenAlone: (key) => {
        endSplit();
        openAlone(key);
      },
      onReplace: swapSplitTile,
    }),
    [endSplit, openAlone, swapSplitTile],
  );
}

/**
 * The Chat view's grid and split: which Chats show as tiles, and every way in and out of them.
 *
 * One split rule: a Chat on screen is focused; opening any other Chat ends the split and shows it alone, and so does
 * leaving a Chat for a new Chat's draft. A split waits while a closed or swapped tile's neighbour loads, so it never
 * drops to one Chat mid-load. A new Chat not saved yet holds its grid slot as a draft tile. Pins and split Chats whose
 * Chat was archived drop out; ones in a Project not read yet stay.
 */
export function useChatLayout(inputs: ChatLayoutInputs) {
  const { view, projectPath, linkOpen, linkOpenRef, focusedChatKey, gridStates, openLinkedChat } = inputs;
  const state = useLayoutState();
  const { layout, setLayout, layoutRef, changeGridPins, setSplitKeys, setClosingTile, setSplitTarget } = state;
  const toggleLayout = () => setLayout((current) => (current === "grid" ? "single" : "grid"));
  const gridOn = layout === "grid" && view === "chat";
  const gridFocusKey = focusedChatKey ?? (projectPath !== undefined && !linkOpen ? draftTileKey(projectPath) : null);
  const { pinnedTiles, toggleGridPin, gridTiles, setGridTiles } = useGridTiles(state, gridOn, gridFocusKey, inputs.runs, inputs.linkedWork, gridStates);
  const { splitOn, liveSplit } = useSplit(state, view === "chat", gridFocusKey, gridStates);
  const shownTiles = splitOn ? liveSplit : gridOn && gridFocusKey ? gridTiles : NO_KEYS;
  const shownTilesRef = useRef(shownTiles);
  shownTilesRef.current = shownTiles;
  const focusedChatKeyRef = useRef(focusedChatKey);
  focusedChatKeyRef.current = focusedChatKey;
  const gridFocusKeyRef = useRef(gridFocusKey);
  gridFocusKeyRef.current = gridFocusKey;
  const dropOnGrid = useEvent((key: string, target: GridDropTarget) => {
    const focused = focusedChatKeyRef.current;
    if (layoutRef.current === "grid") {
      changeGridPins((pins) => [...pins.filter((item) => item !== key), key]);
      setGridTiles((tiles) => placeDropped(tiles, key, target, focused));
      return;
    }
    setSplitKeys(placeDropped(shownTilesRef.current, key, target, focused));
    setLayout("split");
  });
  const closeSplitTile = useEvent((key: string) => {
    const tiles = shownTilesRef.current;
    const next = tiles.filter((item) => item !== key);
    const at = tiles.indexOf(key);
    const neighbour = [...next.slice(at), ...next.slice(0, at).toReversed()].find((item) => !isDraftTileKey(item));
    if (key !== gridFocusKeyRef.current || !neighbour) {
      setSplitKeys(next);
      return;
    }
    setClosingTile(key);
    openLinkedChat(neighbour);
  });
  const focusedFamily = useMemo(
    () => (focusedChatKey ? chatFamily(gridStates[projectOfKey(focusedChatKey)]?.sessions, focusedChatKey) : null),
    [gridStates, focusedChatKey],
  );
  const endSplit = useEvent(() => {
    setSplitKeys(NO_KEYS);
    setLayout("single");
  });
  const openBeside = useEvent((parent: string) => {
    const open = gridFocusKeyRef.current;
    if (!open || linkOpenRef.current) return;
    setSplitKeys(besideParent(parent, open));
    setLayout("split");
  });
  const showFamily = useEvent(() => {
    if (!focusedFamily) return;
    setSplitKeys(familySplit(focusedFamily, gridFocusKeyRef.current));
    setLayout("split");
  });
  useDropTarget(inputs, shownTilesRef, focusedChatKeyRef, dropOnGrid);
  const swapSplitTile = useEvent((tile: string, next: string) => {
    const swapped = swapTile(shownTilesRef.current, tile, next);
    if (swapped === shownTilesRef.current) return;
    setSplitKeys(swapped);
    if (tile === gridFocusKeyRef.current) {
      setSplitTarget(next);
      openLinkedChat(next);
    }
  });
  const tileMenu = useTileMenu(inputs, endSplit, swapSplitTile);
  return {
    layout,
    toggleLayout,
    gridOn,
    gridFocusKey,
    gridFocusKeyRef,
    focusedChatKeyRef,
    shownTiles,
    shownTilesRef,
    splitOn,
    pinnedTiles,
    toggleGridPin,
    closeSplitTile,
    focusedFamily,
    openBeside,
    showFamily,
    tileMenu,
  };
}
