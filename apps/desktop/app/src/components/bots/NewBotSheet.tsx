import { useEffect, useState } from "react";
import type { BotRecord } from "@milagre/shared/bots";
import type { ModelOption } from "@milagre/shared/model";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { BotTemplate } from "../../electron.d.ts";
import { bridgeFor } from "../../lib/computer-bridge";
import { Select } from "../primitives/Select";
import { Button } from "../primitives/Button";
import { Checkbox } from "../primitives/Checkbox";
import { Dialog } from "../primitives/Dialog";
import { FIELD_LABEL, Input } from "../primitives/Field";
import { InlineError } from "../primitives/InlineError";
import { BotAvatar } from "./BotAvatar";

const LABEL = `mt-4 ${FIELD_LABEL}`;

/** New bot: a starter template's setup card, then the bot is created on this Mac. */
export function NewBotSheet({
  models,
  defaultModel,
  onClose,
  onCreated,
}: {
  models: ModelOption[];
  defaultModel?: ModelOption;
  onClose: () => void;
  onCreated: (bot: BotRecord) => void;
}) {
  const bridge = bridgeFor(null);
  const [templates, setTemplates] = useState<BotTemplate[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [modelId, setModelId] = useState(() => (defaultModel ?? models[0])?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const template = templates?.find((item) => item.id === templateId);

  const choose = (next: BotTemplate) => {
    setTemplateId(next.id);
    setName(next.name);
    setAnswers(Object.fromEntries(next.fields.map((field) => [field.id, field.kind === "projects" ? [] : ""])));
  };
  useEffect(() => {
    let live = true;
    bridge.botTemplates().then(
      (list) => {
        if (!live) return;
        setTemplates(list);
        if (list[0]) choose(list[0]);
      },
      (cause) => {
        if (live) setError(ipcErrorMessage(cause));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const model = models.find((item) => item.id === modelId);
  const missing = template?.fields.some((field) => field.required && !(answers[field.id]?.length ?? 0));
  const ready = Boolean(template && name.trim() && model && !missing);
  async function create() {
    if (saving || !ready || !template || !model) return;
    setSaving(true);
    setError(null);
    try {
      const bot = await bridge.createBot({
        templateId: template.id,
        name: name.trim(),
        answers: answers as { projects: string[]; ci?: string; linearTeam?: string },
        provider: model.provider,
        model: model.id,
      });
      onCreated(bot);
    } catch (cause) {
      setError(ipcErrorMessage(cause));
      setSaving(false);
    }
  }

  // Nothing closes it while the bot is being created.
  const close = () => {
    if (!saving) onClose();
  };
  return (
    <Dialog
      as="form"
      onSubmit={() => void create()}
      title={
        <span className="flex items-center gap-3">
          {template && <BotAvatar color={template.color} body={template.body} size={32} />}
          New bot
        </span>
      }
      description={template?.role}
      onClose={close}
      dismissOnScrim={!saving}
      data-new-bot-sheet
      actions={
        <>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !ready}>
            {saving ? "Creating…" : "Create bot"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col">
        {templates && templates.length > 1 && (
          <div className="mt-4">
            <Select
              label="Starter bot"
              value={templateId}
              width={400}
              options={templates.map((item) => ({ value: item.id, label: item.name, description: item.role }))}
              onChange={(id) => {
                const next = templates.find((item) => item.id === id);
                if (next) choose(next);
              }}
            />
          </div>
        )}
        <label className={LABEL} htmlFor="new-bot-name">
          Name
        </label>
        <Input id="new-bot-name" autoFocus maxLength={40} value={name} onChange={(event) => setName(event.target.value)} className="mt-1" />
        {template?.fields.map((field) =>
          field.kind === "projects" ? (
            <fieldset key={field.id} data-bot-field={field.id} className="contents">
              <legend className={LABEL}>{field.label}</legend>
              <div className="mt-1 rounded-control border border-line p-1">
                {(field.options ?? []).map((option) => {
                  const picked = ((answers[field.id] as string[] | undefined) ?? []).includes(option.value);
                  return (
                    <label
                      key={option.value}
                      className="flex h-9 cursor-pointer items-center gap-2 rounded-control px-2 transition-colors hover:bg-hover active:bg-hover-2"
                    >
                      <Checkbox
                        checked={picked}
                        disabled={saving}
                        value={option.value}
                        onCheckedChange={(checked) =>
                          setAnswers((current) => {
                            const list = (current[field.id] as string[] | undefined) ?? [];
                            return {
                              ...current,
                              [field.id]: checked ? [...list, option.value] : list.filter((value) => value !== option.value),
                            };
                          })
                        }
                      />
                      <span className="min-w-0 truncate text-13 font-medium" title={option.value}>
                        {option.label}
                      </span>
                    </label>
                  );
                })}
                {!field.options?.length && <p className="p-2 text-13 text-ink-3">Open a Project in Milagre first.</p>}
              </div>
            </fieldset>
          ) : (
            <div key={field.id} data-bot-field={field.id} className="flex flex-col">
              <label className={LABEL} htmlFor={`new-bot-${field.id}`}>
                {field.label}
              </label>
              <Input
                id={`new-bot-${field.id}`}
                value={(answers[field.id] as string | undefined) ?? ""}
                onChange={(event) => setAnswers((current) => ({ ...current, [field.id]: event.target.value }))}
                className="mt-1"
              />
            </div>
          ),
        )}
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className={FIELD_LABEL}>Model</span>
          <Select label="Model" value={modelId} width={260} options={models.map((item) => ({ value: item.id, label: item.name }))} onChange={setModelId} />
        </div>
        <InlineError size={12} className="mt-3 whitespace-pre-wrap">
          {error}
        </InlineError>
      </div>
    </Dialog>
  );
}
