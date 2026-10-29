import { useEffect, useRef, useState } from "react";
import { customContrast, DEFAULT_THEME_ID, parseCustomTheme, resolvePalette, seedsFrom, serializeCustomTheme, themes } from "@milagre/shared/themes";
import type { CustomTheme, Scheme, ThemeId, ThemeSeeds } from "@milagre/shared/themes";
import { updateSettings, useResolvedScheme, useSettings } from "../../lib/settings";
import { Select } from "../primitives/Select";

const HEX = /^#[0-9a-f]{6}$/i;
const FIELDS: { key: keyof ThemeSeeds; name: string }[] = [
  { key: "background", name: "Background" },
  { key: "text", name: "Text" },
  { key: "accent", name: "Accent" },
];
const save = (next: CustomTheme) => updateSettings({ customTheme: next, colorTheme: "custom" });
const NO_CLIPBOARD = "Could not read the clipboard.";
const BAD_PASTE = "That isn't a Milagre theme. It needs light and dark, each with background, text and accent hex colors.";

function Segment({ value, onChange }: { value: Scheme; onChange: (scheme: Scheme) => void }) {
  return (
    <div role="radiogroup" aria-label="Editing" className="flex gap-0.5 rounded-[9px] bg-field p-0.5">
      {(["light", "dark"] as const).map((scheme) => (
        <button
          key={scheme}
          type="button"
          role="radio"
          aria-checked={value === scheme}
          aria-label={scheme === "light" ? "Light" : "Dark"}
          onClick={() => onChange(scheme)}
          className={`rounded-[7px] px-3 py-1 text-[12.5px] font-medium transition-colors ${
            value === scheme ? "bg-surface text-ink shadow-card" : "text-ink-3 hover:text-ink"
          }`}
        >
          {scheme === "light" ? "Light" : "Dark"}
        </button>
      ))}
    </div>
  );
}

function ColorRow({ name, value, onCommit }: { name: string; value: string; onCommit: (hex: string) => void }) {
  // The field keeps what is typed; it commits as soon as the text is a full hex color.
  const [draft, setDraft] = useState<{ source: string; text: string } | null>(null);
  const text = draft && draft.source === value ? draft.text : value;
  // Dragging in the picker fires on every tick; the swatch follows each one, the settings write once per frame.
  const [picked, setPicked] = useState<{ source: string; hex: string } | null>(null);
  const swatch = picked && picked.source === value ? picked.hex : value;
  const frame = useRef<number | null>(null);
  const latest = useRef<string>(value);
  const commit = useRef(onCommit);
  useEffect(() => {
    commit.current = onCommit;
  });
  useEffect(
    () => () => {
      if (frame.current === null) return;
      window.cancelAnimationFrame(frame.current);
      commit.current(latest.current);
    },
    [],
  );
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2.5">
      <span className="text-[13.5px] font-medium text-ink">{name}</span>
      <div className="flex shrink-0 items-center gap-2">
        <input
          type="color"
          aria-label={name}
          value={swatch}
          onChange={(event) => {
            const hex = event.target.value.toLowerCase();
            setPicked({ source: value, hex });
            latest.current = hex;
            if (frame.current !== null) return;
            frame.current = window.requestAnimationFrame(() => {
              frame.current = null;
              commit.current(latest.current);
            });
          }}
          className="size-7 cursor-pointer rounded-[7px] border-0 bg-transparent p-0"
        />
        <input
          type="text"
          aria-label={`${name} hex`}
          value={text}
          spellCheck={false}
          maxLength={7}
          onChange={(event) => {
            const next = event.target.value.trim();
            setDraft({ source: value, text: next });
            if (HEX.test(next)) onCommit(next.toLowerCase());
          }}
          onBlur={() => setDraft(null)}
          className="w-20 rounded-[7px] bg-field px-2 py-1 font-mono text-[12.5px] text-ink outline-none focus:ring-2 focus:ring-accent"
        />
      </div>
    </div>
  );
}

