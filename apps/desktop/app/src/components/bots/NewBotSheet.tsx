import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BotRecord } from "@milagre/shared/bots";
import type { ModelOption } from "@milagre/shared/model";
import { ipcErrorMessage } from "@milagre/shared/result";
import type { BotTemplate } from "../../electron.d.ts";
import { bridgeFor } from "../../lib/computer-bridge";
import { ScrollArea } from "../primitives/ScrollArea";
import { Select } from "../primitives/Select";
import { BotAvatar } from "./BotAvatar";

const FIELD = "mt-1 rounded-control border border-line bg-field px-3 py-2 text-[13px] outline-none focus:border-line-strong";
const LABEL = "mt-4 text-[12px] font-medium text-ink-2";

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
  const scrim = useRef<HTMLDivElement>(null);
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

  return createPortal(
    // A full-window scrim rather than a modal <dialog>: the model picker's panel opens in the page, above it.
    <div
      ref={scrim}
      data-new-bot-sheet
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-bot-title"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented && !saving) onClose();
      }}
      onClick={(event) => {
        if (event.target === scrim.current && !saving) onClose();
      }}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/20 backdrop-blur-overlay"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
        className="flex max-h-[calc(100vh-64px)] w-[440px] max-w-[calc(100vw-32px)] flex-col rounded-[16px] bg-surface p-5 text-ink shadow-overlay"
      >
        <div className="flex items-center gap-3">
          {template && <BotAvatar color={template.color} body={template.body} size={44} />}
          <div className="min-w-0">
            <h2 id="new-bot-title" className="text-[17px] font-semibold">
              New bot
            </h2>
            {template && <p className="truncate text-[13px] text-ink-2">{template.role}</p>}
          </div>
        </div>
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
        <ScrollArea className="-mx-1 mt-1 min-h-0 px-1">
          <div className="flex flex-col">
            <label className={LABEL} htmlFor="new-bot-name">
              Name
            </label>
            <input id="new-bot-name" autoFocus maxLength={40} value={name} onChange={(event) => setName(event.target.value)} className={FIELD} />
            {template?.fields.map((field) =>
              field.kind === "projects" ? (
                <fieldset key={field.id} data-bot-field={field.id} className="contents">
                  <legend className={LABEL}>{field.label}</legend>
                  <div className="mt-1 rounded-control border border-line p-1">
                    {(field.options ?? []).map((option) => {
                      const picked = ((answers[field.id] as string[] | undefined) ?? []).includes(option.value);
                      return (
                        <label key={option.value} className="flex h-9 cursor-pointer items-center gap-2 rounded-control px-2 hover:bg-hover-2">
                          <input
                            type="checkbox"
                            checked={picked}
                            disabled={saving}
                            value={option.value}
                            onChange={(event) =>
                              setAnswers((current) => {
                                const list = (current[field.id] as string[] | undefined) ?? [];
                                return {
                                  ...current,
                                  [field.id]: event.target.checked ? [...list, option.value] : list.filter((value) => value !== option.value),
                                };
                              })
                            }
                            className="accent-ink"
                          />
                          <span className="min-w-0 truncate text-[13px] font-medium" title={option.value}>
                            {option.label}
                          </span>
                        </label>
                      );
                    })}
                    {!field.options?.length && <p className="p-2 text-[13px] text-ink-3">Open a Project in Milagre first.</p>}
                  </div>
                </fieldset>
              ) : (
                <div key={field.id} data-bot-field={field.id} className="flex flex-col">
                  <label className={LABEL} htmlFor={`new-bot-${field.id}`}>
                    {field.label}
                  </label>
                  <input
                    id={`new-bot-${field.id}`}
                    value={(answers[field.id] as string | undefined) ?? ""}
                    onChange={(event) => setAnswers((current) => ({ ...current, [field.id]: event.target.value }))}
                    className={FIELD}
                  />
                </div>
              ),
            )}
            <div className="mt-4 flex items-center justify-between gap-3">
              <span className="text-[12px] font-medium text-ink-2">Model</span>
              <Select label="Model" value={modelId} width={260} options={models.map((item) => ({ value: item.id, label: item.name }))} onChange={setModelId} />
            </div>
          </div>
        </ScrollArea>
        {error && (
          <p role="alert" className="mt-3 whitespace-pre-wrap text-[13px] text-red">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" disabled={saving} onClick={onClose} className="rounded-control px-3 py-2 text-[13px] hover:bg-hover-2">
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !ready}
            className="rounded-control bg-ink px-3 py-2 text-[13px] font-medium text-surface disabled:opacity-40"
          >
            {saving ? "Creating…" : "Create bot"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
