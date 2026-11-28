import { useId, useRef, useState, type ReactNode } from "react";
import { File01Icon, ViewIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import { SECRETS_COPY, type SecretSummary } from "@milagre/shared/secrets";
import { Button, IconButton } from "../primitives/Button";
import { Checkbox } from "../primitives/Checkbox";
import { FIELD_AREA, FIELD_LABEL } from "../primitives/Field";
import { Icon } from "../primitives/Icon";
import { InlineError } from "../primitives/InlineError";
import { RadioGroup, RadioGroupItem } from "../primitives/RadioGroup";
import { ScrollArea } from "../primitives/ScrollArea";
import { Segmented } from "../primitives/Segmented";

export type SecretScope = "all" | string[];
/** A Project the scope list offers: its normalized origin and the name it has here. */
export type ScopeChoice = { origin: string; name: string };
export type SecretOptIns = Pick<SecretSummary, "askEachUse" | "unattended"> & { ambient: boolean };
/** A value typed in, or a file on this computer picked by its absolute path. */
export type SecretSource = { mode: "value"; value: string } | { mode: "file"; path: string; fileName: string };

export const EMPTY_SOURCE: SecretSource = { mode: "value", value: "" };

export function sourceReady(source: SecretSource): boolean {
  return source.mode === "value" ? source.value.length > 0 : source.path.length > 0;
}

export function scopeReady(scope: SecretScope): boolean {
  return scope === "all" || scope.length > 0;
}

export function FieldBlock({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      {htmlFor ? (
        <label htmlFor={htmlFor} className={FIELD_LABEL}>
          {label}
        </label>
      ) : (
        <span className={FIELD_LABEL}>{label}</span>
      )}
      {children}
    </div>
  );
}

/** A hidden file input behind a button; hands back the picked file's absolute path on this computer. */
export function useFilePicker(onPick: (path: string, fileName: string) => void) {
  const input = useRef<HTMLInputElement>(null);
  const element = (
    <input
      ref={input}
      type="file"
      hidden
      data-secret-file-input
      onChange={(event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        const path = window.milagre.getPathForFile(file);
        if (path) onPick(path, file.name);
      }}
    />
  );
  return { element, open: () => input.current?.click() };
}

/** The value, masked while typed (several lines allowed), or a file to read it from. */
export function SourceField({ source, onChange, allowFile = true }: { source: SecretSource; onChange: (source: SecretSource) => void; allowFile?: boolean }) {
  const id = useId();
  const [revealed, setRevealed] = useState(false);
  const picker = useFilePicker((path, fileName) => onChange({ mode: "file", path, fileName }));
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={source.mode === "value" ? id : undefined} className={FIELD_LABEL}>
          {source.mode === "value" ? SECRETS_COPY.value : SECRETS_COPY.file}
        </label>
        {allowFile && (
          <Segmented<SecretSource["mode"]>
            label={`${SECRETS_COPY.value} or ${SECRETS_COPY.file}`}
            value={source.mode}
            onChange={(mode) => {
              setRevealed(false);
              onChange(mode === "value" ? EMPTY_SOURCE : { mode: "file", path: "", fileName: "" });
            }}
            options={[
              { value: "value", label: SECRETS_COPY.value },
              { value: "file", label: SECRETS_COPY.file },
            ]}
          />
        )}
      </div>
      {source.mode === "value" ? (
        <div className="relative">
          <textarea
            id={id}
            data-secret-value
            rows={3}
            value={source.value}
            placeholder={SECRETS_COPY.valuePlaceholder}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => onChange({ mode: "value", value: event.target.value })}
            onBlur={() => setRevealed(false)}
            className={`${FIELD_AREA} block resize-none pr-10 font-mono outline-none ${revealed ? "" : "[-webkit-text-security:disc]"}`}
          />
          <span className="absolute top-1 right-1 flex">
            <IconButton
              label={revealed ? "Hide secret" : "Show secret"}
              icon={revealed ? ViewOffIcon : ViewIcon}
              aria-pressed={revealed}
              disabled={!source.value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setRevealed((current) => !current)}
            />
          </span>
        </div>
      ) : (
        <div className="flex min-h-9 items-center gap-2.5">
          <Button variant="secondary" data-secret-choose-file onClick={picker.open}>
            {SECRETS_COPY.chooseFile}
          </Button>
          {source.fileName && (
            <span className="flex min-w-0 items-center gap-1.5 text-13 text-ink-2">
              <Icon icon={File01Icon} size={14} className="shrink-0 text-ink-3" />
              <span className="truncate font-mono text-12">{source.fileName}</span>
            </span>
          )}
        </div>
      )}
      {picker.element}
    </div>
  );
}

