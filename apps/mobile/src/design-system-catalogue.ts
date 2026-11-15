import { type as typeScale } from "./design-tokens.ts";
import type { Palette } from "./theme.ts";

/**
 * What Settings › Design system shows: its sections, the colour and type roles its specimens are labelled with, and the
 * rules where iOS and Android draw the same thing differently. The pages and their counts read this list, and
 * apps/mobile/DESIGN.md says the same in prose; design-system-catalogue.test.ts keeps it whole.
 */

export type DesignPlatform = "ios" | "android";

export const PLATFORM_NAMES: Record<DesignPlatform, string> = { ios: "iOS", android: "Android" };

export type DesignSectionId = "colors" | "type" | "spacing" | "surfaces" | "buttons" | "rows" | "chips" | "menus" | "composer" | "platforms";

/** How the index row previews its page: a value, five colour dots, or a tiny filled Send pill. */
type DesignSectionPreview = { kind: "value"; value: string } | { kind: "dots" } | { kind: "send" } | { kind: "count" };

export type DesignSection = {
  id: DesignSectionId;
  title: string;
  /** One line under the page's title: what the page shows. */
  summary: string;
  preview?: DesignSectionPreview;
  /** Other words Settings search finds the row by. */
  keywords: string;
};

export type DesignGroup = { title: string; sections: DesignSection[] };

export const DESIGN_SYSTEM_INTRO = "Every value and part the phone draws with, live from the app's own tokens and primitives.";

export const DESIGN_SYSTEM_GROUPS: readonly DesignGroup[] = [
  {
    title: "Foundations",
    sections: [
      {
        id: "colors",
        title: "Colors",
        summary: "Every Palette key in the current theme and mode, with what it is for.",
        preview: { kind: "dots" },
        keywords: "palette theme tokens swatches ink accent green orange red",
      },
      {
        id: "type",
        title: "Type",
        summary: "The Dynamic Type scale: size over line height, and the role of each step.",
        preview: { kind: "value", value: `${Object.keys(typeScale).length} styles` },
        keywords: "fonts text sizes typography dynamic type",
      },
      {
        id: "spacing",
        title: "Spacing and radius",
        summary: "The 4 pt grid, the corner scale, touch targets and motion.",
        preview: { kind: "value", value: "4 pt grid" },
        keywords: "space gutter padding corners radii hit slop motion duration easing",
      },
      {
        id: "surfaces",
        title: "Surfaces and elevation",
        summary: "Page, canvas and surface, the three shadows, and the glass behind floating controls.",
        keywords: "shadow card raised overlay glass liquid",
      },
    ],
  },
  {
    title: "Components",
    sections: [
      {
        id: "buttons",
        title: "Buttons",
        summary: "PillButton, CircleButton, IconButton, GlassIconButton and HeaderButton.",
        preview: { kind: "send" },
        keywords: "pill circle icon glass header primary secondary destructive",
      },
      {
        id: "rows",
        title: "Rows and lists",
        summary: "ListRow and CheckRow in a Group, checkboxes, fields, notices and empty states.",
        keywords: "list row group section label checkbox toggle field error empty progress",
      },
      { id: "chips", title: "Chips and tags", summary: "Chip, the tappable pill, and Tag, the static label.", keywords: "chip tag badge pill label" },
      {
        id: "menus",
        title: "Menus and sheets",
        summary: "PullDown menus, the choice and action sheets, Segmented, sheet headers and the toast.",
        keywords: "menu pull down sheet segmented toast actions choice",
      },
      {
        id: "composer",
        title: "Composer and Chat",
        summary: "A user message and a reply drawn by the Chat's own components, and the composer's tokens.",
        keywords: "chat message bubble reply markdown composer transcript",
      },
    ],
  },
  {
    title: "Platforms",
    sections: [
      {
        id: "platforms",
        title: "iOS and Android differences",
        summary: "Where the phone draws or behaves differently on iOS and Android, and why.",
        preview: { kind: "count" },
        keywords: "android ios platform native differences",
      },
    ],
  },
];

export const DESIGN_SECTIONS: readonly DesignSection[] = DESIGN_SYSTEM_GROUPS.flatMap((group) => group.sections);

export function designSection(id: string | undefined): DesignSection | undefined {
  return DESIGN_SECTIONS.find((section) => section.id === id);
}

