import { ProjectGitSettings } from "../ProjectGitSettings";
import { ProjectAccountsGroup } from "../ProjectAccountsSettings";
import { SettingCheckbox } from "../primitives/Checkbox";
import { ipcErrorMessage } from "@milagre/shared/result";
import { useEffect, useRef, useState } from "react";
import type { FilesToCopy as FilesToCopyResult, WorktreeSetupSettings } from "../../electron";
import { DEFAULT_FILES_TO_COPY, parsePatterns, previewSentence } from "../../lib/files-to-copy";
import { bridgeForKey, isRemoteKey } from "../../lib/computer-bridge";
import { isRemoteScopeHidden, setRemoteScopeHidden } from "../../lib/hidden-projects";
import { Group, Row } from "./SettingsGroup";
import { WorkspaceIcon } from "../WorkspaceIcon";
import { RemoveProjectDialog } from "../RemoveProjectDialog";
import { RECENT_PROJECTS_CHANGED, projectInitial } from "../../lib/project-list";
import { setProjectImage, useProjectImages } from "../../lib/project-images";
import { thisComputer } from "../../lib/shortcut-hints";
import { SECONDARY_BUTTON, DANGER_BUTTON } from "./settings-parts";
import { MainSyncSetting } from "./MainSyncSettings";
import type { SettingsProject } from "../Settings";

// Icons are scaled down before saving: the phone gets the same image, and a full-size app icon would not fit.
async function iconDataUrl(file: File) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/png");
}

/* ─────────────────────────────────────────────────────────
 * FILES TO COPY
 * Ignored files (env files, local secrets) a new worktree gets from
 * the project's main checkout. .gitignore syntax; .worktreeinclude
 * at the repo root wins. The preview runs the same matching.
 * ───────────────────────────────────────────────────────── */
