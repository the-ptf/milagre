import { SettingCheckbox } from "../primitives/Checkbox";
import { useEffect, useRef, useState } from "react";
import { getSettings, updateSettings, useSettings } from "../../lib/settings";
import { Select } from "../primitives/Select";
import { Group, Row } from "./SettingsGroup";
import { ModeControl, ThemePicker } from "./ThemePicker";
import { CustomThemeEditor } from "./CustomThemeEditor";
import { AppearanceWindowPreview, type PreviewArea } from "./AppearanceWindowPreview";
import { AppIconPicker } from "./AppIconPicker";
import {
  CHAT_SIZES,
  CHAT_WIDTHS,
  CODE_SIZES,
  DIFF_PAIRS,
  clampChatWidth,
  MONO_FONTS,
  MOTION_SPEEDS,
  SIDEBAR_SIZES,
  PROVIDER_ICON_STYLES,
  UI_FONTS,
  type FontOption,
} from "@milagre/shared/appearance";
import { isFontInstalled, withBundledNames } from "../../lib/appearance";
import { DEFAULT_THEME_ID, seedsFrom } from "@milagre/shared/themes";

/** The custom chat width: digits right-aligned with a px suffix. Enter or blur saves the clamped value, Escape restores the saved one. */
function ChatWidthField({ value, onCommit, onFocusChange }: { value: number; onCommit: (px: number) => void; onFocusChange?: (focused: boolean) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    // An empty field is not a width: put the saved one back.
    if (text.trim() === "") {
      setText(String(value));
      return;
    }
    const px = clampChatWidth(text);
    setText(String(px));
    if (px !== value) onCommit(px);
  };
  return (
    <label className="flex h-8 items-center gap-1.5 rounded-control border border-line-strong bg-field pr-2.5 pl-3 text-13 font-medium text-ink transition-colors duration-fast">
      <input
        aria-label="Custom chat width in pixels"
        inputMode="numeric"
        value={text}
        onChange={(event) => setText(event.target.value.replace(/[^0-9]/g, ""))}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => {
          commit();
          onFocusChange?.(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          else if (event.key === "Escape") {
            // Reverting is all Escape does here; App's Escape handler would otherwise leave Settings.
            event.preventDefault();
            event.stopPropagation();
            setText(String(value));
          }
        }}
        className="w-12 bg-transparent text-right outline-none tabular-nums"
      />
      <span className="text-ink-3">px</span>
    </label>
  );
}

/** Two dots, additions then deletions, in the pair's colors (the default pair shows the theme's own green and red). */
function DiffDots({ pair }: { pair: (typeof DIFF_PAIRS)[number] }) {
  const colors = (document.documentElement.classList.contains("dark") ? pair.dark : pair.light) ?? { add: "var(--green)", remove: "var(--red)" };
  return (
    <span data-diff-dots className="flex gap-1" aria-hidden>
      <span className="size-2.5 rounded-full" style={{ background: colors.add }} />
      <span className="size-2.5 rounded-full" style={{ background: colors.remove }} />
    </span>
  );
}

function fontOptions(list: readonly FontOption[]) {
  return list
    .filter((font) => font.bundled || isFontInstalled(font.label))
    .map((font) => ({
      value: font.id,
      label: font.label,
      description: font.id === "system" ? "default" : undefined,
      style: { fontFamily: withBundledNames(font.stack) },
    }));
}

/** A saved font that is no longer installed reads as the default; the saved value stays. */
function shownFont(list: readonly FontOption[], id: string) {
  const font = list.find((candidate) => candidate.id === id);
  return font && (font.bundled || isFontInstalled(font.label)) ? id : (list[0]?.id ?? "system");
}

function pxOptions<T extends string>(list: readonly { id: T; px: number }[]) {
  return list.map((size) => ({
    value: size.id,
    label: `${size.px} px`,
    description: size.id === "default" ? "default" : undefined,
  }));
}

// The window's stripes (as on body, pinned to the viewport), so a strip painted with them is invisible over the page.
const STRIPES = {
  backgroundColor: "var(--stripe-bg)",
  backgroundImage: "repeating-linear-gradient(-45deg, transparent 0, transparent 7px, var(--stripe) 7px, var(--stripe) 8px)",
  backgroundAttachment: "fixed",
} as const;

// Once the rows scroll under it, the pinned preview shrinks to this height so most of the page stays readable.
const PINNED_PREVIEW_HEIGHT = 180;

const PIN_TRANSITION = "var(--duration-base) var(--ease-enter)";

/** The scrolling element that holds `node`. */
function scrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let current = node?.parentElement ?? null; current; current = current.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(current).overflowY)) return current;
  }
  return null;
}

/**
 * The Appearance preview, sticky over the rows below it. At the top of the page it shows at full size; once the rows
 * start scrolling under it, it shrinks from its top edge and its strip is clipped to match, so the rows come back into
 * view. Only paint changes: the strip keeps its height in the layout, so nothing below it moves. A striped fade at the
 * strip's edge lets the rows pass under it instead of being cut.
 */