/** All Projects, or a checked list of the Projects with a Git origin; origins already in scope stay listed. */
export function ScopeField({ scope, onChange, choices }: { scope: SecretScope; onChange: (scope: SecretScope) => void; choices: ScopeChoice[] }) {
  const chosen = scope === "all" ? [] : scope;
  const listed = [...choices, ...chosen.filter((origin) => !choices.some((choice) => choice.origin === origin)).map((origin) => ({ origin, name: origin }))];
  const [lastChosen, setLastChosen] = useState<string[]>(chosen);
  return (
    <fieldset className="grid gap-2">
      <legend className={`${FIELD_LABEL} mb-1.5`}>{SECRETS_COPY.projects}</legend>
      <RadioGroup
        value={scope === "all" ? "all" : "chosen"}
        onValueChange={(value) => onChange(value === "all" ? "all" : lastChosen)}
        className="gap-2"
        aria-label={SECRETS_COPY.projects}
      >
        <label className="flex items-center gap-2.5 text-13 text-ink">
          <RadioGroupItem value="all" data-secret-scope="all" />
          {SECRETS_COPY.allProjects}
        </label>
        <label className="flex items-center gap-2.5 text-13 text-ink">
          <RadioGroupItem value="chosen" data-secret-scope="chosen" disabled={listed.length === 0} />
          {SECRETS_COPY.chosenProjects}
        </label>
      </RadioGroup>
      {scope !== "all" && (
        <div className="grid gap-1.5 pl-6.5">
          <ScrollArea as="ul" chainScroll className="max-h-44 rounded-control border border-line">
            {listed.map((choice) => {
              const checked = chosen.includes(choice.origin);
              return (
                <li key={choice.origin}>
                  <label data-secret-project={choice.origin} className="flex min-h-10 items-center gap-2.5 px-3 py-1.5 hover:bg-hover">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(on) => {
                        const next = on ? [...chosen, choice.origin] : chosen.filter((origin) => origin !== choice.origin);
                        setLastChosen(next);
                        onChange(next);
                      }}
                    />
                    <span className="grid min-w-0">
                      <span className="truncate text-13 text-ink">{choice.name}</span>
                      {choice.name !== choice.origin && <span className="truncate font-mono text-11 text-ink-3">{choice.origin}</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ScrollArea>
          {chosen.length === 0 && <InlineError size={12}>{SECRETS_COPY.noProjects}</InlineError>}
        </div>
      )}
    </fieldset>
  );
}

function OptIn({
  label,
  help,
  checked,
  onChange,
  disabled = false,
  warning = false,
  data,
}: {
  label: string;
  help: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  warning?: boolean;
  data: string;
}) {
  return (
    <label data-secret-opt-in={data} className={`flex items-start gap-2.5 ${disabled ? "opacity-60" : ""}`}>
      <Checkbox checked={checked && !disabled} disabled={disabled} onCheckedChange={onChange} className="mt-0.5" />
      <span className="grid min-w-0 gap-0.5">
        <span className="text-13 font-medium text-ink">{label}</span>
        <span className={`text-12 ${warning ? "text-orange-ink" : "text-ink-3"}`}>{help}</span>
      </span>
    </label>
  );
}

/** The three opt-ins, each off by default; a file secret can't be kept in the environment. */
export function OptInsField({ value, onChange, file }: { value: SecretOptIns; onChange: (value: SecretOptIns) => void; file: boolean }) {
  return (
    <div className="grid gap-3">
      <OptIn
        data="ambient"
        label={SECRETS_COPY.ambient.label}
        help={SECRETS_COPY.ambient.help}
        checked={value.ambient}
        disabled={file}
        onChange={(ambient) => onChange({ ...value, ambient, askEachUse: ambient ? false : value.askEachUse })}
      />
      <OptIn
        data="ask-each-use"
        label={SECRETS_COPY.askEachUse.label}
        help={SECRETS_COPY.askEachUse.help}
        checked={value.askEachUse}
        onChange={(askEachUse) => onChange({ ...value, askEachUse, ambient: askEachUse ? false : value.ambient })}
      />
      <OptIn
        data="unattended"
        label={SECRETS_COPY.unattended.label}
        help={SECRETS_COPY.unattended.help}
        checked={value.unattended}
        warning
        onChange={(unattended) => onChange({ ...value, unattended })}
      />
    </div>
  );
}
