import { themes, themeSwatch, type ThemeChoice, type ThemeGroup } from "@milagre/shared/themes";
import { updateSettings, useSettings } from "../../lib/settings";
import type { ThemePreference } from "../../lib/settings";

const GROUPS: ThemeGroup[] = ["Milagre", "Catppuccin", "Popular"];
const MODES: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** System, Light and Dark as one segmented control. */
export function ModeControl({ value, onChange }: { value: ThemePreference; onChange: (mode: ThemePreference) => void }) {
  return (
    <div role="radiogroup" aria-label="Mode" className="flex gap-0.5 rounded-[9px] bg-field p-0.5">
      {MODES.map((mode) => (
        <button
          key={mode.value}
          type="button"
          role="radio"
          aria-checked={value === mode.value}
          aria-label={mode.label}
          onClick={() => onChange(mode.value)}
          className={`rounded-[7px] px-3 py-1 text-[12.5px] font-medium transition-colors ${
            value === mode.value ? "bg-surface text-ink shadow-card" : "text-ink-3 hover:text-ink"
          }`}
        >
          {mode.label}
        </button>
      ))}
    </div>
  );
}

function Tile({ id, label, name, detail }: { id: ThemeChoice; label: string; name: string; detail: string }) {
  const settings = useSettings();
  const selected = settings.colorTheme === id;
  const { page, accent } = themeSwatch(id, settings.customTheme);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      onClick={() => updateSettings({ colorTheme: id })}
      className={`flex items-center gap-3 rounded-[10px] bg-surface px-3 py-2.5 text-left shadow-card transition-colors hover:bg-hover ${selected ? "ring-2 ring-accent" : ""}`}
    >
      <span className="relative size-8 shrink-0 overflow-hidden rounded-full shadow-hairline" style={{ background: page }}>
        <span className="absolute right-0 bottom-0 size-1/2" style={{ background: accent }} />
      </span>
      <span className="grid min-w-0">
        <span className="truncate text-[13px] font-medium text-ink">{name}</span>
        <span className="truncate text-[11.5px] text-ink-3">{detail}</span>
      </span>
    </button>
  );
}

export function ThemePicker() {
  const settings = useSettings();
  return (
    <div role="radiogroup" aria-label="Theme" className="grid gap-5">
      {GROUPS.map((group) => (
        <section key={group}>
          <h3 className="mb-2 px-1 text-[12px] font-medium text-ink-3">{group}</h3>
          <div className="grid grid-cols-3 gap-2">
            {themes
              .filter((theme) => theme.group === group)
              .map((theme) => (
                <Tile
                  key={theme.id}
                  id={theme.id}
                  label={group === "Milagre" ? theme.name : `${group} ${theme.name}`}
                  name={theme.name}
                  detail={theme.id === "milagre-blue" ? "Default" : theme.id === "gray" ? "Classic" : `Light: ${theme.lightName}`}
                />
              ))}
            {group === "Milagre" && settings.customThemeEnabled && settings.customTheme && (
              <Tile id="custom" label="Custom" name="Custom" detail="Your colors" />
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
