import { useEffect, useRef, useState } from "react";
import { Add01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { VALIDATION_COPY, VALIDATION_LIMITS, type ValidationCommand, type ValidationSettings } from "@milagre/shared/validation";
import { ipcErrorMessage } from "@milagre/shared/result";
import { bridgeForKey } from "../../lib/computer-bridge";
import { Button, IconButton } from "../primitives/Button";
import { SettingCheckbox } from "../primitives/Checkbox";
import { Input } from "../primitives/Field";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { Group, Row } from "./SettingsGroup";

const COLUMNS = "grid grid-cols-[132px_minmax(0,1fr)_120px_24px] items-center gap-2";
const EMPTY: ValidationCommand = { name: "", command: "", cwd: "" };

/** Settings › Project › Validation: the commands Milagre runs to prove a task's code, saved as you type. */
export function ProjectValidationSettings({ projectPath }: { projectPath: string }) {
  const [draft, setDraft] = useState<ValidationSettings | null>(null);
  const [error, setError] = useState("");
  const pending = useRef<ValidationSettings | null>(null);
  const timer = useRef<number | null>(null);

  function flush() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    void bridgeForKey(projectPath)
      .validation.save(projectPath, next)
      .then(
        () => setError(""),
        (failure) => setError(`Couldn't save: ${ipcErrorMessage(failure)}`),
      );
  }

  useEffect(() => {
    let live = true;
    setDraft(null);
    setError("");
    bridgeForKey(projectPath)
      .validation.read(projectPath)
      .then(
        (value) => live && setDraft({ ...value, commands: value.commands.length ? value.commands : [EMPTY] }),
        (failure) => live && setError(`Couldn't read validation commands: ${ipcErrorMessage(failure)}`),
      );
    return () => {
      live = false;
      flush();
    };
  }, [projectPath]);

  function change(next: ValidationSettings, now = false) {
    setDraft(next);
    pending.current = next;
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (now) flush();
    else timer.current = window.setTimeout(flush, 600);
  }
  const edit = (index: number, patch: Partial<ValidationCommand>) =>
    draft && change({ ...draft, commands: draft.commands.map((item, at) => (at === index ? { ...item, ...patch } : item)) });
  const remove = (index: number) => {
    if (!draft) return;
    const commands = draft.commands.filter((_, at) => at !== index);
    change({ ...draft, commands: commands.length ? commands : [EMPTY] }, true);
  };

  return (
    <Group title={VALIDATION_COPY.title}>
      <div data-settings-row data-project-validation className="grid gap-2 px-4 py-3">
        <div className="grid gap-0.5">
          <span className="text-13 font-medium text-ink">{VALIDATION_COPY.commands.label}</span>
          <span className="text-12 text-ink-3">{VALIDATION_COPY.commands.description}</span>
        </div>
        {draft && (
          <>
            <div className={`${COLUMNS} text-11 text-ink-3`}>
              <span>{VALIDATION_COPY.name.label}</span>
              <span>{VALIDATION_COPY.command.label}</span>
              <span>{VALIDATION_COPY.cwd.label}</span>
              <span />
            </div>
            {draft.commands.map((item, index) => (
              <div key={index} data-validation-command className={COLUMNS}>
                <Input
                  size={32}
                  aria-label={`${VALIDATION_COPY.name.label} ${index + 1}`}
                  maxLength={VALIDATION_LIMITS.name}
                  placeholder={VALIDATION_COPY.name.placeholder}
                  value={item.name}
                  onChange={(event) => edit(index, { name: event.target.value })}
                />
                <Input
                  size={32}
                  aria-label={`${VALIDATION_COPY.command.label} ${index + 1}`}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  maxLength={VALIDATION_LIMITS.command}
                  placeholder={VALIDATION_COPY.command.placeholder}
                  value={item.command}
                  onChange={(event) => edit(index, { command: event.target.value })}
                  className="font-mono text-12"
                />
                <Input
                  size={32}
                  aria-label={`${VALIDATION_COPY.cwd.label} ${index + 1}`}
                  spellCheck={false}
                  maxLength={VALIDATION_LIMITS.cwd}
                  placeholder={VALIDATION_COPY.cwd.placeholder}
                  value={item.cwd}
                  onChange={(event) => edit(index, { cwd: event.target.value })}
                  className="font-mono text-12"
                />
                <IconButton label="Remove command" icon={Cancel01Icon} size={24} onClick={() => remove(index)} />
              </div>
            ))}
            {draft.commands.length < VALIDATION_LIMITS.commands && (
              <div>
                <Button variant="quiet" size={28} className="-ml-2" onClick={() => change({ ...draft, commands: [...draft.commands, EMPTY] }, true)}>
                  <Icon icon={Add01Icon} size={14} />
                  {VALIDATION_COPY.add}
                </Button>
              </div>
            )}
          </>
        )}
        {error && <InlineError size={12}>{error}</InlineError>}
      </div>
      <Row label={VALIDATION_COPY.afterTask.label} description={VALIDATION_COPY.afterTask.description}>
        <SettingCheckbox
          label={VALIDATION_COPY.afterTask.label}
          checked={draft?.afterTask ?? true}
          disabled={!draft}
          onChange={(afterTask) => draft && change({ ...draft, afterTask }, true)}
        />
      </Row>
    </Group>
  );
}
