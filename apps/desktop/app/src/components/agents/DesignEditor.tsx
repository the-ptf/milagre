import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ARTIFACT_CSP, ARTIFACT_ESCAPE, artifactDocument, type DesignArtifact as Artifact } from "@milagre/shared/artifact";
import {
  applyDesignOperations,
  createDesignInstance,
  detachDesignInstance,
  designHtml,
  designInstanceRoot,
  designLayout,
  diffDesignDocuments,
  type DesignDocument,
  type DesignNode,
  type DesignOperation,
} from "@milagre/shared/design";
import { rebaseDesign, describeDesignChanges, designConflictValue, isDesignVersionConflict, type DesignConflictChoices } from "./design-rebase";
import { DesignTools } from "./DesignTools";
import type { DesignEditorSession, DesignEditorWorkspace } from "./design-editor-session";
import { designDraftCache, type DesignFieldDraft, type DesignHistory } from "./design-draft-cache";
import { useDesignsEnabled } from "../../lib/designs-enabled";
import { bridgeForKey } from "../../lib/computer-bridge";
import { ScrollArea } from "../primitives/ScrollArea";
import { Select } from "../primitives/Select";

export const DESIGN_SAVED = "milagre:design-saved";
export type DesignSaved = { chatId: string; artifact: Artifact };

const fieldClass =
  "min-w-0 w-full rounded-control border border-line bg-canvas px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent disabled:opacity-50";
const buttonClass = "rounded-control border border-line px-2.5 py-1.5 text-[12px] text-ink hover:bg-hover disabled:opacity-40";
const fingerprint = (document: DesignDocument) => JSON.stringify(document);
const rounded = (value: number) => Math.round(value * 100) / 100;
const DraftFields = createContext({ pending: (_value: boolean) => {}, fields: new Map<string, DesignFieldDraft>(), scope: "" });

function designError(cause: unknown): string {
  if (cause && typeof cause === "object" && "issues" in cause && Array.isArray(cause.issues)) {
    let issue = cause.issues[0];
    while (issue?.errors?.[0]?.[0]) issue = issue.errors[0][0];
    if (typeof issue?.message === "string") return issue.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/** A field keeps its draft until blur or Enter, so typing a number doesn't create an undo step per digit. */
function Field({
  label,
  value,
  number = false,
  min,
  max,
  disabled,
  multiline = false,
  onCommit,
}: {
  label: string;
  value: string | number;
  number?: boolean;
  min?: number;
  max?: number;
  disabled?: boolean;
  multiline?: boolean;
  onCommit: (value: string) => void;
}) {
  const pending = useContext(DraftFields);
  const fieldKey = JSON.stringify([pending.scope, label]);
  const [draft, setDraft] = useState(() => {
    const restored = pending.fields.get(fieldKey);
    return restored?.base === String(value) ? restored.value : String(value);
  });
  const [previousValue, setPreviousValue] = useState(value);
  if (previousValue !== value) {
    setPreviousValue(value);
    setDraft(String(value));
  }
  const commit = () => {
    if (draft === String(value)) return;
    if (
      number &&
      (!draft.trim() || !Number.isFinite(Number(draft)) || (min !== undefined && Number(draft) < min) || (max !== undefined && Number(draft) > max))
    ) {
      setDraft(String(value));
      return;
    }
    onCommit(draft);
  };
  const common = {
    "aria-label": label,
    value: draft,
    disabled,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(event.target.value);
      pending.fields.set(fieldKey, { value: event.target.value, base: String(value) });
      pending.pending(true);
    },
    onBlur: () => {
      commit();
      pending.fields.delete(fieldKey);
      pending.pending(false);
    },
    className: fieldClass,
  };
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[11px] text-ink-3">
      <span>{label}</span>
      {multiline ? (
        <textarea {...common} rows={3} className={`${fieldClass} resize-y`} />
      ) : (
        <input
          {...common}
          type={number ? "number" : "text"}
          step={number ? "any" : undefined}
          min={min}
          max={max}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      )}
    </label>
  );
}

type History = DesignHistory;
/** A selected frame owns its descendants, so a bulk operation never applies twice to a subtree. */
function selectionRoots(document: DesignDocument, ids: string[]): DesignNode[] {
  const selected = new Set(ids);
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  return ids.flatMap((id) => {
    const node = nodes.get(id);
    if (!node) return [];
    let parent = node.parentId;
    while (parent) {
      if (selected.has(parent)) return [];
      parent = nodes.get(parent)?.parentId;
    }
    return [node];
  });
}

function selectableIds(document: DesignDocument, ids: string[]): string[] {
  return [...new Set(ids.filter((id) => document.nodes.some((node) => node.id === id)).map((id) => designInstanceRoot(document, id)?.id ?? id))];
}

function movable(document: DesignDocument, node: DesignNode): boolean {
  const parent = document.nodes.find((item) => item.id === node.parentId);
  if (parent?.layout && parent.layout !== "free") return false;
  let current: DesignNode | undefined = node;
  while (current) {
    if (current.locked) return false;
    current = document.nodes.find((item) => item.id === current?.parentId);
  }
  return true;
}