function FilesToCopy({ projectPath }: { projectPath: string }) {
  const [text, setText] = useState<string | null>(null);
  const [found, setFound] = useState<FilesToCopyResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const current = useRef("");
  const saveTimer = useRef<number | null>(null);
  const previewTimer = useRef<number | null>(null);
  const previewSeq = useRef(0);

  const flush = () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next === null) return;
    bridgeForKey(projectPath)
      .saveFilesToCopy(projectPath, parsePatterns(next))
      .then(
        () => setSaveError(null),
        (error) => setSaveError(ipcErrorMessage(error)),
      );
  };

  // The preview runs shortly after typing stops; only the latest answer is shown.
  const refreshPreview = () => {
    const seq = ++previewSeq.current;
    void bridgeForKey(projectPath)
      .previewFilesToCopy(projectPath, parsePatterns(current.current))
      .then(
        (next) => {
          // oxlint-disable-next-line promise/no-callback-in-promise -- the handler receives the resolved value, not a Node-style callback
          if (seq === previewSeq.current) setFound(next);
        },
        () => {},
      );
  };

  // .worktreeinclude can change in an editor while Settings is open.
  useEffect(() => {
    const onFocus = () => refreshPreview();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [projectPath]);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setFound(null);
    setLoadError(null);
    bridgeForKey(projectPath)
      .readFilesToCopy(projectPath)
      .then(
        (saved) => {
          if (cancelled) return;
          current.current = saved.filesToCopy.join("\n");
          setText(current.current);
          setFound(saved);
        },
        (error) => {
          if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
        },
      );
    // Leaving Settings saves what was typed last.
    return () => {
      cancelled = true;
      if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
      flush();
    };
  }, [projectPath]);

  const edit = (value: string) => {
    setText(value);
    current.current = value;
    pending.current = value;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flush, 600);
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(refreshPreview, 300);
  };

  const locked = found?.source === "worktreeinclude";
  return (
    <div className="grid gap-2 px-4 py-3">
      <label htmlFor="files-to-copy" className="grid gap-0.5">
        <span className="text-13 font-medium text-ink">Files to copy</span>
        <span className="text-12 text-ink-3">
          Git-ignored files copied from the main checkout into each new worktree, such as env files. One pattern per line, .gitignore syntax. Leave empty for{" "}
          {DEFAULT_FILES_TO_COPY}.
        </span>
      </label>
      <textarea
        id="files-to-copy"
        rows={5}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        readOnly={locked}
        disabled={text === null && !loadError}
        value={locked ? (found.worktreeInclude ?? "") : (text ?? "")}
        placeholder={DEFAULT_FILES_TO_COPY}
        onChange={(event) => edit(event.target.value)}
        className={`w-full resize-y rounded-control border border-line px-3 py-2 font-mono text-12 leading-relaxed text-ink outline-none placeholder:text-ink-3 ${locked ? "bg-field text-ink-2" : "bg-surface"}`}
      />
      {locked && (
        <p data-files-to-copy-locked className="text-12 text-ink-2">
          .worktreeinclude in the repo wins. Edit that file to change what is copied.
        </p>
      )}
      {loadError ? (
        <p className="text-12 text-red-ink">Couldn't read this project's files: {loadError}</p>
      ) : (
        <p data-files-to-copy-preview className="break-words text-12 text-ink-3">
          {found ? previewSentence(found.matches) : "Checking…"}
        </p>
      )}
      {saveError && (
        <p data-files-to-copy-error className="break-words text-12 text-red-ink">
          Couldn't save: {saveError}
        </p>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────
 * SETUP COMMAND
 * Runs once in each new worktree, before the chat's first turn
 * (npm ci, uv sync). "setup" in .milagre/worktree.json at the
 * repo root wins, like .worktreeinclude does for the files.
 * ───────────────────────────────────────────────────────── */
function SetupCommand({ projectPath }: { projectPath: string }) {
  const [text, setText] = useState<string | null>(null);
  const [resolved, setResolved] = useState<WorktreeSetupSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const saveTimer = useRef<number | null>(null);

  const flush = () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next === null) return;
    bridgeForKey(projectPath)
      .saveWorktreeSetup(projectPath, next)
      .then(
        (saved) => {
          setResolved(saved);
          setError(null);
        },
        (failure) => setError(`Couldn't save: ${ipcErrorMessage(failure)}`),
      );
  };

  // .milagre/worktree.json can change in an editor while Settings is open.
  useEffect(() => {
    const onFocus = () =>
      void bridgeForKey(projectPath)
        .readWorktreeSetup(projectPath)
        .then(setResolved, () => {});
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [projectPath]);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setResolved(null);
    setError(null);
    bridgeForKey(projectPath)
      .readWorktreeSetup(projectPath)
      .then(
        (saved) => {
          if (cancelled) return;
          setText(saved.setupCommand);
          setResolved(saved);
        },
        (failure) => {
          if (!cancelled) setError(`Couldn't read the setup command: ${ipcErrorMessage(failure)}`);
        },
      );
    // Leaving Settings saves what was typed last.
    return () => {
      cancelled = true;
      flush();
    };
  }, [projectPath]);

  const edit = (value: string) => {
    setText(value);
    pending.current = value;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flush, 600);
  };

  const locked = resolved?.source === "repo";
  return (
    <div className="grid gap-2 px-4 py-3">
      <label htmlFor="setup-command" className="grid gap-0.5">
        <span className="text-13 font-medium text-ink">Setup command</span>
        <span className="text-12 text-ink-3">Runs once in each new Worktree before the agent starts, e.g. npm ci.</span>
      </label>
      <input
        id="setup-command"
        type="text"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        readOnly={locked}
        disabled={text === null && !error}
        value={locked ? (resolved.command ?? "") : (text ?? "")}
        placeholder={locked ? "Nothing runs" : "npm ci"}
        onChange={(event) => edit(event.target.value)}
        className={`h-9 w-full rounded-control border border-line px-3 font-mono text-12 text-ink outline-none placeholder:text-ink-3 ${locked ? "bg-field text-ink-2" : "bg-surface"}`}
      />
      {locked && (
        <p data-setup-command-locked className="text-12 text-ink-2">
          .milagre/worktree.json in the repo wins. Edit its "setup" to change the command.
        </p>
      )}
      {resolved?.note && (
        <p data-setup-command-note className="break-words text-12 text-red-ink">
          {resolved.note}
        </p>
      )}
      {error && (
        <p data-setup-command-error className="break-words text-12 text-red-ink">
          {error}
        </p>
      )}
    </div>
  );
}

