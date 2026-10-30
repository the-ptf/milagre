import { useEffect, useState } from "react";
import { ipcErrorMessage } from "@milagre/shared/result";
import {
  SKILL_PROVIDERS,
  SKILL_SCOPES,
  filterSkills,
  groupSkills,
  shadowedBy,
  shortenHome,
  skillBody,
  skillProviderLabel,
} from "@milagre/shared/skill-catalog";
import type { SkillScope } from "@milagre/shared/skill-catalog";
import type { ShadowedSkill, SkillOption } from "../model";
import { useSkills } from "./useSkills";
import { useEditors } from "../lib/editors";
import { getSettings } from "../lib/settings";
import { showNotice } from "../lib/notice";
import { Select } from "./primitives/Select";
import { Markdown } from "./markdown/Markdown";
import { bridgeForKey, isRemoteKey } from "../lib/computer-bridge";
import { Button } from "./primitives/Button";
import { EmptyState } from "./primitives/EmptyState";
import { FIELD } from "./primitives/Field";
import { InlineError } from "./primitives/InlineError";
import { SectionLabel } from "./primitives/SectionLabel";
import Tooltip from "./primitives/Tooltip";

const badge = "shrink-0 rounded-full bg-field px-2 py-px text-11 font-medium text-ink-2";
const scopeLabel = (scope: SkillScope) => SKILL_SCOPES.find((item) => item.scope === scope)?.label ?? scope;
const others = (count: number) => `Overrides ${count} other${count === 1 ? "" : "s"}`;

/* ─────────────────────────────────────────────────────────
 * SKILLS
 * Every skill the `/` menu offers for the open Project, where
 * each comes from, which same-named ones it hides, and what
 * discovery could not read. Read from disk on open and Reload.
 * ───────────────────────────────────────────────────────── */