/** Structured documents share the agent's operations and renderer, while edits stay local until Save. */
export function DesignDocumentEditor({
  chatId,
  artifact,
  latestVersion = artifact.latest,
  workspace,
}: {
  chatId: string;
  artifact: Artifact;
  latestVersion?: number;
  onClose: () => void;
  workspace: DesignEditorWorkspace;
}) {
  const { enabled } = useDesignsEnabled(chatId);
  const cacheKey = JSON.stringify([chatId, artifact.id]);
  const [suspendedDraft, setSuspendedDraft] = useState(() => designDraftCache.read(cacheKey));
  const [fieldDrafts] = useState(() => new Map<string, DesignFieldDraft>());
  const [fieldRevision, setFieldRevision] = useState(0);
  const discardOnUnmount = useRef(false);
  const [saved, setSaved] = useState(artifact);
  const [history, setHistory] = useState<History>({
    past: [],
    present: artifact.document,
    future: [],
  });
  const document = history.present;
  const { layersOpen, setLayersOpen } = workspace;
  const [selection, setSelection] = useState<string[]>(() => {
    const first = document.nodes.find((node) => node.type === "text") ?? document.nodes[0];
    return first ? selectableIds(document, [first.id]) : [];
  });
  const selectedIds = useMemo(() => selectableIds(document, selection), [document, selection]);
  const selectedNode = selectedIds.length === 1 ? document.nodes.find((node) => node.id === selectedIds[0])! : null;
  const selectedRoots = selectionRoots(document, selectedIds);
  const selectedInstance = selectedNode ? designInstanceRoot(document, selectedNode.id) : null;
  const bounds = useMemo(() => designLayout(document), [document]);
  const selectedBounds = selectedRoots.map((node) => bounds.get(node.id)).filter((box) => box !== undefined);
  const groupPosition = selectedBounds.length
    ? { x: Math.min(...selectedBounds.map((box) => box.x)), y: Math.min(...selectedBounds.map((box) => box.y)) }
    : null;
  const canMoveSelection = selectedRoots.length > 0 && selectedRoots.every((node) => movable(document, node));
  const [saving, setSaving] = useState(false);
  const [editingField, setEditingField] = useState(false);
  const [error, setError] = useState("");
  const [incoming, setIncoming] = useState<Artifact | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [choices, setChoices] = useState<DesignConflictChoices>({});
  const [notice, setNotice] = useState("");
  const [recovery, setRecovery] = useState<{ saved: Artifact; history: History } | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const dialog = useRef<HTMLElement | null>(null);
  const active = workspace.activeId === saved.id;
  useLayoutEffect(() => {
    dialog.current = workspace.root;
  }, [workspace.root]);
  const closeLayers = useCallback(() => {
    setLayersOpen(false);
    requestAnimationFrame(() => dialog.current?.querySelector<HTMLButtonElement>('[data-slot="design-layers-toggle"]')?.focus());
  }, [setLayersOpen]);
  const dirty = useMemo(() => fingerprint(document) !== fingerprint(saved.document), [document, saved.document]);
  const merge = useMemo(
    () => (incoming ? rebaseDesign(saved.document, document, incoming.document, choices) : null),
    [saved.document, document, incoming, choices],
  );
  const latestChanges = useMemo(() => (incoming ? describeDesignChanges(saved.document, incoming.document) : []), [saved.document, incoming]);
  const state = useRef({ document, history, saved, saving, enabled, editingField, selection, recovery });
  useLayoutEffect(() => {
    state.current = { document, history, saved, saving, enabled, editingField, selection, recovery };
  }, [document, history, saved, saving, enabled, editingField, selection, recovery]);
  useLayoutEffect(
    () => () => {
      const current = state.current;
      if (discardOnUnmount.current) return;
      const fields = [...fieldDrafts].filter(([, field]) => field.value !== field.base);
      if (current.recovery || fields.length || fingerprint(current.document) !== fingerprint(current.saved.document))
        designDraftCache.save(cacheKey, {
          saved: current.saved,
          history: { ...current.history, present: current.document },
          selection: current.selection,
          fields,
          recovery: current.recovery,
        });
    },
    [cacheKey, fieldDrafts],
  );
  // Pending saves reject edits. Removing the controller also clears any unacknowledged pointer/keyboard movement.
  const { html, previewError } = useMemo(() => {
    try {
      return { html: artifactDocument(designHtml(document, { interactive: !saving })), previewError: "" };
    } catch (cause) {
      return { html: "", previewError: designError(cause) };
    }
  }, [document, saving]);
  const syncSelection = useCallback(
    () =>
      frame.current?.contentWindow?.postMessage(
        { type: "milagre:design-selection", ids: active ? selectedIds : [], id: active ? (selectedIds.at(-1) ?? null) : null },
        "*",
      ),
    [selectedIds, active],
  );
  useEffect(syncSelection, [html, syncSelection]);
  const selectLayer = (id: string, additive: boolean) => {
    const target = designInstanceRoot(document, id)?.id ?? id;
    setSelection((current) => (additive ? (current.includes(target) ? current.filter((item) => item !== target) : [...current, target]) : [target]));
  };

  const change = useCallback((operations: DesignOperation[]) => {
    if (!state.current.enabled || state.current.saving || !operations.length) return false;
    try {
      const next = applyDesignOperations(state.current.document, operations);
      if (fingerprint(next) === fingerprint(state.current.document)) return true;
      const current = state.current.history;
      const nextHistory = { past: [...current.past.slice(-99), current.present], present: next, future: [] };
      state.current.history = nextHistory;
      state.current.document = next;
      setHistory(nextHistory);
      setError("");

      return true;
    } catch (cause) {
      setError(designError(cause));
      return false;
    }
  }, []);
  const patch = (patchValue: Partial<DesignNode>) => {
    if (selectedNode) change([{ op: "update", id: selectedNode.id, patch: patchValue }]);
  };
  const undo = useCallback(() => {
    if (!state.current.enabled || state.current.saving) return;
    const current = state.current.history;
    if (!current.past.length) return;
    const next = { past: current.past.slice(0, -1), present: current.past.at(-1)!, future: [current.present, ...current.future] };
    state.current.history = next;
    state.current.document = next.present;
    setHistory(next);
    setError("");
  }, []);
  const redo = useCallback(() => {
    if (!state.current.enabled || state.current.saving) return;
    const current = state.current.history;
    if (!current.future.length) return;
    const next = { past: [...current.past, current.present], present: current.future[0]!, future: current.future.slice(1) };
    state.current.history = next;
    state.current.document = next.present;
    setHistory(next);
    setError("");
  }, []);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data || typeof event.data !== "object") return;
      const data = event.data as { type?: string; id?: unknown; ids?: unknown; patch?: unknown; operations?: unknown };
      if (data.type === "milagre:design-select") {
        workspace.activate(saved.id);
        if (Array.isArray(data.ids) && data.ids.every((id) => typeof id === "string")) setSelection(selectableIds(state.current.document, data.ids));
        else if (data.id === null) setSelection([]);
        else if (typeof data.id === "string") setSelection(selectableIds(state.current.document, [data.id]));
        return;
      }
      if (data.type !== "milagre:design-update") return;
      const known = new Set(state.current.document.nodes.map((node) => node.id));
      if (Array.isArray(data.operations)) {
        if (
          data.operations.length <= 1000 &&
          data.operations.every(
            (operation) =>
              operation &&
              operation.op === "update" &&
              known.has(operation.id) &&
              operation.patch &&
              typeof operation.patch === "object" &&
              !Array.isArray(operation.patch),
          )
        )
          change(data.operations as DesignOperation[]);
      } else if (typeof data.id === "string" && known.has(data.id) && data.patch && typeof data.patch === "object" && !Array.isArray(data.patch)) {
        change([{ op: "update", id: data.id, patch: data.patch as Partial<DesignNode> }]);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [change, workspace.activate, saved.id]);

  const publish = useCallback(
    (next: Artifact) => {
      window.dispatchEvent(new CustomEvent<DesignSaved>(DESIGN_SAVED, { detail: { chatId, artifact: next } }));
    },
    [chatId],
  );
  const stageMerge = useCallback(
    (latest: Artifact, decisions: DesignConflictChoices = {}) => {
      const current = state.current;
      const result = rebaseDesign(current.saved.document, current.document, latest.document, decisions);
      if (!result.document || result.structural || result.conflicts.some((field) => !decisions[field.key])) return false;
      // A merge is one undoable edit against the latest document. The complete earlier draft/history remains recoverable.
      if (fingerprint(current.document) !== fingerprint(current.saved.document))
        setRecovery({ saved: current.saved, history: { ...current.history, present: current.document } });
      setSaved(latest);
      setHistory({ past: [latest.document], present: result.document, future: [] });
      state.current.document = result.document;
      state.current.saved = latest;
      setIncoming(null);
      setReviewing(false);
      setEditingField(false);
      setChoices({});
      setError("");
      setNotice(`Your edits are merged with version ${latest.version}. Review the canvas, then Save.`);
      publish(latest);
      return true;
    },
    [publish, setEditingField],
  );
  const receiveLatest = useCallback(
    (latest: Artifact) => {
      const current = state.current;
      if (!current.enabled || latest.version <= current.saved.version) return;
      if (!current.editingField && fingerprint(current.document) === fingerprint(current.saved.document)) {
        setSaved(latest);
        setHistory({ past: [], present: latest.document, future: [] });
        state.current.document = latest.document;
        state.current.saved = latest;
        setIncoming(null);
        setReviewing(false);
        setNotice(`Updated to version ${latest.version}.`);
      } else {
        setIncoming(latest);
        setChoices({});
        setReviewing(false);
        setNotice(`Version ${latest.version} is available. Your draft and Undo history are still here.`);
      }
      publish(latest);
    },
    [publish],
  );
  useEffect(() => {
    if (incoming && !dirty && !editingField && !saving) receiveLatest(incoming);
  }, [incoming, dirty, editingField, saving, receiveLatest]);
  useEffect(() => {
    if (!enabled || saving || latestVersion <= saved.version || latestVersion <= (incoming?.version ?? 0)) return;
    let live = true;
    bridgeForKey(chatId)
      .artifacts.get({ chatId, id: saved.id })
      .then(
        (latest) => {
          if (live && latest.format === "design") receiveLatest(latest);
          return null;
        },
        (cause) => {
          if (live) setError(`Could not read the latest design. ${designError(cause)}`);
        },
      );
    return () => {
      live = false;
    };
  }, [chatId, enabled, saving, latestVersion, saved.id, saved.version, incoming?.version, receiveLatest]);

  const persist = async (nextDocument: DesignDocument, base: Artifact, replace = false) => {
    if (!state.current.enabled || state.current.saving) return false;
    if (replace && fingerprint(nextDocument) === fingerprint(state.current.saved.document)) {
      receiveLatest(base);
      return false;
    }
    setSaving(true);
    state.current.saving = true;
    setError("");
    try {
      const next = await bridgeForKey(chatId).artifacts.apply({
        chatId,
        id: base.id,
        expectedVersion: base.version,
        operations: replace ? [{ op: "replace", document: nextDocument }] : diffDesignDocuments(base.document, nextDocument),
      });
      setSaved(next);
      setHistory((current) => ({ ...current, present: next.document }));
      state.current.document = next.document;
      state.current.saved = next;
      fieldDrafts.clear();
      designDraftCache.delete(cacheKey);
      setSuspendedDraft(undefined);
      setIncoming(null);
      setReviewing(false);
      setRecovery(null);
      setNotice("");
      publish(next);
      return true;
    } catch (cause) {
      const message = designError(cause);
      if (isDesignVersionConflict(message)) {
        try {
          const latest = await bridgeForKey(chatId).artifacts.get({ chatId, id: base.id });
          if (latest.format !== "design") throw new Error("This page is no longer an editable design.");
          // Only disjoint fields can merge automatically. A new Save is still required.
          if (replace || !stageMerge(latest)) {
            setIncoming(latest);
            setChoices({});
            setReviewing(false);
            setNotice(`Version ${latest.version} changed while you were editing. Review it before saving. Your draft and Undo history are still here.`);
            publish(latest);
          }
        } catch (readError) {
          setError(`Your draft is still here. Could not read the latest version. ${designError(readError)}`);
        }
      } else setError(`Your edits could not be saved. ${message}`);
      return false;
    } finally {
      setSaving(false);
      state.current.saving = false;
    }
  };
  const save = async () => {
    if (!enabled || saving || incoming || previewError) return false;
    const activeElement = window.document.activeElement;
    if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) activeElement.blur();
    const nextDocument = state.current.document;
    if (fingerprint(nextDocument) !== fingerprint(saved.document)) return persist(nextDocument, saved);
    return true;
  };
  const reload = async () => {
    if (saving) return;
    setSaving(true);
    state.current.saving = true;
    try {
      const latest = await bridgeForKey(chatId).artifacts.get({ chatId, id: saved.id });
      if (latest.format !== "design") throw new Error("This page is no longer an editable design.");
      const current = state.current;
      const hadDraft = fingerprint(current.document) !== fingerprint(current.saved.document);
      if (hadDraft) setRecovery({ saved: current.saved, history: { ...current.history, present: current.document } });
      setSaved(latest);
      setHistory({ past: [], present: latest.document, future: [] });
      state.current.document = latest.document;
      state.current.saved = latest;
      setIncoming(null);
      setReviewing(false);
      setEditingField(false);
      setError("");
      setNotice(hadDraft || recovery ? "Latest version loaded. Your earlier draft and Undo history can still be restored." : "Latest version loaded.");
      publish(latest);
    } catch (cause) {
      setError(designError(cause));
    } finally {
      setSaving(false);
      state.current.saving = false;
    }
  };
  const restoreDraft = () => {
    if (!recovery || saving) return;
    const latest = saved;
    setSaved(recovery.saved);
    setHistory(recovery.history);
    state.current.saved = recovery.saved;
    state.current.document = recovery.history.present;
    setIncoming(latest.version > recovery.saved.version ? latest : incoming);
    setRecovery(null);
    setReviewing(false);
    setChoices({});
    setNotice("Your draft and its Undo history are restored.");
  };
  const restoreSuspendedDraft = () => {
    if (!suspendedDraft || saving) return;
    // A clean current document only carries the earlier draft retained by Load latest.
    const draft =
      suspendedDraft.recovery && !suspendedDraft.fields.length && fingerprint(suspendedDraft.history.present) === fingerprint(suspendedDraft.saved.document)
        ? { ...suspendedDraft, ...suspendedDraft.recovery, recovery: null }
        : suspendedDraft;
    const latest = saved;
    setSaved(draft.saved);
    setHistory(draft.history);
    setRecovery(draft.recovery ?? null);
    setSelection(draft.selection);
    fieldDrafts.clear();
    for (const [key, value] of draft.fields) fieldDrafts.set(key, value);
    setFieldRevision((value) => value + 1);
    setEditingField(draft.fields.length > 0);
    state.current = {
      ...state.current,
      saved: draft.saved,
      document: draft.history.present,
      history: draft.history,
      recovery: draft.recovery ?? null,
      selection: draft.selection,
      editingField: draft.fields.length > 0,
    };
    setIncoming(latest.version > draft.saved.version ? latest : null);
    setSuspendedDraft(undefined);
    setNotice("Your draft and its Undo history are restored. Review any newer version before saving.");
    const firstField = suspendedDraft.fields[0]?.[0];
    if (firstField)
      requestAnimationFrame(() => {
        const [, label] = JSON.parse(firstField) as string[];
        const element = dialog.current?.querySelector(`[aria-label=${JSON.stringify(label)}]`);
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.focus();
      });
  };
  const close = workspace.close;

  const add = (type: DesignNode["type"]) => {
    const id = `${type}-${crypto.randomUUID().slice(0, 8)}`;
    const node: DesignNode = {
      id,
      name: type === "text" ? "Text" : type === "frame" ? "Frame" : type === "image" ? "Image" : type === "ellipse" ? "Ellipse" : "Rectangle",
      type,
      x: 32,
      y: 32,
      width: type === "text" ? 240 : 160,
      height: type === "text" ? 44 : 120,
      ...(type === "text" ? { text: "New text", fontSize: 24, fill: "#1f2937" } : { fill: "#dce6df", radius: 12 }),
      ...(type === "frame" ? { layout: "free" as const } : {}),
    };
    if (change([{ op: "insert", node }])) setSelection([id]);
  };
  const duplicate = useCallback(() => {
    const roots = selectionRoots(document, selectedIds);
    if (!roots.length) return;
    const rootIds = new Set(roots.map((node) => node.id));
    const nodes = new Map(document.nodes.map((node) => [node.id, node]));
    const descendants = new Set(rootIds);
    let added = true;
    while (added) {
      added = false;
      for (const node of document.nodes)
        if (node.parentId && descendants.has(node.parentId) && !nodes.get(node.parentId)?.componentId && !descendants.has(node.id)) {
          descendants.add(node.id);
          added = true;
        }
    }
    const ids = new Map([...descendants].map((id) => [id, `${document.nodes.find((node) => node.id === id)!.type}-${crypto.randomUUID().slice(0, 8)}`]));
    const operations = document.nodes
      .filter((node) => descendants.has(node.id))
      .map((node): DesignOperation => ({
        op: "insert",
        node: {
          ...node,
          id: ids.get(node.id)!,
          name: rootIds.has(node.id) ? `${node.name ?? node.type} copy` : node.name,
          ...(rootIds.has(node.id) ? { x: (node.x ?? 0) + 16, y: (node.y ?? 0) + 16 } : {}),
          ...(node.parentId ? { parentId: ids.get(node.parentId) ?? node.parentId } : {}),
          ...(node.componentId ? { componentId: ids.get(node.componentId) ?? node.componentId } : {}),
          ...(node.componentSourceId ? { componentSourceId: ids.get(node.componentSourceId) ?? node.componentSourceId } : {}),
        },
      }));
    if (change(operations)) setSelection(roots.map((node) => ids.get(node.id)!));
  }, [document, selectedIds, change]);
  const remove = useCallback(() => {
    const roots = selectionRoots(document, selectedIds);
    if (change(roots.map((node) => ({ op: "delete", id: node.id })))) setSelection([]);
  }, [document, selectedIds, change]);
  const move = useCallback(
    (x: number, y: number) => {
      const roots = selectionRoots(document, selectedIds);
      if (!roots.every((node) => movable(document, node))) return;
      change(roots.map((node) => ({ op: "update", id: node.id, patch: { x: rounded((node.x ?? 0) + x), y: rounded((node.y ?? 0) + y) } })));
    },
    [document, selectedIds, change],
  );
  const insertInstance = (component: DesignNode) => {
    try {
      const id = `instance-${crypto.randomUUID().slice(0, 8)}`;
      if (change(createDesignInstance(document, component.id, id, { x: (component.x ?? 0) + 24, y: (component.y ?? 0) + 24 }))) setSelection([id]);
    } catch (cause) {
      setError(designError(cause));
    }
  };
  const detach = () => {
    if (!selectedInstance) return;
    try {
      change(detachDesignInstance(document, selectedInstance.id));
    } catch (cause) {
      setError(designError(cause));
    }
  };

  useEffect(() => {
    if (!active || workspace.blocked) return;
    const keyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || window.document.documentElement.hasAttribute("data-popover-open")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (layersOpen) closeLayers();
        else close();
        return;
      }
      const typing = event.target instanceof HTMLElement && !!event.target.closest("input, textarea, [contenteditable=true]");
      if (event.target instanceof HTMLElement && event.target.closest('[role="toolbar"]') && ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !typing) {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
      if (!typing && selectedIds.length && !(event.target instanceof HTMLElement && event.target.closest("button[aria-haspopup]"))) {
        if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault();
          remove();
        } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
          event.preventDefault();
          duplicate();
        } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault();
          const step = event.shiftKey ? 10 : 1;
          move(
            event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
            event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0,
          );
        }
      }
      if (event.key === "Tab" && dialog.current) {
        const elements = [
          ...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex='0']"),
        ].filter((element) => element.getClientRects().length);
        const first = elements[0],
          last = elements.at(-1);
        if ((event.shiftKey && window.document.activeElement === first) || (!event.shiftKey && window.document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    window.addEventListener("keydown", keyDown, true);
    return () => window.removeEventListener("keydown", keyDown, true);
  }, [close, closeLayers, layersOpen, undo, redo, selectedIds, remove, duplicate, move, active, workspace.blocked]);

  useEffect(() => {
    if (!active || workspace.blocked) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data === ARTIFACT_ESCAPE) {
        dialog.current?.focus();
        if (layersOpen) closeLayers();
        else close();
        return;
      }
      if (event.data?.type !== "milagre:design-command") return;
      if (event.data.command === "delete") remove();
      else if (event.data.command === "duplicate") duplicate();
      else if (event.data.command === "undo") undo();
      else if (event.data.command === "redo") redo();
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [remove, duplicate, undo, redo, close, layersOpen, closeLayers, active, workspace.blocked]);

  const session = useRef<DesignEditorSession | null>(null);
  useLayoutEffect(() => {
    session.current = {
      id: saved.id,
      title: saved.title,
      get document() {
        return state.current.document;
      },
      saved,
      dirty,
      pending: editingField,
      saving,
      canUndo: !saving && history.past.length > 0,
      canRedo: !saving && history.future.length > 0,
      canSave: !saving && !incoming && !previewError,
      save,
      undo,
      redo,
      discard: () => {
        discardOnUnmount.current = true;
        designDraftCache.delete(cacheKey);
      },
    };
  });
  useLayoutEffect(() => workspace.register(artifact.id, session), [workspace.register, artifact.id]);
  useEffect(workspace.notify, [
    workspace.notify,
    document,
    saved,
    dirty,
    editingField,
    saving,
    history.past.length,
    history.future.length,
    incoming,
    previewError,
  ]);

  if (!enabled) return null;
  return (
    <DraftFields.Provider value={{ pending: setEditingField, fields: fieldDrafts, scope: selectedNode?.id ?? "selection" }}>
      {active &&
        workspace.tools &&
        createPortal(
          <DesignTools
            document={document}
            designs={workspace.designs}
            activeId={workspace.activeId}
            onActivate={workspace.activate}
            selectedIds={selectedIds}
            saving={saving}
            open={layersOpen}
            onToggle={() => setLayersOpen((open) => !open)}
            onClose={closeLayers}
            onSelect={selectLayer}
            onAdd={add}
            onInsertInstance={insertInstance}
          />,
          workspace.tools,
        )}
      {active &&
        workspace.notices &&
        createPortal(
          <>
            {suspendedDraft && (
              <div data-slot="design-suspended-draft" className="flex shrink-0 items-center gap-3 border-b border-line bg-accent/10 px-4 py-2 text-[12px]">
                <span className="flex-1">An unsaved draft was kept when the editor closed.</span>
                <button type="button" className={buttonClass} onClick={restoreSuspendedDraft}>
                  Restore unsaved draft
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => {
                    designDraftCache.delete(cacheKey);
                    setSuspendedDraft(undefined);
                  }}
                >
                  Discard kept draft
                </button>
              </div>
            )}
            {error && (
              <div role="alert" className="flex shrink-0 items-center gap-3 border-b border-line bg-red/10 px-4 py-2 text-[12px] text-red">
                <span className="flex-1">{error}</span>
              </div>
            )}
            {(notice || incoming || recovery) && (
              <div
                data-slot="design-version-notice"
                className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-accent/10 px-4 py-2 text-[12px]"
              >
                <span className="min-w-40 flex-1">{notice}</span>
                {incoming && !reviewing && (
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={saving}
                    onClick={() => {
                      setReviewing(true);
                      setChoices({});
                    }}
                  >
                    Review latest changes
                  </button>
                )}
                {incoming && (
                  <button type="button" className={buttonClass} disabled={saving} onClick={() => void reload()}>
                    Load latest
                  </button>
                )}
                {recovery && (
                  <button type="button" className={buttonClass} disabled={saving} onClick={restoreDraft}>
                    Restore my draft
                  </button>
                )}
              </div>
            )}
            {incoming && reviewing && merge && (
              <section data-slot="design-conflict-review" className="flex max-h-[38vh] shrink-0 flex-col border-b border-line bg-canvas px-4 py-3 text-[12px]">
                <p className="mb-2 font-medium">Review version {incoming.version}</p>
                {merge.error && (
                  <p role="alert" className="mb-2 text-red">
                    These changes cannot be combined: {merge.error}
                  </p>
                )}
                {merge.structural ? (
                  <>
                    <p className="mb-2 text-ink-2">
                      The layer structure changed. Replacing latest with your draft replaces its current contents, including the changes below. Earlier saved
                      versions remain available. Your draft and Undo history stay here until saving succeeds.
                    </p>
                    <ScrollArea as="ul" className="min-h-0 flex-1 space-y-1 text-ink-2" aria-label="Latest changes that would be replaced">
                      {latestChanges.map((description, index) => (
                        <li key={index} className="break-words">
                          {description}
                        </li>
                      ))}
                      {!latestChanges.length && <li>Your draft changes the layer structure.</li>}
                    </ScrollArea>
                    {dirty && (
                      <button
                        type="button"
                        className={`${buttonClass} mt-3 self-start border-red/40 text-red`}
                        disabled={saving}
                        onClick={() => void persist(state.current.document, incoming, true)}
                      >
                        Replace latest with my draft
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    <p className="mb-2 text-ink-2">
                      {merge.error
                        ? "Review the overlapping fields or adjust your draft before merging. Load latest keeps your current draft available to restore."
                        : merge.conflicts.length
                          ? "Choose a value for each overlapping field. Other latest changes will be kept."
                          : "Your edits affect different fields. The merge keeps both sets of changes."}
                    </p>
                    <ScrollArea className="min-h-0 flex-1" aria-label="Overlapping design fields">
                      {merge.conflicts.map((field) => (
                        <div key={field.key} className="mb-3 rounded-control border border-line p-2">
                          <p className="mb-2 font-medium">{field.label}</p>
                          <div className="grid grid-cols-2 gap-2">
                            {(["latest", "mine"] as const).map((side) => (
                              <button
                                key={side}
                                type="button"
                                aria-label={`Use ${side} for ${field.label}`}
                                aria-pressed={choices[field.key] === side}
                                className={`${buttonClass} break-words text-left ${choices[field.key] === side ? "border-accent bg-accent/10" : ""}`}
                                onClick={() => setChoices((current) => ({ ...current, [field.key]: side }))}
                              >
                                <span className="mb-1 block text-ink-3">{side === "latest" ? "Latest" : "Mine"}</span>
                                {designConflictValue(field[side])}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </ScrollArea>
                    <button
                      type="button"
                      className={`${buttonClass} mt-2 self-start`}
                      disabled={saving || !merge.document || merge.conflicts.some((field) => !choices[field.key])}
                      onClick={() => stageMerge(incoming, choices)}
                    >
                      Apply reviewed merge
                    </button>
                  </>
                )}
              </section>
            )}
          </>,
          workspace.notices,
        )}
      <section data-slot="design-page-frame" data-design-id={saved.id} className="shrink-0" style={{ width: document.width }}>
        <button
          type="button"
          aria-label={`Select design ${saved.title}`}
          onClick={() => workspace.activate(saved.id)}
          className={`mb-2 max-w-full truncate text-left text-[13px] ${active ? "text-ink" : "text-ink-3"}`}
        >
          {saved.title}
        </button>
        <div
          data-slot="design-editor-preview"
          className={`relative bg-white shadow-raised ${active ? "outline outline-1 outline-accent/40" : ""}`}
          style={{ width: document.width, height: document.height }}
        >
          {previewError ? (
            <div role="alert" data-slot="design-preview-error" className="absolute inset-0 bg-surface p-5 text-[12px] text-ink">
              <p className="font-medium">Preview unavailable</p>
              <p className="mt-2 text-ink-2">{previewError}</p>
              <p className="mt-2 text-ink-3">Your draft is still here. Edit the layers or undo the last change to restore the preview.</p>
            </div>
          ) : (
            <iframe
              ref={frame}
              title={`Editable ${saved.title}`}
              srcDoc={html}
              onLoad={syncSelection}
              sandbox="allow-scripts"
              {...{ csp: ARTIFACT_CSP }}
              referrerPolicy="no-referrer"
              className={`block size-full border-0 ${saving || workspace.blocked ? "pointer-events-none" : ""}`}
            />
          )}
        </div>
      </section>
      {active &&
        workspace.inspector &&
        createPortal(
          <ScrollArea className="min-h-0 w-full flex-1" aria-label="Layer properties">
            {selectedNode ? (
              <div className="flex flex-col gap-4 p-3" key={`${selectedNode.id}:${fieldRevision}`}>
                <div>
                  <div className="text-[12px] font-medium">{selectedNode.name ?? selectedNode.id}</div>
                  <div className="mt-0.5 text-[10px] capitalize text-ink-3">{selectedNode.type}</div>
                </div>
                <Field label="Layer name" value={selectedNode.name ?? selectedNode.id} disabled={saving} onCommit={(name) => patch({ name })} />
                {selectedInstance ? (
                  <>
                    <div className="rounded-control border border-line bg-canvas p-2 text-[11px] leading-4 text-ink-3">
                      Linked instance. Edit the main component to update every instance.
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="X" value={rounded(selectedNode.x ?? 0)} number disabled={saving} onCommit={(x) => patch({ x: Number(x) })} />
                      <Field label="Y" value={rounded(selectedNode.y ?? 0)} number disabled={saving} onCommit={(y) => patch({ y: Number(y) })} />
                    </div>
                    <div className="flex gap-2">
                      <button type="button" className={buttonClass} onClick={() => setSelection([selectedInstance.componentId!])}>
                        Edit main
                      </button>
                      <button type="button" className={buttonClass} disabled={saving} onClick={detach}>
                        Detach
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="text-[11px] text-ink-3">Width sizing</span>
                        <Select
                          label="Width sizing"
                          value={selectedNode.widthMode ?? "fixed"}
                          options={[
                            { value: "fixed", label: "Fixed" },
                            { value: "hug", label: "Hug" },
                            { value: "fill", label: "Fill" },
                          ]}
                          disabled={saving}
                          onChange={(widthMode) => patch({ widthMode })}
                          width={180}
                        />
                      </div>
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="text-[11px] text-ink-3">Height sizing</span>
                        <Select
                          label="Height sizing"
                          value={selectedNode.heightMode ?? "fixed"}
                          options={[
                            { value: "fixed", label: "Fixed" },
                            { value: "hug", label: "Hug" },
                            { value: "fill", label: "Fill" },
                          ]}
                          disabled={saving}
                          onChange={(heightMode) => patch({ heightMode })}
                          width={180}
                        />
                      </div>
                    </div>
                    {((selectedNode.widthMode && selectedNode.widthMode !== "fixed") || (selectedNode.heightMode && selectedNode.heightMode !== "fixed")) && (
                      <p className="text-[11px] leading-4 text-ink-3">Hug follows content. Fill uses available space. Width and height are fallback sizes.</p>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      {(
                        [
                          ["X", "x", selectedNode.x ?? 0],
                          ["Y", "y", selectedNode.y ?? 0],
                          ["Width", "width", selectedNode.width],
                          ["Height", "height", selectedNode.height],
                        ] as const
                      ).map(([label, key, value]) => (
                        <Field
                          key={key}
                          label={label}
                          value={rounded(value)}
                          number
                          min={key === "width" || key === "height" ? 1 : undefined}
                          disabled={saving}
                          onCommit={(next) => patch({ [key]: Number(next) })}
                        />
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Field
                        label="Min width"
                        value={selectedNode.minWidth ?? 0}
                        number
                        min={0}
                        disabled={saving}
                        onCommit={(minWidth) => patch({ minWidth: Number(minWidth) })}
                      />
                      <Field
                        label="Min height"
                        value={selectedNode.minHeight ?? 0}
                        number
                        min={0}
                        disabled={saving}
                        onCommit={(minHeight) => patch({ minHeight: Number(minHeight) })}
                      />
                    </div>
                    {selectedNode.type === "text" && (
                      <>
                        <Field label="Text" value={selectedNode.text ?? ""} multiline disabled={saving} onCommit={(text) => patch({ text })} />
                        <Field
                          label="Font family"
                          value={selectedNode.fontFamily ?? "Arial, sans-serif"}
                          disabled={saving}
                          onCommit={(fontFamily) => patch({ fontFamily })}
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <Field
                            label="Font size"
                            value={selectedNode.fontSize ?? 16}
                            number
                            min={1}
                            disabled={saving}
                            onCommit={(fontSize) => patch({ fontSize: Number(fontSize) })}
                          />
                          <Field
                            label="Font weight"
                            value={selectedNode.fontWeight ?? 400}
                            number
                            min={100}
                            max={900}
                            disabled={saving}
                            onCommit={(fontWeight) => patch({ fontWeight: Number(fontWeight) })}
                          />
                        </div>
                        <Field
                          label="Line height"
                          value={selectedNode.lineHeight ?? 1.35}
                          number
                          min={0.5}
                          max={5}
                          disabled={saving}
                          onCommit={(lineHeight) => patch({ lineHeight: Number(lineHeight) })}
                        />
                        <Select
                          label="Text alignment"
                          value={selectedNode.textAlign ?? "left"}
                          options={[
                            { value: "left", label: "Left" },
                            { value: "center", label: "Center" },
                            { value: "right", label: "Right" },
                          ]}
                          disabled={saving}
                          onChange={(textAlign) => patch({ textAlign })}
                        />
                      </>
                    )}
                    <Field
                      label={selectedNode.type === "text" ? "Text color" : "Fill"}
                      value={selectedNode.fill ?? (selectedNode.type === "text" ? "#202720" : selectedNode.type === "frame" ? "transparent" : "#d8ded8")}
                      disabled={saving}
                      onCommit={(fill) => patch({ fill })}
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <Field
                        label="Radius"
                        value={selectedNode.radius ?? 0}
                        number
                        min={0}
                        disabled={saving}
                        onCommit={(radius) => patch({ radius: Number(radius) })}
                      />
                      <Field
                        label="Opacity"
                        value={selectedNode.opacity ?? 1}
                        number
                        min={0}
                        max={1}
                        disabled={saving}
                        onCommit={(opacity) => patch({ opacity: Number(opacity) })}
                      />
                    </div>
                    <Field label="Stroke" value={selectedNode.stroke ?? "transparent"} disabled={saving} onCommit={(stroke) => patch({ stroke })} />
                    <Field
                      label="Stroke width"
                      value={selectedNode.strokeWidth ?? (selectedNode.stroke ? 1 : 0)}
                      number
                      min={0}
                      disabled={saving}
                      onCommit={(strokeWidth) => patch({ strokeWidth: Number(strokeWidth) })}
                    />
                    {selectedNode.type === "image" && (
                      <Field label="Image URL" value={selectedNode.src ?? ""} disabled={saving} onCommit={(src) => patch({ src })} />
                    )}
                    {selectedNode.type === "frame" && (
                      <>
                        <div className="border-t border-line pt-3 text-[12px] font-medium">Layout</div>
                        <Select
                          label="Layout"
                          value={selectedNode.layout ?? "free"}
                          options={[
                            { value: "free", label: "Free position" },
                            { value: "horizontal", label: "Horizontal" },
                            { value: "vertical", label: "Vertical" },
                          ]}
                          disabled={saving}
                          onChange={(layout) => patch({ layout })}
                        />
                        <div className="grid grid-cols-2 gap-2">
                          <Field label="Gap" value={selectedNode.gap ?? 0} number min={0} disabled={saving} onCommit={(gap) => patch({ gap: Number(gap) })} />
                          <Field
                            label="Padding"
                            value={selectedNode.padding ?? 0}
                            number
                            min={0}
                            disabled={saving}
                            onCommit={(padding) => patch({ padding: Number(padding) })}
                          />
                        </div>
                        <Select
                          label="Align items"
                          value={selectedNode.align ?? "start"}
                          options={[
                            { value: "start", label: "Align start" },
                            { value: "center", label: "Align center" },
                            { value: "end", label: "Align end" },
                          ]}
                          disabled={saving}
                          onChange={(align) => patch({ align })}
                        />
                        <Select
                          label="Distribute items"
                          value={selectedNode.justify ?? "start"}
                          options={[
                            { value: "start", label: "Pack start" },
                            { value: "center", label: "Pack center" },
                            { value: "end", label: "Pack end" },
                            { value: "space-between", label: "Space between" },
                          ]}
                          disabled={saving}
                          onChange={(justify) => patch({ justify })}
                        />
                      </>
                    )}
                    <div className="flex gap-2 border-t border-line pt-3">
                      <button
                        type="button"
                        className={buttonClass}
                        aria-pressed={!!selectedNode.hidden}
                        disabled={saving}
                        onClick={() => patch({ hidden: !selectedNode.hidden })}
                      >
                        {selectedNode.hidden ? "Show layer" : "Hide layer"}
                      </button>
                      <button
                        type="button"
                        className={buttonClass}
                        aria-pressed={!!selectedNode.locked}
                        disabled={saving}
                        onClick={() => patch({ locked: !selectedNode.locked })}
                      >
                        {selectedNode.locked ? "Unlock layer" : "Lock layer"}
                      </button>
                    </div>
                    {selectedNode.type === "frame" && (
                      <div className="flex flex-col gap-2 border-t border-line pt-3">
                        <div className="text-[12px] font-medium">{selectedNode.component ? "Main component" : "Component"}</div>
                        <button
                          type="button"
                          className={buttonClass}
                          disabled={saving}
                          onClick={() => (selectedNode.component ? insertInstance(selectedNode) : patch({ component: true }))}
                        >
                          {selectedNode.component ? "Create instance" : "Make component"}
                        </button>
                      </div>
                    )}
                  </>
                )}
                <div className="flex gap-2 border-t border-line pt-3">
                  <button type="button" className={buttonClass} disabled={saving} onClick={duplicate}>
                    Duplicate
                  </button>
                  <button type="button" className={`${buttonClass} text-red`} disabled={saving} onClick={remove}>
                    Delete
                  </button>
                </div>
              </div>
            ) : selectedIds.length > 1 ? (
              <div className="flex flex-col gap-4 p-3">
                <div className="text-[12px] font-medium">{selectedIds.length} layers selected</div>
                <p className="text-[11px] leading-4 text-ink-3">Drag to move them together. Arrow keys move 1 px; Shift + arrows move 10 px.</p>
                {groupPosition && (
                  <div className="grid grid-cols-2 gap-2">
                    <Field
                      label="Selection X"
                      value={rounded(groupPosition.x)}
                      number
                      disabled={saving || !canMoveSelection}
                      onCommit={(x) => move(Number(x) - groupPosition.x, 0)}
                    />
                    <Field
                      label="Selection Y"
                      value={rounded(groupPosition.y)}
                      number
                      disabled={saving || !canMoveSelection}
                      onCommit={(y) => move(0, Number(y) - groupPosition.y)}
                    />
                  </div>
                )}
                {!canMoveSelection && (
                  <p className="text-[11px] leading-4 text-ink-3">Unlock layers and select their automatic-layout frame to move this selection.</p>
                )}
                <div className="flex gap-2 border-t border-line pt-3">
                  <button type="button" className={buttonClass} disabled={saving} onClick={duplicate}>
                    Duplicate
                  </button>
                  <button type="button" className={`${buttonClass} text-red`} disabled={saving} onClick={remove}>
                    Delete
                  </button>
                </div>
              </div>
            ) : (
              <p className="p-4 text-[12px] text-ink-3">Select a layer to edit its properties. Shift-click to select more.</p>
            )}
          </ScrollArea>,
          workspace.inspector,
        )}
    </DraftFields.Provider>
  );
}
