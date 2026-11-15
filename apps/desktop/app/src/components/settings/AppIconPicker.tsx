import { useEffect, useState } from "react";
import type { AppIcon } from "../../electron";
import { radioKeys } from "../primitives/Segmented";
import { Group } from "./SettingsGroup";

/** The phone's icon names (apps/mobile/src/app-icon-section.tsx), in the same order. */
const APP_ICONS: { id: AppIcon; name: string }[] = [
  { id: "default", name: "Milagre" },
  { id: "dawn", name: "Dawn" },
  { id: "mono-dark", name: "Black" },
  { id: "mono-light", name: "White" },
  { id: "sunset", name: "Sunset" },
  { id: "aurora", name: "Aurora" },
  { id: "glass", name: "Glass" },
  { id: "eight-bit", name: "8-bit" },
];

const APP_ICON_DESCRIPTION = "Shown in the Dock or taskbar on this computer. Finder and Launchpad keep the Milagre icon.";

/** Settings › Appearance › App icon: this computer's own, so it reads and saves through window.milagre. */
export function AppIconPicker() {
  const [current, setCurrent] = useState<AppIcon | null>(null);
  useEffect(() => {
    let live = true;
    void window.milagre.getAppIcon().then((icon) => live && setCurrent(icon));
    return () => {
      live = false;
    };
  }, []);
  const choose = (icon: AppIcon) => {
    if (icon === current) return;
    const previous = current;
    setCurrent(icon);
    window.milagre.setAppIcon(icon).then(setCurrent, () => setCurrent(previous));
  };
  const focus = current ?? "default";
  return (
    <Group title="App icon">
      <div data-settings-row className="grid gap-3 px-4 py-3">
        <span className="text-12 text-ink-3">{APP_ICON_DESCRIPTION}</span>
        <div role="radiogroup" aria-label="App icon" onKeyDown={radioKeys({ columns: APP_ICONS.length })} className="flex flex-wrap gap-x-2 gap-y-3">
          {APP_ICONS.map((icon) => {
            const selected = icon.id === current;
            return (
              <button
                key={icon.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`${icon.name} icon`}
                tabIndex={icon.id === focus ? 0 : -1}
                onClick={() => choose(icon.id)}
                className="group grid w-16 justify-items-center gap-1.5 py-1 outline-none"
              >
                {/* The chosen icon is ringed in ink, like the chosen theme tile. */}
                <span
                  className={`rounded-window border-2 p-0.5 transition-colors group-focus-visible:border-accent ${selected ? "border-ink" : "border-transparent group-hover:border-line"}`}
                >
                  <img src={`./app-icons/thumbs/${icon.id}.png`} alt="" draggable={false} className="block size-12 rounded-card shadow-hairline" />
                </span>
                <span className={`max-w-full truncate text-12 ${selected ? "font-medium text-ink" : "text-ink-3"}`}>{icon.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </Group>
  );
}