export function SkillsSettings({ projectPath }: { projectPath: string }) {
  const [revision, setRevision] = useState(0);
  const { skills, shadowed, warnings, loading } = useSkills(projectPath, true, revision);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SkillScope | "all">("all");
  const [provider, setProvider] = useState("all");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const selected = skills.find((skill) => skill.path === selectedPath);
  if (selected)
    return (
      <SkillDetail
        projectPath={projectPath}
        skill={selected}
        hidden={shadowedBy(shadowed, selected)}
        revision={revision}
        onBack={() => setSelectedPath(null)}
      />
    );

  const groups = groupSkills(filterSkills(skills, { query, scope, provider }));
  return (
    <div className="mt-6 grid gap-5" data-skills-settings>
      <div className="flex items-start justify-between gap-6">
        <p className="max-w-[430px] text-13 text-ink-3">
          Skills from this Project and your home folder. When two share a name, the first one found wins and the / menu offers only that one.
        </p>
        <Button variant="secondary" size={28} disabled={loading} onClick={() => setRevision((value) => value + 1)}>
          {loading ? "Reloading…" : "Reload"}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="search"
          aria-label="Search skills"
          placeholder="Search skills"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          spellCheck={false}
          className={`${FIELD} min-w-0 flex-1`}
        />
        <Select<SkillScope | "all">
          label="Scope"
          width={160}
          value={scope}
          onChange={setScope}
          options={[{ value: "all", label: "All scopes" }, ...SKILL_SCOPES.map((item) => ({ value: item.scope, label: item.label }))]}
        />
        <Select
          label="Source"
          width={160}
          value={provider}
          onChange={setProvider}
          options={[{ value: "all", label: "All sources" }, ...SKILL_PROVIDERS.map((item) => ({ value: item.provider, label: item.label }))]}
        />
      </div>
      {groups.map((group) => (
        <section key={group.scope} data-skill-group={group.scope}>
          <SectionLabel className="mb-2 px-1">
            {group.label} · {group.skills.length}
          </SectionLabel>
          <ul className="divide-y divide-line overflow-hidden rounded-card bg-surface shadow-card">
            {group.skills.map((skill) => (
              <SkillRow key={skill.path} skill={skill} hidden={shadowedBy(shadowed, skill).length} onOpen={() => setSelectedPath(skill.path)} />
            ))}
          </ul>
        </section>
      ))}
      {!groups.length && !loading && (
        <EmptyState
          size="compact"
          title={
            <>
              No skills found. Create one in <code className="font-mono">.claude/skills/&lt;name&gt;/SKILL.md</code>.
            </>
          }
        />
      )}
      {warnings.length > 0 && (
        <section data-skill-warnings>
          <SectionLabel className="mb-2 px-1">Warnings · {warnings.length}</SectionLabel>
          <ul className="divide-y divide-line overflow-hidden rounded-card bg-surface shadow-card">
            {warnings.map((warning) => (
              <li key={warning} className="break-words px-4 py-2 text-12 text-ink-2 [overflow-wrap:anywhere]">
                {shortenHome(warning)}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function SkillRow({ skill, hidden, onOpen }: { skill: SkillOption; hidden: number; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="grid w-full gap-0.5 px-4 py-2 text-left transition-colors hover:bg-hover focus-visible:-outline-offset-2 active:bg-hover-2"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-13 font-medium text-ink">/{skill.name}</span>
          <span className={badge}>{skillProviderLabel(skill.provider)}</span>
          {hidden > 0 && <span className="shrink-0 text-11 text-orange-ink">{others(hidden)}</span>}
        </span>
        <span title={skill.description} className="truncate text-12 text-ink-2">
          {skill.description}
        </span>
        {skill.path && <span className="truncate font-mono text-11 text-ink-3">{shortenHome(skill.path)}</span>}
      </button>
    </li>
  );
}

function SkillDetail({
  projectPath,
  skill,
  hidden,
  revision,
  onBack,
}: {
  projectPath: string;
  skill: SkillOption;
  hidden: ShadowedSkill[];
  revision: number;
  onBack: () => void;
}) {
  const { editor } = useEditors();
  const [content, setContent] = useState<{ text: string } | { error: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    bridgeForKey(projectPath)
      .readSkill(projectPath, skill.path)
      .then(
        (text) => {
          if (!cancelled) setContent({ text });
        },
        (error: unknown) => {
          if (!cancelled) setContent({ error: ipcErrorMessage(error) });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [projectPath, skill.path, revision]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const open = async () => {
    try {
      const result = await window.milagre.openSkill({ projectPath, file: skill.path, editor: getSettings().editorId || undefined });
      if (!result.ok) showNotice(result.error.message);
    } catch (error) {
      showNotice(ipcErrorMessage(error));
    }
  };
  const reveal = () => void window.milagre.revealSkill(projectPath, skill.path).catch((error: unknown) => showNotice(ipcErrorMessage(error)));
  const copy = () =>
    void navigator.clipboard.writeText(`/${skill.name}`).then(
      () => setCopied(true),
      () => {},
    );

  return (
    <div className="mt-6 grid gap-5" data-skill-detail>
      <div>
        <Button variant="secondary" size={28} onClick={onBack}>
          All skills
        </Button>
      </div>
      <section className="grid gap-3 rounded-card bg-surface p-4 shadow-card">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-15 font-semibold text-ink">/{skill.name}</h2>
          <span className={badge}>{skillProviderLabel(skill.provider)}</span>
          <span className={badge}>{scopeLabel(skill.scope)}</span>
        </div>
        <p className="text-13 text-ink-2">{skill.description}</p>
        {skill.path && <p className="break-all font-mono text-11 text-ink-3">{shortenHome(skill.path)}</p>}
        <div className="flex flex-wrap gap-2">
          {skill.path &&
            !isRemoteKey(projectPath) &&
            (editor ? (
              <Button variant="secondary" size={28} onClick={() => void open()}>
                Open in {editor.name}
              </Button>
            ) : (
              // aria-disabled, so the Tooltip saying why stays reachable.
              <Tooltip label="Install Cursor, VS Code, Zed or another editor" asChild>
                <Button variant="secondary" size={28} aria-disabled>
                  Open in editor
                </Button>
              </Tooltip>
            ))}
          {skill.path && !isRemoteKey(projectPath) && (
            <Button variant="secondary" size={28} onClick={reveal}>
              Show in Finder
            </Button>
          )}
          <Button variant="secondary" size={28} onClick={copy}>
            {copied ? "Copied" : `Copy /${skill.name}`}
          </Button>
        </div>
      </section>
      {hidden.length > 0 && (
        <section data-skill-shadowed>
          <SectionLabel className="mb-2 px-1">{others(hidden.length)}</SectionLabel>
          <ul className="divide-y divide-line overflow-hidden rounded-card bg-surface shadow-card">
            {hidden.map((item) => (
              <li key={item.path} className="grid gap-0.5 px-4 py-2">
                <span className="flex items-center gap-2 text-12 text-ink-2">
                  <span className={badge}>{skillProviderLabel(item.provider)}</span>
                  {scopeLabel(item.scope)}
                </span>
                <span className="break-all font-mono text-11 text-ink-3">{shortenHome(item.path)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="rounded-card bg-surface px-5 py-4 text-13 leading-5 text-ink shadow-card">
        {!content ? (
          <p role="status" className="text-ink-3">
            Reading SKILL.md…
          </p>
        ) : "error" in content ? (
          <InlineError>Couldn't read this skill: {content.error}</InlineError>
        ) : (
          <Markdown text={skillBody(content.text)} />
        )}
      </section>
    </div>
  );
}