/** The five dots on the Colors row. */
export const COLOR_PREVIEW = ["ink", "accent", "green", "orange", "red"] as const satisfies readonly (keyof Palette)[];

/** A palette key that holds a colour (not a shadow). */
type ColorKey = { [K in keyof Palette]: Palette[K] extends string ? K : never }[keyof Palette];
type ShadowKey = "shadowCard" | "shadowRaised" | "shadowOverlay";

type ColorRole = { key: Exclude<ColorKey, ShadowKey>; use: string };
export type ColorGroup = { title: string; colors: ColorRole[] };

/** Every colour key of `Palette` (theme.ts), grouped by role. The shadows are on the Surfaces page. */
export const COLOR_GROUPS: readonly ColorGroup[] = [
  {
    title: "Surfaces",
    colors: [
      { key: "page", use: "Every screen, the transcript, the Chats list" },
      { key: "canvas", use: "Recessed areas and your own message's bubble" },
      { key: "surface", use: "Cards, grouped lists, sheets, the composer" },
      { key: "inset", use: "A well inside a card, a picked option" },
      { key: "field", use: "Text fields, a neutral Tag, a tinted pill" },
      { key: "hover", use: "An iPad pointer over anything: translucent ink" },
      { key: "hover2", use: "The open or selected row, a pressed toggle" },
      { key: "line", use: "Hairlines, separators, the ring in each shadow" },
      { key: "lineStrong", use: "Field edges, a secondary pill's edge, chips" },
      { key: "paper", use: "A page that stays white: HTML artifacts, QR codes" },
    ],
  },
  {
    title: "Ink",
    colors: [
      { key: "ink", use: "Primary text, the primary pill's fill, icons at full strength" },
      { key: "ink2", use: "Secondary text, control glyphs at rest" },
      { key: "ink3", use: "Section labels, metadata, values, placeholders" },
      { key: "ink4", use: "Decorative icons, dots, disabled marks. Never text" },
      { key: "onInk", use: "A label on an ink fill (the surface)" },
      { key: "idleDot", use: "The idle Chat mark: a solid ink4 dot" },
    ],
  },
  {
    title: "Accent",
    colors: [
      { key: "accent", use: "Focus edges, the caret, the unread dot" },
      { key: "accentInk", use: "Links and actions that read as links" },
      { key: "accentTint", use: "Behind accentInk, for an armed mode" },
      { key: "onAccent", use: "A label on an accent fill" },
    ],
  },
  {
    title: "Status",
    colors: [
      { key: "green", use: "Online, enabled, an open PR: fills, dots, icons" },
      { key: "greenInk", use: "Green as text" },
      { key: "greenTint", use: "Behind green text" },
      { key: "onGreen", use: "A label on a greenInk fill" },
      { key: "orange", use: "Needs you: an approval, a question; Full mode" },
      { key: "orangeInk", use: "Orange as text" },
      { key: "orangeTint", use: "Behind orange text" },
      { key: "onOrange", use: "A label on an orangeInk fill" },
      { key: "red", use: "Failed, destructive, recording" },
      { key: "redInk", use: "Red as text, the destructive pill's fill" },
      { key: "redTint", use: "Behind red text, the ErrorNotice card" },
      { key: "onRed", use: "A glyph on the plain red fill (a recording mic)" },
      { key: "onRedInk", use: "The label on a destructive primary pill" },
    ],
  },
  {
    title: "Ultracode",
    colors: [
      { key: "purple", use: "Ultracode and merged PRs: fills, icons, the glow" },
      { key: "purpleInk", use: "Purple as text" },
      { key: "purpleTint", use: "Behind purple text, Ultracode's tile when on" },
    ],
  },
  {
    title: "Diff",
    colors: [
      { key: "add", use: "Additions and their counts (Diff colors can swap it)" },
      { key: "remove", use: "Deletions and their counts" },
      { key: "diffAdd", use: "An added line's row" },
      { key: "diffAddWord", use: "An added word" },
      { key: "diffRemove", use: "A removed line's row" },
      { key: "diffRemoveWord", use: "A removed word" },
    ],
  },
  {
    title: "Media and overlays",
    colors: [
      { key: "scrim", use: "Behind a modal: black at 20% light, 40% dark" },
      { key: "media", use: "Behind full-screen media and the camera" },
      { key: "onMedia", use: "Controls on media" },
      { key: "onMedia2", use: "Secondary text on media" },
      { key: "onMediaTint", use: "A control's fill on media" },
      { key: "cursor", use: "The Terminal's cursor" },
      { key: "selection", use: "Selected text in the Terminal" },
    ],
  },
  {
    title: "Aliases",
    colors: [
      { key: "bg", use: "Old name for page" },
      { key: "panel", use: "Old name for surface" },
      { key: "text", use: "Old name for ink" },
      { key: "muted", use: "Old name for ink2" },
      { key: "error", use: "Old name for redInk" },
      { key: "backdrop", use: "Deprecated: use scrim" },
    ],
  },
];