function PinnedPreview({ highlight, playMotion }: { highlight: PreviewArea | null; playMotion: number }) {
  const sentinel = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const viewport = scrollParent(sentinel.current);
    if (!viewport) return;
    const update = () => {
      const top = sentinel.current?.getBoundingClientRect().top ?? 0;
      setPinned(top < viewport.getBoundingClientRect().top);
    };
    update();
    viewport.addEventListener("scroll", update, { passive: true });
    return () => viewport.removeEventListener("scroll", update);
  }, []);
  useEffect(() => {
    const node = card.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const factor = pinned && height > PINNED_PREVIEW_HEIGHT ? PINNED_PREVIEW_HEIGHT / height : 1;
  const hidden = height * (1 - factor);
  return (
    <>
      <div ref={sentinel} aria-hidden />
      <div
        data-slot="appearance-preview-strip"
        data-pinned={pinned || undefined}
        className="sticky top-0 z-20 -mx-6 px-6 pt-6 pb-3"
        style={{ ...STRIPES, clipPath: `inset(0 0 ${hidden}px 0)`, transition: `clip-path ${PIN_TRANSITION}` }}
      >
        <div ref={card} style={{ transform: `scale(${factor})`, transformOrigin: "50% 0", transition: `transform ${PIN_TRANSITION}` }}>
          <AppearanceWindowPreview highlight={highlight} playMotion={playMotion} />
        </div>
        <div
          aria-hidden
          data-slot="appearance-preview-fade"
          className="pointer-events-none absolute inset-x-0 top-full h-6"
          style={{
            ...STRIPES,
            maskImage: "linear-gradient(to bottom, black, transparent)",
            transform: `translateY(${-hidden}px)`,
            transition: `transform ${PIN_TRANSITION}`,
          }}
        />
      </div>
    </>
  );
}

// A change keeps its area highlighted this long after the menu closes.
const PREVIEW_HOLD_MS = 1500;

/** A state update that drops `area` and keeps anything else. */
const unlessArea = (area: PreviewArea) => (current: PreviewArea | null) => (current === area ? null : current);

/**
 * What the Appearance window preview highlights: an open menu (or the focused px field) first, then the area just
 * changed (held 1.5 s), then the row under the pointer. Moving onto another row drops the held one.
 */
function usePreviewHighlight() {
  const [hovered, setHovered] = useState<PreviewArea | null>(null);
  const [menu, setMenu] = useState<PreviewArea | null>(null);
  const [held, setHeld] = useState<PreviewArea | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return {
    highlight: menu ?? held ?? hovered,
    row: (area: PreviewArea) => ({
      onEnter: () => {
        setHovered(area);
        setHeld((current) => (current === area ? current : null));
      },
      onLeave: () => setHovered(unlessArea(area)),
    }),
    menu: (area: PreviewArea) => (open: boolean) => setMenu(open ? area : unlessArea(area)),
    /** Holds `area` for 1.5 s; null drops a held area at once. */
    hold: (area: PreviewArea | null) => {
      setHeld(area);
      window.clearTimeout(timer.current);
      if (area) timer.current = window.setTimeout(() => setHeld(null), PREVIEW_HOLD_MS);
    },
  };
}

export function AppearanceSettings() {
  const settings = useSettings();
  const { appearance } = settings;
  const setAppearance = (patch: Partial<typeof appearance>) => updateSettings({ appearance: { ...getSettings().appearance, ...patch } });
  const preview = usePreviewHighlight();
  const [playMotion, setPlayMotion] = useState(0);
  const change = (area: PreviewArea, patch: Partial<typeof appearance>) => {
    setAppearance(patch);
    preview.hold(area);
  };
  return (
    <>
      <Group title="Mode">
        <Row label="Mode" description="System follows macOS. Every theme has a light and a dark version. ⇧⌘T switches.">
          <ModeControl value={settings.theme} onChange={(theme) => updateSettings({ theme })} />
        </Row>
      </Group>
      <section className="mt-6">
        <ThemePicker />
      </section>
      <Group title="Custom theme">
        <Row label="Custom theme" description={'Build a theme from a few colors. It shows up as "Custom" with the Milagre themes.'}>
          <SettingCheckbox
            label="Custom theme"
            checked={settings.customThemeEnabled}
            onChange={(customThemeEnabled) => {
              if (!customThemeEnabled) {
                updateSettings({
                  customThemeEnabled,
                  ...(settings.colorTheme === "custom" ? { colorTheme: DEFAULT_THEME_ID } : {}),
                });
              } else {
                const from = settings.colorTheme === "custom" ? DEFAULT_THEME_ID : settings.colorTheme;
                updateSettings({
                  customThemeEnabled,
                  customTheme: settings.customTheme ?? seedsFrom(from),
                  colorTheme: "custom",
                });
              }
            }}
          />
        </Row>
        {settings.customThemeEnabled && <CustomThemeEditor />}
      </Group>
      <AppIconPicker />
      <div>
        <PinnedPreview highlight={preview.highlight} playMotion={playMotion} />
        <Group title="Typography">
          <Row label="Interface font" description="Used across the app." preview={preview.row("ui")}>
            <Select
              label="Interface font"
              width={260}
              searchable
              value={shownFont(UI_FONTS, appearance.uiFont)}
              onChange={(uiFont) => change("ui", { uiFont })}
              onOpenChange={preview.menu("ui")}
              options={fontOptions(UI_FONTS)}
            />
          </Row>
          <Row label="Monospace font" description="Code, diffs and the terminal." preview={preview.row("code")}>
            <Select
              label="Monospace font"
              width={260}
              searchable
              value={shownFont(MONO_FONTS, appearance.monoFont)}
              onChange={(monoFont) => change("code", { monoFont })}
              onOpenChange={preview.menu("code")}
              options={fontOptions(MONO_FONTS)}
            />
          </Row>
          <Row label="Sidebar size" description="Project and chat names in the sidebar." preview={preview.row("sidebar")}>
            <Select
              label="Sidebar size"
              width={160}
              value={appearance.sidebarSize}
              onChange={(sidebarSize) => change("sidebar", { sidebarSize })}
              onOpenChange={preview.menu("sidebar")}
              options={pxOptions(
                SIDEBAR_SIZES.map((size) => ({
                  id: size.id,
                  px: 13 + size.delta,
                })),
              )}
            />
          </Row>
          <Row label="Chat size" description="Messages and the composer." preview={preview.row("chat")}>
            <Select
              label="Chat size"
              width={160}
              value={appearance.chatSize}
              onChange={(chatSize) => change("chat", { chatSize })}
              onOpenChange={preview.menu("chat")}
              options={pxOptions(CHAT_SIZES)}
            />
          </Row>
          <Row label="Code size" description="Code blocks, diffs and the terminal." preview={preview.row("code")}>
            <Select
              label="Code size"
              width={160}
              value={appearance.codeSize}
              onChange={(codeSize) => change("code", { codeSize })}
              onOpenChange={preview.menu("code")}
              options={pxOptions(CODE_SIZES)}
            />
          </Row>
        </Group>
        <Group title="Layout">
          <Row label="Chat width" description="How wide messages and the composer grow on large screens." preview={preview.row("width")}>
            <div className="flex items-center gap-2">
              {appearance.chatWidth === "custom" && (
                <ChatWidthField
                  value={appearance.chatWidthPx}
                  onCommit={(chatWidthPx) => change("width", { chatWidthPx })}
                  onFocusChange={preview.menu("width")}
                />
              )}
              <Select
                label="Chat width"
                width={200}
                value={appearance.chatWidth}
                onChange={(chatWidth) => change("width", { chatWidth })}
                onOpenChange={preview.menu("width")}
                options={CHAT_WIDTHS.map((width) => ({
                  value: width.id,
                  label: width.label,
                }))}
              />
            </div>
          </Row>
          <Row label="Provider icons" description="Original colors, or black and white to match the mode." preview={preview.row("ui")}>
            <Select
              label="Provider icons"
              width={200}
              value={appearance.providerIcons}
              onChange={(providerIcons) => change("ui", { providerIcons })}
              onOpenChange={preview.menu("ui")}
              options={PROVIDER_ICON_STYLES.map((style) => ({
                value: style.id,
                label: style.label,
              }))}
            />
          </Row>
          <Row label="Film grain" description="A faint grain over the window and the side panels.">
            <SettingCheckbox label="Film grain" checked={appearance.grain !== "off"} onChange={(on) => change("ui", { grain: on ? "on" : "off" })} />
          </Row>
          <Row label="Background dots" description="The dot grid behind the window.">
            <SettingCheckbox label="Background dots" checked={appearance.dots !== "off"} onChange={(on) => change("ui", { dots: on ? "on" : "off" })} />
          </Row>
        </Group>
        <Group title="Diffs">
          <Row label="Diff colors" description="Additions and deletions, including change counts." preview={preview.row("diff")}>
            <Select
              label="Diff colors"
              width={220}
              value={appearance.diffColors}
              onChange={(diffColors) => change("diff", { diffColors })}
              onOpenChange={preview.menu("diff")}
              options={DIFF_PAIRS.map((pair) => ({
                value: pair.id,
                label: pair.label,
                icon: <DiffDots pair={pair} />,
              }))}
            />
          </Row>
        </Group>
        <Group title="Motion">
          <Row label="Panel animations" description="How fast panels open and close. macOS Reduce Motion turns them off.">
            <Select
              label="Panel animations"
              width={160}
              value={appearance.motion}
              onChange={(motion) => {
                setAppearance({ motion });
                // The replay is the feedback here, so a highlight still held from another row goes.
                preview.hold(null);
                setPlayMotion((count) => count + 1);
              }}
              options={MOTION_SPEEDS.map((speed) => ({
                value: speed.id,
                label: speed.label,
              }))}
            />
          </Row>
        </Group>
      </div>
    </>
  );
}
