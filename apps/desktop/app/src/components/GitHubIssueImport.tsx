import { ipcErrorMessage } from "@milagre/shared/result";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CoordinatorState } from "@milagre/shared/model";
import type { GitHubIssue, GitHubImportResult, GitHubImportRequest } from "@milagre/shared/github-issue";
import { githubImportTargets, useGitHubIssue } from "@milagre/shared/use-github-issue";
import { bridgeForKey } from "../lib/computer-bridge";
import { Dialog } from "./primitives/Dialog";
import { Button } from "./primitives/Button";
import { Select } from "./primitives/Select";
import { InlineError } from "./primitives/InlineError";

export function GitHubIssueImport({
  project,
  computer,
  baseBranch,
  sessionId,
  options,
  note,
  onClose,
  onImported,
}: {
  project: { path: string; name: string; state: CoordinatorState };
  computer: string;
  baseBranch: string;
  sessionId?: number;
  options: GitHubImportRequest["options"];
  note: string;
  onClose: () => void;
  onImported: (result: GitHubImportResult) => void;
}) {
  const api = useMemo(
    () => ({
      list: () => bridgeForKey(project.path).listGitHubIssues(project.path),
      read: (url: string) => bridgeForKey(project.path).readGitHubIssue(project.path, url),
    }),
    [project.path],
  );
  const form = useGitHubIssue(api);
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState(sessionId ? `existing:${sessionId}` : "worktree");
  const [base, setBase] = useState(baseBranch);
  const [messageId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const importing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const life = mounted;
    return () => {
      life.current = false;
    };
  }, []);
  const [error, setError] = useState("");
  const targets = githubImportTargets(project.state);
  async function confirm(issue: GitHubIssue) {
    if (importing.current) return;
    importing.current = true;
    setBusy(true);
    setError("");
    try {
      const selected = target === "worktree" ? { kind: "worktree" as const, baseBranch: base } : targets.find((item) => item.value === target)?.target;
      if (!selected) throw new Error("Choose an available target.");
      const result = await bridgeForKey(project.path).importGitHubIssue({
        projectPath: project.path,
        url: issue.url,
        account: issue.account,
        target: selected,
        options: { ...options, clientMessageId: messageId },
        note,
      });
      if (mounted.current) onImported(result);
    } catch (failure) {
      if (mounted.current) setError(ipcErrorMessage(failure));
    } finally {
      importing.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Dialog
      title="Import GitHub issue"
      description={`${project.name} on ${computer}`}
      width={560}
      onClose={busy ? undefined : onClose}
      actions={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!form.issue || busy || form.loading || (target === "worktree" && !base.trim())}
            onClick={() => form.issue && void confirm(form.issue)}
          >
            {busy ? "Importing..." : "Import and start Chat"}
          </Button>
        </>
      }
    >
      <p className="mt-3 break-all text-12 text-ink-3">Project: {project.path}</p>
      <label className="mt-4 block text-13">
        GitHub issue URL
        <input
          aria-label="GitHub issue URL"
          className="mt-1 w-full rounded-control border border-line bg-field px-3 py-2"
          value={url}
          disabled={busy}
          onChange={(event) => {
            setUrl(event.target.value);
            form.invalidate();
            setError("");
          }}
          placeholder="https://github.com/owner/repository/issues/123"
        />
      </label>
      <Button variant="ghost" disabled={busy || form.loading || !url.trim()} onClick={() => void form.preview(url)}>
        Preview URL
      </Button>
      <Select
        label="Select an open GitHub issue"
        value={form.issue?.url ?? ""}
        disabled={busy || form.loading}
        searchable
        width={500}
        options={[
          { value: "", label: "Select an open GitHub issue", disabled: true },
          ...(form.list?.issues ?? []).map((issue) => ({ value: issue.url, label: `${issue.repository}#${issue.number}: ${issue.title}` })),
        ]}
        onChange={(selectedUrl) => {
          setUrl(selectedUrl);
          void form.preview(selectedUrl);
        }}
      />
      {form.loading && (
        <p role="status" className="mt-3 text-13 text-ink-3">
          Reading GitHub...
        </p>
      )}
      {!form.loading && form.list && !form.list.issues.length && (
        <p className="mt-3 text-13 text-ink-3">No open issues in this Project. You can paste an issue URL.</p>
      )}
      {form.issue && (
        <div className="mt-4 space-y-2 rounded-card border border-line p-3" data-slot="github-issue-preview">
          <h3 className="text-15 font-semibold">{form.issue.title}</h3>
          <a className="break-all text-13 underline" href={form.issue.url} target="_blank" rel="noreferrer">
            {form.issue.repository}#{form.issue.number}
          </a>
          <p className="text-12 text-ink-3">
            Account: {form.issue.account}. Imported: {new Date(form.issue.importedAt).toLocaleString()}
          </p>
          <p className="whitespace-pre-wrap break-words text-13">{form.issue.body || "No description."}</p>
        </div>
      )}
      <div className="mt-4">
        <Select
          label="Chat and Worktree target"
          value={target}
          disabled={busy}
          searchable
          options={[{ value: "worktree", label: "New Chat in a new Worktree" }, ...targets]}
          onChange={setTarget}
        />
      </div>
      {target === "worktree" && (
        <label className="mt-3 block text-13">
          Base branch
          <input
            aria-label="Base branch"
            className="mt-1 w-full rounded-control border border-line bg-field px-3 py-2"
            disabled={busy}
            value={base}
            onChange={(event) => setBase(event.target.value)}
          />
        </label>
      )}
      {note.trim() && <p className="mt-3 whitespace-pre-wrap text-13">Your message: {note}</p>}
      <InlineError className="mt-3">{error || form.error}</InlineError>
    </Dialog>
  );
}
