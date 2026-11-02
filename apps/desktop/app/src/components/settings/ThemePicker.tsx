import { themes, themeSwatch, type ThemeChoice, type ThemeGroup } from "@milagre/shared/themes";
import { updateSettings, useSettings } from "../../lib/settings";
import type { ThemePreference } from "../../lib/settings";
import { SectionLabel } from "../primitives/SectionLabel";
import { radioKeys, Segmented } from "../primitives/Segmented";

const GROUPS: ThemeGroup[] = ["Milagre", "Catppuccin", "Popular"];
// Each segment keeps its aria-label, which scripts/test-theming.cjs selects by.
const MODES = [
  { value: "system", label: "System", ariaLabel: "System" },
  { value: "light", label: "Light", ariaLabel: "Light" },
  { value: "dark", label: "Dark", ariaLabel: "Dark" },
] as const satisfies ReadonlyArray<{ value: ThemePreference; label: string; ariaLabel: string }>;

/** System, Light and Dark as one segmented control, the Segmented primitive's large size. */
export function ModeControl({ value, onChange }: { value: ThemePreference; onChange: (mode: ThemePreference) => void }) {
  return <Segmented<ThemePreference> label="Mode" size="large" value={value} options={MODES} onChange={onChange} />;
}

function Tile({ id, label, name, detail, focusable }: { id: ThemeChoice; label: string; name: string; detail: string; focusable: boolean }) {
  const settings = useSettings();
  const selected = settings.colorTheme === id;
  const { page, accent } = themeSwatch(id, settings.customTheme);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      tabIndex={focusable ? 0 : -1}
      onClick={() => updateSettings({ colorTheme: id })}
      // The chosen theme is ringed in ink: accent is for focus and links.
      className={`flex items-center gap-3 rounded-card bg-surface p-3 text-left shadow-card transition-colors hover:bg-hover ${selected ? "ring-2 ring-ink" : ""}`}
    >
      <span className="relative size-8 shrink-0 overflow-hidden rounded-full shadow-hairline" style={{ background: page }}>
        <span className="absolute right-0 bottom-0 size-1/2" style={{ background: accent }} />
      </span>
      <span className="grid min-w-0">
        <span className="truncate text-13 font-medium text-ink">{name}</span>
        <span className="truncate text-12 text-ink-3">{detail}</span>
      </span>
    </button>
  );
}

export function ThemePicker() {
  const settings = useSettings();
  const custom = settings.customThemeEnabled && settings.customTheme;
  // One Tab stop: the chosen tile (the first when it isn't shown); the arrows move through the three-column grid.
  const shown: ThemeChoice[] = [...themes.map((theme) => theme.id), ...(custom ? (["custom"] as const) : [])];
  const focus = shown.includes(settings.colorTheme) ? settings.colorTheme : shown[0];
  return (
    <div role="radiogroup" aria-label="Theme" onKeyDown={radioKeys({ columns: 3 })} className="grid gap-5">
      {GROUPS.map((group) => (
        <section key={group}>
          <SectionLabel as="h3" className="mb-2 px-1">
            {group}
          </SectionLabel>
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
                  focusable={theme.id === focus}
                />
              ))}
            {group === "Milagre" && custom && <Tile id="custom" label="Custom" name="Custom" detail="Your colors" focusable={focus === "custom"} />}
          </div>
        </section>
      ))}
    </div>
  );
}
