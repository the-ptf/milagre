import { useEffect, useRef, useState } from "react";
import {
  BRANCH_COPY,
  BRANCH_TOKENS,
  branchPolicyCheck,
  branchPolicyOverrides,
  type BranchPolicy,
  type BranchPolicySettings,
} from "@milagre/shared/branch-policy";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeForKey } from "../lib/computer-bridge";
import { Group, Row } from "./settings/SettingsGroup";
import { Input, FIELD_AREA } from "./primitives/Field";
import { SettingCheckbox } from "./primitives/Checkbox";
import { Button } from "./primitives/Button";
import { InlineError } from "./primitives/InlineError";

const MONO = "font-mono text-12 read-only:text-ink-2";

/** Adds `{token}` at the caret, with a dash before it when it would run into the previous part. */
function insertToken(value: string, token: string, at: number) {
  const before = value.slice(0, at);
  const glue = before && !/[-/_]$/.test(before) ? "-" : "";
  return { value: `${before}${glue}{${token}}${value.slice(at)}`, caret: at + glue.length + token.length + 2 };
}

/**
 * Settings › Project › Branches. Saves as you type, like the other Project settings; a field set in
 * .milagre/worktree.json is read-only here.
 */
export function ProjectGitSettings({ projectPath }: { projectPath: string }) {
  const [saved, setSaved] = useState<BranchPolicySettings | null>(null);
  const [draft, setDraft] = useState<BranchPolicy | null>(null);
  const [error, setError] = useState("");
  const pending = useRef<BranchPolicy | null>(null);
  const timer = useRef<number | null>(null);
  const savedRef = useRef<BranchPolicySettings | null>(null);
  const template = useRef<HTMLInputElement>(null);

  function persist(local: Partial<BranchPolicy>, adopt: boolean) {
    return bridgeForKey(projectPath)
      .saveProjectGit(projectPath, local)
      .then(
        (value) => {
          savedRef.current = value;
          setSaved(value);
          if (adopt) setDraft(value.effective);
          setError("");
        },
        (failure) => setError(`Couldn't save: ${ipcErrorMessage(failure)}`),
      );
  }
  function flush() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next && savedRef.current) void persist(branchPolicyOverrides(savedRef.current, next), false);
  }

  useEffect(() => {
    let live = true;
    setSaved(null);
    setDraft(null);
    setError("");
    Promise.resolve()
      .then(() => bridgeForKey(projectPath).readProjectGit(projectPath))
      .then(
        (value) => {
          if (!live || !value) return;
          savedRef.current = value;
          setSaved(value);
          setDraft(value.effective);
        },
        (failure) => live && setError(`Couldn't read branch settings: ${ipcErrorMessage(failure)}`),
      );
    // Leaving Settings saves what was typed last.
    return () => {
      live = false;
      flush();
    };
  }, [projectPath]);

  if (!draft || !saved)
    return (
      <Group title={BRANCH_COPY.title}>
        <div className="px-4 py-3 text-12 text-ink-3">{error ? <InlineError size={12}>{error}</InlineError> : "Loading…"}</div>
      </Group>
    );

  const check = branchPolicyCheck(draft);
  const fromRepo = (field: keyof BranchPolicy) => Object.hasOwn(saved.repository, field);
  const describe = (field: keyof BranchPolicy) => (fromRepo(field) ? BRANCH_COPY.repository : BRANCH_COPY[field].description);
  function edit(patch: Partial<BranchPolicy>, now = false) {
    const next = { ...draft!, ...patch };
    setDraft(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    // An invalid template or base branch waits until it's fixed.
    const problems = branchPolicyCheck(next);
    if (problems.template || problems.baseBranch) {
      pending.current = null;
      return;
    }
    pending.current = next;
    if (now) flush();
    else timer.current = window.setTimeout(flush, 600);
  }
  function addToken(token: string) {
    const input = template.current;
    const at = input?.selectionStart ?? draft!.template.length;
    const { value, caret } = insertToken(draft!.template, token, at);
    edit({ template: value });
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(caret, caret);
    });
  }
  const textField = (field: "username" | "baseBranch") => (
    <Input
      size={32}
      aria-label={BRANCH_COPY[field].label}
      aria-invalid={field === "baseBranch" && !!check.baseBranch}
      className={`w-60 ${MONO}`}
      spellCheck={false}
      readOnly={fromRepo(field)}
      value={draft[field]}
      placeholder={BRANCH_COPY[field].placeholder}
      onChange={(event) => edit({ [field]: event.target.value })}
    />
  );
  const hasOverrides = Object.keys(saved.local).length > 0;

  return (
    <Group
      title={BRANCH_COPY.title}
      footer={BRANCH_COPY.footer}
      action={
        hasOverrides && (
          <Button
            variant="link"
            size={24}
            className="-mr-2"
            data-branch-reset
            onClick={() => {
              pending.current = null;
              void persist({}, true);
            }}
          >
            {BRANCH_COPY.reset}
          </Button>
        )
      }
    >
      <div className="grid gap-2 px-4 py-3" data-project-git>
        <label htmlFor="branch-template" className="grid gap-0.5">
          <span className="text-13 font-medium text-ink">{BRANCH_COPY.template.label}</span>
          <span className="text-12 text-ink-3">{describe("template")}</span>
        </label>
        <Input
          ref={template}
          id="branch-template"
          aria-invalid={!!check.template}
          className={MONO}
          spellCheck={false}
          readOnly={fromRepo("template")}
          value={draft.template}
          placeholder={BRANCH_COPY.template.placeholder}
          onChange={(event) => edit({ template: event.target.value })}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {!fromRepo("template") && (
            <div className="flex gap-1">
              {BRANCH_TOKENS.map((token) => (
                <button
                  key={token}
                  type="button"
                  data-branch-token={token}
                  onClick={() => addToken(token)}
                  className="h-6 rounded-chip bg-field px-2 font-mono text-11 text-ink-2 transition-colors hover:bg-hover"
                >
                  {`{${token}}`}
                </button>
              ))}
            </div>
          )}
          {check.template ? (
            <InlineError size={12}>{check.template}</InlineError>
          ) : (
            <p className="flex min-w-0 items-baseline gap-2 text-12">
              <span className="text-ink-3">{BRANCH_COPY.example}</span>
              <code data-branch-preview className="font-mono break-all text-ink">
                {check.preview}
              </code>
            </p>
          )}
        </div>
      </div>
      <Row label={BRANCH_COPY.username.label} description={describe("username")}>
        {textField("username")}
      </Row>
      <Row label={BRANCH_COPY.dashesOnly.label} description={describe("dashesOnly")}>
        <SettingCheckbox
          label={BRANCH_COPY.dashesOnly.label}
          checked={draft.dashesOnly}
          disabled={fromRepo("dashesOnly")}
          onChange={(dashesOnly) => edit({ dashesOnly }, true)}
        />
      </Row>
      <div>
        <Row label={BRANCH_COPY.baseBranch.label} description={describe("baseBranch")}>
          {textField("baseBranch")}
        </Row>
        {check.baseBranch && (
          <div className="-mt-1 px-4 pb-3">
            <InlineError size={12}>{check.baseBranch}</InlineError>
          </div>
        )}
      </div>
      <Row label={BRANCH_COPY.trackBase.label} description={describe("trackBase")}>
        <SettingCheckbox
          label={BRANCH_COPY.trackBase.label}
          checked={draft.trackBase}
          disabled={fromRepo("trackBase")}
          onChange={(trackBase) => edit({ trackBase }, true)}
        />
      </Row>
      <div className="grid gap-2 px-4 py-3">
        <label htmlFor="branch-instructions" className="grid gap-0.5">
          <span className="text-13 font-medium text-ink">{BRANCH_COPY.instructions.label}</span>
          <span className="text-12 text-ink-3">{describe("instructions")}</span>
        </label>
        <textarea
          id="branch-instructions"
          rows={3}
          className={`${FIELD_AREA} resize-y read-only:text-ink-2`}
          readOnly={fromRepo("instructions")}
          value={draft.instructions}
          placeholder={BRANCH_COPY.instructions.placeholder}
          onChange={(event) => edit({ instructions: event.target.value })}
        />
      </div>
      {error && (
        <div className="px-4 py-3">
          <InlineError size={12}>{error}</InlineError>
        </div>
      )}
    </Group>
  );
}