function ProjectIconSetting({ project }: { project: SettingsProject }) {
  const imageOf = useProjectImages([project.path]);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(icon: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    try {
      setProjectImage(project.path, await bridgeForKey(project.path).setProjectIcon(project.path, await icon()));
    } catch (failure) {
      setError(failure instanceof DOMException ? "This file isn't an image Milagre can read." : ipcErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-2 px-4 py-3">
      <div className="flex items-center gap-4">
        <span
          data-project-icon-preview
          className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-card bg-ink text-15 font-semibold text-surface"
        >
          <WorkspaceIcon src={imageOf(project.path)} fallback={projectInitial(project.name)} />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <span className="text-13 font-medium text-ink">Icon</span>
          <span className="text-12 text-ink-3">
            Shown in the sidebar, the project switcher and on your phone. Reset goes back to the repository's own icon.
          </span>
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          data-project-icon-input
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void save(() => iconDataUrl(file));
          }}
        />
        <button type="button" disabled={busy} data-project-icon-choose onClick={() => input.current?.click()} className={SECONDARY_BUTTON}>
          Choose image
        </button>
        <button type="button" disabled={busy} data-project-icon-reset onClick={() => void save(async () => null)} className={SECONDARY_BUTTON}>
          Reset
        </button>
      </div>
      {error && (
        <p data-project-icon-error className="break-words text-12 text-red-ink">
          {error}
        </p>
      )}
    </div>
  );
}

// This Mac's sidebar visibility for the Project.
function ShowInSidebarSetting({ project }: { project: SettingsProject }) {
  const remote = isRemoteKey(project.path);
  const [hidden, setHidden] = useState<boolean | null>(() => (remote ? isRemoteScopeHidden(project.path) : null));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (remote) {
      setHidden(isRemoteScopeHidden(project.path));
      return;
    }
    window.milagre.listRecentProjects().then(
      (list) => setHidden(Boolean(list.find((item) => item.path === project.path)?.hidden)),
      () => setHidden(false),
    );
  }, [project.path, remote]);
  async function change(show: boolean) {
    setError(null);
    setHidden(!show);
    if (remote) {
      setRemoteScopeHidden(project.path, !show);
      return;
    }
    try {
      const list = await window.milagre.setProjectHidden(project.path, !show);
      setHidden(Boolean(list.find((item) => item.path === project.path)?.hidden));
      window.dispatchEvent(new Event(RECENT_PROJECTS_CHANGED));
    } catch (failure) {
      setHidden(show);
      setError(ipcErrorMessage(failure));
    }
  }
  return (
    <div data-show-in-sidebar>
      <Row label="Show in sidebar" description={`In the sidebar on ${thisComputer}. Filters › Projects chooses them all at once.`}>
        <SettingCheckbox label="Show in sidebar" checked={hidden === false} onChange={(show) => void change(show)} />
      </Row>
      {error && <p className="px-4 pb-3 break-words text-12 text-red-ink">{error}</p>}
    </div>
  );
}

export function ProjectSettings({ project, onManageAccounts }: { project: SettingsProject; onManageAccounts: () => void }) {
  const [removing, setRemoving] = useState(false);
  return (
    <>
      <Group title="Appearance">
        <ProjectIconSetting project={project} />
      </Group>
      <Group title="Sidebar">
        <ShowInSidebarSetting project={project} />
      </Group>
      {/* Accounts belong to the computer that runs the Project; only that Mac chooses them. */}
      {!isRemoteKey(project.path) && <ProjectAccountsGroup projectPath={project.path} onManageAccounts={onManageAccounts} />}
      <Group title="Worktrees">
        <MainSyncSetting projectPath={project.path} />
      </Group>
      <ProjectGitSettings projectPath={project.path} />
      <Group title="New worktrees">
        <FilesToCopy projectPath={project.path} />
        <SetupCommand projectPath={project.path} />
      </Group>
      <Group title="Remove Project">
        <Row label="Remove from Projects list" description="Files, Worktrees and saved Chats stay on disk. Add the Project again to bring it back.">
          <button type="button" data-project-remove className={DANGER_BUTTON} onClick={() => setRemoving(true)}>
            Remove Project
          </button>
        </Row>
      </Group>
      {removing && <RemoveProjectDialog project={project} onClose={() => setRemoving(false)} />}
    </>
  );
}