function Preview({ theme, scheme }: { theme: CustomTheme; scheme: Scheme }) {
  const p = resolvePalette("custom", scheme, theme);
  return (
    <div className="flex h-44 w-64 shrink-0 overflow-hidden rounded-[10px]" style={{ background: p.page, boxShadow: `0 0 0 1px ${p.line}` }} aria-hidden>
      <div className="grid w-20 shrink-0 content-start gap-1.5 p-2.5" style={{ background: p.canvas, borderRight: `1px solid ${p.line}` }}>
        <div className="h-1.5 w-10 rounded-full" style={{ background: p.ink3 }} />
        <div className="h-5 rounded-[5px]" style={{ background: p.hover }} />
        <div className="h-1.5 w-12 rounded-full" style={{ background: p.ink3 }} />
        <div className="h-1.5 w-9 rounded-full" style={{ background: p.ink3 }} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col justify-between p-3">
        <div className="grid gap-2">
          <div className="rounded-[8px] px-2.5 py-1.5 text-[11.5px]" style={{ background: p.surface, color: p.ink }}>
            Done. The tests pass.
          </div>
          <div className="rounded-[6px] px-2 py-1 font-mono text-[10.5px]" style={{ background: p.inset, color: p.ink2 }}>
            <span style={{ color: p.accent }}>const</span> theme = custom
          </div>
        </div>
        <div className="self-end rounded-[7px] px-3 py-1 text-[11.5px] font-medium" style={{ background: p.accent, color: p.onAccent }}>
          Send
        </div>
      </div>
    </div>
  );
}

export function CustomThemeEditor() {
  const settings = useSettings();
  const onScreen = useResolvedScheme();
  const [editing, setEditing] = useState<Scheme>(onScreen);
  const [base, setBase] = useState<ThemeId>(DEFAULT_THEME_ID);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const theme = settings.customTheme ?? seedsFrom(DEFAULT_THEME_ID);
  const seeds = theme[editing];
  const contrast = customContrast(seeds);
  const weak = contrast.text < 4.5 || contrast.accent < 3;

  const edit = (key: keyof ThemeSeeds, hex: string) => {
    setPasteError(null);
    save({ ...theme, [editing]: { ...seeds, [key]: hex } });
  };

  return (
    <div className="grid gap-3 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[13.5px] font-medium text-ink">Editing</span>
        <Segment value={editing} onChange={setEditing} />
      </div>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1 divide-y divide-line rounded-[10px] bg-field/50">
          {FIELDS.map((field) => (
            <ColorRow key={field.key} name={field.name} value={seeds[field.key]} onCommit={(hex) => edit(field.key, hex)} />
          ))}
        </div>
        <Preview theme={theme} scheme={editing} />
      </div>
      <p data-contrast className={`text-[12px] ${weak ? "text-orange-ink" : "text-ink-3"}`}>
        Text on background: {contrast.text.toFixed(1)}:1. Accent on background: {contrast.accent.toFixed(1)}:1.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] text-ink-3">Start from</span>
        <Select<ThemeId>
          label="Start from"
          width={220}
          value={base}
          onChange={(id) => {
            setBase(id);
            setPasteError(null);
            save(seedsFrom(id));
          }}
          options={themes.map((item) => ({ value: item.id, label: item.name, group: item.group }))}
        />
        <span className="flex-1" />
        {(
          [
            ["Copy as JSON", () => void navigator.clipboard.writeText(serializeCustomTheme(theme))],
            [
              "Paste JSON",
              async () => {
                let clipboard: string;
                try {
                  clipboard = await navigator.clipboard.readText();
                } catch {
                  setPasteError(NO_CLIPBOARD);
                  return;
                }
                const parsed = parseCustomTheme(clipboard);
                setPasteError(parsed ? null : BAD_PASTE);
                if (parsed) save(parsed);
              },
            ],
            [
              "Reset",
              () => {
                setPasteError(null);
                setBase(DEFAULT_THEME_ID);
                save(seedsFrom(DEFAULT_THEME_ID));
              },
            ],
          ] as const
        ).map(([label, run]) => (
          <button
            key={label}
            type="button"
            onClick={run}
            className="rounded-[8px] bg-field px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:bg-hover"
          >
            {label}
          </button>
        ))}
      </div>
      {pasteError && <p className="text-[12px] text-red-ink">{pasteError}</p>}
    </div>
  );
}