/** What each step of the `type` scale (design-tokens.ts) is for. */
export const TYPE_ROLES: Record<keyof typeof typeScale, string> = {
  largeTitle: "Large title, the one 700 weight",
  title1: "Title 1",
  title2: "Title 2",
  title3: "Title 3: a PR title, a card's heading",
  body: "Body, a row's title, a sheet's title",
  callout: "A two-line row's title",
  subheadline: "Subheadline, Chat titles, pill labels",
  footnote: "Footnote, section labels, meta lines",
  caption1: "Caption 1, a row's subtitle, Tag labels",
  caption2: "Caption 2, badges and counts",
};

/** What each spacing token is for (design-tokens.ts `space`). */
export const SPACE_ROLES = {
  xxs: "Inside dense rows only",
  xs: "Icon to label in a chip",
  sm: "Inside dense rows only",
  md: "Between controls",
  lg: "Inside cards and rows",
  xl: "Card padding",
  xxl: "Between groups",
  xxxl: "Between large blocks",
  gutter: "Every screen's side padding",
  section: "The gap between sections",
} as const;

/** What each corner token is for (design-tokens.ts `radius`). */
export const RADIUS_ROLES = {
  chip: "Checkboxes, square tags",
  control: "Rows, fields, controls",
  card: "Cards and grouped lists",
  sheet: "Sheets, the user bubble, iPad side panels",
  composer: "The composer; its tray is composer + 4",
  full: "Pills, chips, round buttons, avatars",
} as const;

/** One way iOS and Android differ, as the code draws it today. `sections` are the pages that show it as a note. */
export type PlatformRule = {
  id: string;
  title: string;
  sections: readonly Exclude<DesignSectionId, "platforms">[];
  ios: string;
  android: string;
};

