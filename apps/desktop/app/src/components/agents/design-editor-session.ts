import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Artifact } from "@milagre/shared/artifact";
import type { DesignDocument } from "@milagre/shared/design";

export interface DesignEditorSession {
  id: string;
  title: string;
  document: DesignDocument;
  saved: Artifact;
  dirty: boolean;
  pending: boolean;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canSave: boolean;
  save: () => Promise<boolean>;
  undo: () => void;
  redo: () => void;
  discard: () => void;
}

/** Shared page chrome; each artboard retains its own draft and version-conflict handling. */
export interface DesignEditorWorkspace {
  activeId: string;
  designs: { id: string; title: string; document: DesignDocument }[];
  layersOpen: boolean;
  setLayersOpen: Dispatch<SetStateAction<boolean>>;
  blocked: boolean;
  scale: number;
  root: HTMLElement | null;
  inspector: HTMLElement | null;
  notices: HTMLElement | null;
  tools: HTMLElement | null;
  activate: (id: string) => void;
  register: (id: string, session: RefObject<DesignEditorSession | null>) => () => void;
  notify: () => void;
  close: () => void;
}