export const PLATFORM_RULES: readonly PlatformRule[] = [
  {
    id: "floating-controls",
    title: "Floating controls",
    sections: ["surfaces", "buttons"],
    ios: "GlassSurface is Liquid Glass (regular, not interactive), with the surface as its reduced-transparency fallback.",
    android:
      "There is no Liquid Glass, and the library's stand-in smears into grey blobs, so GlassSurface draws the surface with shadowRaised: a raised surface, not glass.",
  },
  {
    id: "headers",
    title: "Headers",
    sections: ["surfaces", "composer"],
    ios: "Every Stack's bar is transparent and content blurs softly under it (the scroll edge effect); the content inset under the bar is automatic.",
    android:
      "No scroll edge effect and no automatic inset, so bars are solid page and content starts below them. The Chat keeps a transparent bar and its own clearance, with an opaque fade under the title instead of a progressive blur.",
  },
  {
    id: "back",
    title: "Going back",
    sections: ["composer", "menus"],
    ios: "The header's sidebar button and the edge swipe open the Chats list. There is no system back.",
    android:
      "The system back pops a pushed page, closes an open panel (Changes), and from a Chat at the root opens the Chats list; back on the Chats list leaves the app, as a launcher's first page does.",
  },
  {
    id: "header-buttons",
    title: "Native header buttons",
    sections: ["buttons"],
    ios: "Stack.Toolbar.Button with an SF Symbol (xmark, sidebar.left); iOS draws its round glass.",
    android: "Toolbar buttons take no SF Symbols, so it is Stack.Toolbar.View holding a HeaderButton with the Hugeicons glyph (Cancel01Icon, SidebarLeftIcon).",
  },
  {
    id: "glass-icon-button",
    title: "Glass icon buttons",
    sections: ["buttons"],
    ios: "GlassIconButton is a SwiftUI button in the glass style (glassProminent when prominent), drawn with its SF Symbol, or the Hugeicons glyph when iconSize is set.",
    android: "GlassIconButton draws a CircleButton with the Hugeicons glyph; prominent is its filled look.",
  },
  {
    id: "menus",
    title: "Menus",
    sections: ["menus", "rows"],
    ios: "PullDown is a SwiftUI pull-down menu laid over the trigger; a choice runs once the menu has closed.",
    android:
      "PullDown is the Material dropdown (MenuView from @expo/ui). Compose measured its trigger at the content's own width, so the trigger is capped to the box it sits in.",
  },
  {
    id: "segmented",
    title: "Segmented controls",
    sections: ["menus"],
    ios: "Segmented is a native SwiftUI Picker in the segmented style.",
    android: "Segmented draws the track and a raised segment from the theme, not Material's dropdown.",
  },
  {
    id: "checkboxes",
    title: "Switches and checkboxes",
    sections: ["rows", "menus"],
    ios: "Toggle, RowCheckbox and a ListRow toggle all draw a checkbox; no switch. A checked item in a menu is a SwiftUI Toggle, which the menu draws as a checkmark.",
    android: "The same checkbox, never a switch. A checked item in a menu is a Material item with its state on, drawn as a check.",
  },
  {
    id: "sheets",
    title: "Scrolling inside sheets",
    sections: ["menus", "rows"],
    ios: "A page scrolls inside its sheet on its own; nestedScrollEnabled does nothing.",
    android: "PageScroll sets nestedScrollEnabled; without it the sheet keeps every vertical drag and a long Settings page can't scroll.",
  },
  {
    id: "keyboard",
    title: "Dismissing the keyboard",
    sections: ["rows"],
    ios: "PageScroll lowers the keyboard interactively, following the finger.",
    android: "PageScroll lowers the keyboard as a drag starts.",
  },
  {
    id: "covered-panels",
    title: "Panels under sheets",
    sections: ["menus"],
    ios: "Sheets present above the side panels, so the panels stay as they are.",
    android:
      "Sheets live in the app's own view tree, below the panels, so a Chat's panels hide while another screen covers it and come back, still open, when it closes.",
  },
  {
    id: "large-screens",
    title: "Settings on a large screen",
    sections: ["menus", "rows"],
    ios: "An iPad shows Settings as a card over a scrim, with the list beside the page once the card is 700 wide; Keybindings shows only there.",
    android: "Settings is the one-column sheet at every width.",
  },
  {
    id: "follow-end",
    title: "Following the end of a Chat",
    sections: ["composer"],
    ios: "A jump to the end runs at once.",
    android:
      "A jump to the end waits a frame: Android runs it before the grown content is mounted and lands short. Bursts of growth share one jump, so a streaming reply stays above the composer.",
  },
  {
    id: "haptics",
    title: "Haptics",
    sections: ["buttons", "rows", "chips"],
    ios: "tap() plays the selection haptic when a primitive is pressed (pills, rows, chips, menu choices).",
    android: "tap() does nothing; Android plays no selection haptic.",
  },
  {
    id: "code-font",
    title: "Code font",
    sections: ["type", "composer"],
    ios: "fonts.mono is Menlo.",
    android: "fonts.mono is the system monospace.",
  },
  {
    id: "announcements",
    title: "Announcements and roles",
    sections: ["rows", "chips"],
    ios: 'A live region is never spoken and the alert role isn\'t read, so ErrorNotice, InlineError and status lines speak through announce(). Never use accessibilityRole "status": it is no role.',
    android:
      '"status" is no role either, and Android rejects the view with a red screen. A polite accessibilityLiveRegion speaks here, so never pair one with announce() or TalkBack reads it twice.',
  },
  {
    id: "copy",
    title: "Words",
    sections: ["rows"],
    ios: '"This iPhone" or "This iPad", "On this iPhone" in Settings, "simulator". The other machine is "your computer", never "your Mac".',
    android: '"This phone", "On this device" in Settings, "emulator". The other machine is "your computer", never "your Mac".',
  },
];

/** The rules a section page shows as notes. */
export function platformRulesFor(section: DesignSectionId): readonly PlatformRule[] {
  if (section === "platforms") return PLATFORM_RULES;
  return PLATFORM_RULES.filter((rule) => rule.sections.includes(section));
}

/** The platform a route param names, or the one the app runs on. */
export function designPlatform(value: unknown, running: string): DesignPlatform {
  if (value === "ios" || value === "android") return value;
  return running === "android" ? "android" : "ios";
}
