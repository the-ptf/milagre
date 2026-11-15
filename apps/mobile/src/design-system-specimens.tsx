import React, { useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import {
  Add01Icon,
  Archive02Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  ComputerIcon,
  Copy01Icon,
  FilterIcon,
  MoreHorizontalIcon,
  Search01Icon,
  SentIcon,
  SidebarLeftIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
  COLOR_GROUPS,
  PLATFORM_NAMES,
  RADIUS_ROLES,
  SPACE_ROLES,
  TYPE_ROLES,
  platformRulesFor,
  type DesignPlatform,
  type DesignSection,
  type PlatformRule,
} from "./design-system-catalogue";
import { chrome, duration, easing, hitSlopFor, lineHeight, radius, space, type } from "./design-tokens";
import { Icon } from "./icons";
import { fonts, useTheme, type Palette } from "./theme";
import {
  CheckRow,
  Chip,
  CircleButton,
  DISABLED_OPACITY,
  EmptyState,
  ErrorNotice,
  Field,
  GlassIconButton,
  Group,
  HeaderButton,
  IconButton,
  InlineError,
  ListRow,
  PRESSED_OPACITY,
  PillButton,
  ProgressBar,
  PullDown,
  RowCheckbox,
  SectionLabel,
  Segmented,
  SheetHeader,
  Tag,
  Toggle,
  TranscriptDivider,
  showActions,
  useStyles,
} from "./ui";
import { ChoiceRow } from "./primitives/choice-row";
import { GlassSurface } from "./primitives/glass-surface";
import { HeaderAction, HeaderActionGroup } from "./primitives/header-action-group";
import { ToastPill } from "./primitives/toast";
import { showChoiceSheet } from "./choice-store";
import { ChatReply, type MediaSource } from "./chat-reply";

/**
 * The pages of Settings › Design system: each section's specimens, drawn by the app's own primitives with the current
 * theme, then the section's platform notes for the platform the index's switch picked.
 */

const noop = () => {};
const running: DesignPlatform = Platform.OS === "android" ? "android" : "ios";

/** A specimen block: its SectionLabel, then what it shows. */
function Block({ title, children, caption }: { title: string; caption?: string; children: React.ReactNode }) {
  const styles = useStyles();
  return (
    <View style={{ gap: space.md }}>
      <SectionLabel>{title}</SectionLabel>
      {children}
      {caption ? <Text style={[styles.footnote, { paddingHorizontal: space.xl }]}>{caption}</Text> : null}
    </View>
  );
}

/** A card holding specimens in a wrapping row. */
function Wrap({ children, align = "center" }: { children: React.ReactNode; align?: "center" | "flex-start" }) {
  const styles = useStyles();
  return <View style={[styles.card, { flexDirection: "row", flexWrap: "wrap", alignItems: align, gap: space.lg }]}>{children}</View>;
}

/** A token's name in mono, its value, and what it is for. */
function TokenLine({ name, value, use }: { name: string; value: string; use?: string }) {
  const styles = useStyles();
  return (
    <View style={{ gap: space.xxs }}>
      <View style={{ flexDirection: "row", gap: space.md, alignItems: "baseline" }}>
        <Text style={[styles.code, { flexShrink: 1 }]}>{name}</Text>
        <Text style={[styles.caption, { fontFamily: fonts.mono }]}>{value}</Text>
      </View>
      {use ? <Text style={styles.caption}>{use}</Text> : null}
    </View>
  );
}

export function DesignSystemPage({ section, platform }: { section: DesignSection; platform: DesignPlatform }) {
  const styles = useStyles();
  return (
    <>
      <View style={{ gap: space.md }}>
        <Text style={styles.muted}>{section.summary}</Text>
        {section.id !== "platforms" && platform !== running ? (
          <Text style={styles.footnote}>
            The specimens are live on {PLATFORM_NAMES[running]}; the notes at the end are for {PLATFORM_NAMES[platform]}.
          </Text>
        ) : null}
      </View>
      {section.id === "colors" ? (
        <ColorsSpecimen />
      ) : section.id === "type" ? (
        <TypeSpecimen />
      ) : section.id === "spacing" ? (
        <SpacingSpecimen />
      ) : section.id === "surfaces" ? (
        <SurfacesSpecimen />
      ) : section.id === "buttons" ? (
        <ButtonsSpecimen />
      ) : section.id === "rows" ? (
        <RowsSpecimen />
      ) : section.id === "chips" ? (
        <ChipsSpecimen />
      ) : section.id === "menus" ? (
        <MenusSpecimen />
      ) : section.id === "composer" ? (
        <ComposerSpecimen />
      ) : null}
      {section.id === "platforms" ? <PlatformRules platform={platform} /> : <PlatformNotes section={section} platform={platform} />}
    </>
  );
}

/** The section's rules, in the words for the platform the switch picked. */
function PlatformNotes({ section, platform }: { section: DesignSection; platform: DesignPlatform }) {
  const styles = useStyles();
  const rules = platformRulesFor(section.id);
  return (
    <Block title={`On ${PLATFORM_NAMES[platform]}`}>
      <View style={styles.card}>
        {rules.length ? (
          rules.map((rule, index) => (
            <View key={rule.id} style={{ gap: space.xs }}>
              {index > 0 ? <View style={[styles.separator, { marginBottom: space.md }]} /> : null}
              <Text style={styles.sheetTitle}>{rule.title}</Text>
              <Text style={styles.muted}>{rule[platform]}</Text>
            </View>
          ))
        ) : (
          <Text style={styles.muted}>Both platforms draw these the same.</Text>
        )}
      </View>
    </Block>
  );
}

/** Every rule with both texts, the picked platform's in a hover2 well. */
function PlatformRules({ platform }: { platform: DesignPlatform }) {
  const styles = useStyles();
  const rules = platformRulesFor("platforms");
  return (
    <View style={{ gap: space.lg }}>
      {rules.map((rule) => (
        <View key={rule.id} style={styles.card}>
          <Text accessibilityRole="header" style={styles.sheetTitle}>
            {rule.title}
          </Text>
          {(["ios", "android"] as const).map((side) => (
            <PlatformText key={side} rule={rule} side={side} picked={side === platform} />
          ))}
        </View>
      ))}
    </View>
  );
}

function PlatformText({ rule, side, picked }: { rule: PlatformRule; side: DesignPlatform; picked: boolean }) {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <View
      accessible
      accessibilityLabel={`${PLATFORM_NAMES[side]}${picked ? ", selected" : ""}. ${rule[side]}`}
      style={[
        { gap: space.xxs, padding: space.lg, borderRadius: radius.control, borderCurve: "continuous" },
        picked ? { backgroundColor: colors.hover2 } : { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
      ]}
    >
      <Text style={[styles.label, picked && { color: colors.ink, fontWeight: "600" }]}>{PLATFORM_NAMES[side]}</Text>
      <Text style={[styles.muted, picked && { color: colors.ink }]}>{rule[side]}</Text>
    </View>
  );
}

// Foundations

/** The Terminal's 16 colours in xterm order (`Ansi` in the shared themes). */
const ANSI_BASE = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const ANSI_NAMES = [...ANSI_BASE, ...ANSI_BASE.map((name) => `bright ${name}`)];

function ColorsSpecimen() {
  const { colors, scheme } = useTheme();
  const styles = useStyles();
  return (
    <>
      <Text style={styles.footnote}>
        The current theme in {scheme === "dark" ? "dark" : "light"} mode. Settings › Appearance changes both, and these swatches follow.
      </Text>
      {COLOR_GROUPS.map((group) => (
        <Block key={group.title} title={group.title}>
          <Wrap align="flex-start">
            {group.colors.map(({ key, use }) => (
              <Swatch key={key} name={key} value={colors[key]} use={use} />
            ))}
          </Wrap>
        </Block>
      ))}
      <Block title="Terminal and code" caption="ansi is the Terminal's 16 colours; syntax colours code tokens in files and diffs.">
        <View style={styles.card}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
            {ANSI_NAMES.map((name, index) => (
              <View
                key={name}
                accessible
                accessibilityLabel={`${name}, ${colors.ansi[index]}`}
                style={{ width: 24, height: 24, borderRadius: radius.chip, borderCurve: "continuous", backgroundColor: colors.ansi[index] }}
              />
            ))}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
            {(Object.keys(colors.syntax) as (keyof Palette["syntax"])[]).map((kind) => (
              <Text key={kind} style={[styles.code, { color: colors.syntax[kind] }]}>
                {kind}
              </Text>
            ))}
          </View>
        </View>
      </Block>
    </>
  );
}

function Swatch({ name, value, use }: { name: string; value: string; use: string }) {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <View accessible accessibilityLabel={`${name}, ${value}. ${use}`} style={{ flexBasis: "40%", flexGrow: 1, gap: space.xs }}>
      <View
        style={{
          height: 44,
          borderRadius: radius.control,
          borderCurve: "continuous",
          backgroundColor: value,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.line,
        }}
      />
      <Text style={[styles.code, { fontWeight: "600" }]}>{name}</Text>
      <Text style={[styles.caption, { fontFamily: fonts.mono }]}>{value}</Text>
      <Text style={styles.caption}>{use}</Text>
    </View>
  );
}

// Largest first. A fresh array, sorted in place: this Hermes build has no toSorted or toReversed.
const TYPE_KEYS = (Object.keys(type) as (keyof typeof type)[]).sort((a, b) => type[b] - type[a]);

function TypeSpecimen() {
  const { colors, textPx, codeSize } = useTheme();
  const styles = useStyles();
  const chatLine = Math.round(textPx * 1.4667);
  return (
    <>
      <Block
        title="Scale"
        caption="iOS Dynamic Type defaults, in design-tokens.ts. Text grows with the system text size; controls set minHeight, never a fixed height."
      >
        <View style={styles.card}>
          {TYPE_KEYS.map((key, index) => (
            <View key={key} style={{ gap: space.xxs }}>
              {index > 0 ? <View style={[styles.separator, { marginBottom: space.md }]} /> : null}
              <Text
                numberOfLines={1}
                style={{ color: colors.ink, fontSize: type[key], lineHeight: lineHeight[key], fontWeight: key === "largeTitle" ? "700" : undefined }}
              >
                {key}
              </Text>
              <View style={{ flexDirection: "row", gap: space.md }}>
                <Text style={[styles.caption, { fontFamily: fonts.mono }]}>
                  {type[key]} / {lineHeight[key]}
                </Text>
                <Text style={[styles.caption, { flexShrink: 1 }]}>{TYPE_ROLES[key]}</Text>
              </View>
            </View>
          ))}
        </View>
      </Block>
      <Block title="Weights" caption="Two weights, 500 and 600; 700 only for the large title. Button labels are 600. Letter-spacing stays 0.">
        <View style={styles.card}>
          <Text style={styles.text}>Regular body</Text>
          <Text style={[styles.text, { fontWeight: "500" }]}>Medium 500: a choice, a row title</Text>
          <Text style={[styles.text, { fontWeight: "600" }]}>Semibold 600: a title, a button label</Text>
        </View>
      </Block>
      <Block title="Chat and code" caption="Chat text follows Settings › Appearance › Text size, code its Code size.">
        <View style={styles.card}>
          <Text style={{ color: colors.ink, fontSize: textPx, lineHeight: chatLine }}>Chat text at the size you picked.</Text>
          <Text style={[styles.caption, { fontFamily: fonts.mono }]}>
            textPx {textPx} / {chatLine}
          </Text>
          <Text style={{ color: colors.ink, fontFamily: fonts.mono, fontSize: codeSize }}>const gap = space.section;</Text>
          <Text style={[styles.caption, { fontFamily: fonts.mono }]}>
            {fonts.mono} {codeSize}
          </Text>
        </View>
      </Block>
    </>
  );
}

function SpacingSpecimen() {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <>
      <Block title="Spacing" caption="A 4 pt grid; 2 and 6 only inside dense rows. Bars are drawn at their real size.">
        <View style={styles.card}>
          {(Object.keys(space) as (keyof typeof space)[]).map((key) => (
            <View key={key} style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}>
              <View style={{ width: space.xxxl, alignItems: "flex-start" }}>
                <View style={{ width: space[key], height: space.lg, backgroundColor: colors.ink4 }} />
              </View>
              <View style={{ flex: 1 }}>
                <TokenLine name={`space.${key}`} value={String(space[key])} use={SPACE_ROLES[key]} />
              </View>
            </View>
          ))}
        </View>
      </Block>
      <Block title="Radius" caption="Every corner sets borderCurve continuous. A nested corner is the outer radius less the padding between.">
        <Wrap align="flex-start">
          {(Object.keys(radius) as (keyof typeof radius)[]).map((key) => (
            <View key={key} style={{ flexBasis: "40%", flexGrow: 1, gap: space.sm }}>
              <View
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: radius[key],
                  borderCurve: "continuous",
                  backgroundColor: colors.field,
                  borderWidth: 1,
                  borderColor: colors.lineStrong,
                }}
              />
              <TokenLine name={`radius.${key}`} value={String(radius[key])} use={RADIUS_ROLES[key]} />
            </View>
          ))}
        </Wrap>
      </Block>
      <Block title="Touch targets" caption="44 pt is the floor. A smaller visual makes it up with hitSlop={hitSlopFor(size)}.">
        <Wrap>
          {([32, 36, 40, 44] as const).map((size) => (
            <View key={size} style={{ alignItems: "center", gap: space.xs }}>
              <IconButton label={`Icon button ${size}`} icon={Add01Icon} size={size} onPress={noop} />
              <Text style={[styles.caption, { fontFamily: fonts.mono }]}>
                {size} + 2 × {hitSlopFor(size)}
              </Text>
            </View>
          ))}
        </Wrap>
      </Block>
      <Block title="Motion" caption="Durations run through scaledTiming and springTo (motion.ts), so Settings › Appearance › Animations scales them.">
        <View style={styles.card}>
          <TokenLine name="duration.fast" value={`${duration.fast} ms`} use="Hover, press, colour changes" />
          <TokenLine name="duration.base" value={`${duration.base} ms`} use="Things appearing" />
          <TokenLine name="duration.slow" value={`${duration.slow} ms`} use="Panels and sheets" />
          <TokenLine name="easing.enter" value={easing.enter.join(", ")} use="Everything that appears or settles" />
          <TokenLine name="easing.slide" value={easing.slide.join(", ")} use="Panels and sheets travelling a long way" />
          <TokenLine
            name="pressStyle"
            value={`${PRESSED_OPACITY}, ${DISABLED_OPACITY.control} / ${DISABLED_OPACITY.row}`}
            use="Pressed opacity, plus scale 0.97 on filled buttons; disabled controls, then rows"
          />
          <TokenLine name="chrome.header" value={String(chrome.header)} use="The floating Chat header; overlays under it sit 8 lower" />
        </View>
      </Block>
    </>
  );
}

function SurfacesSpecimen() {
  const { colors } = useTheme();
  const fill = (key: "page" | "canvas" | "surface" | "inset" | "field", use: string) => (
    <View
      key={key}
      style={{
        padding: space.lg,
        borderRadius: radius.control,
        borderCurve: "continuous",
        backgroundColor: colors[key],
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
      }}
    >
      <TokenLine name={key} value={colors[key]} use={use} />
    </View>
  );
  const shadow = (key: "shadowCard" | "shadowRaised" | "shadowOverlay", use: string) => (
    <View
      key={key}
      style={{ padding: space.xl, borderRadius: radius.card, borderCurve: "continuous", backgroundColor: colors.surface, boxShadow: colors[key] }}
    >
      <TokenLine name={key} value="" use={use} />
    </View>
  );
  return (
    <>
      <Block title="Surfaces" caption="Grouped cards are flat: the surface with a hairline, no shadow.">
        <View style={{ gap: space.md }}>
          {fill("page", "Every screen")}
          {fill("canvas", "Recessed areas, your message's bubble")}
          {fill("surface", "Cards, sheets, the composer")}
          {fill("inset", "A well inside a card")}
          {fill("field", "Fields, neutral tags")}
        </View>
      </Block>
      <Block title="Elevation" caption="Each shadow paints its own hairline ring, so an elevated surface takes no border. Dark mode has deeper ones.">
        <View style={{ gap: space.xl, paddingVertical: space.xs }}>
          {shadow("shadowCard", "An inline card; Android's raised segment")}
          {shadow("shadowRaised", "Floating controls: the inbox button, the undo panel; glass on Android")}
          {shadow("shadowOverlay", "The iPad Settings card, the question card")}
        </View>
      </Block>
      <Block title="Glass" caption="GlassSurface behind a floating control: the Chat header's action group and the Chats list's filter button.">
        <View style={{ borderRadius: radius.card, borderCurve: "continuous", overflow: "hidden", backgroundColor: colors.canvas }}>
          {(["accent", "green", "orange", "red", "purple"] as const).map((tone) => (
            <View key={tone} style={{ height: space.xl, backgroundColor: colors[tone] }} />
          ))}
          <View style={[StyleSheet.absoluteFill, { flexDirection: "row", alignItems: "center", justifyContent: "space-evenly" }]}>
            <HeaderActionGroup>
              <HeaderAction label="Browser" icon={ComputerIcon} />
              <HeaderAction label="Copy" icon={Copy01Icon} />
              <HeaderAction label="More" icon={MoreHorizontalIcon} />
            </HeaderActionGroup>
            <View style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.full }}>
              <GlassSurface />
              <Icon icon={FilterIcon} tone="ink" size={20} />
            </View>
          </View>
        </View>
      </Block>
    </>
  );
}

// Components

function ButtonsSpecimen() {
  const { colors } = useTheme();
  const [selected, setSelected] = useState(false);
  return (
    <>
      <Block title="PillButton" caption="The phone's one button: primary is ink with an onInk label, and neither green nor accent ever fills it.">
        <Wrap>
          <PillButton title="Primary" onPress={noop} />
          <PillButton title="Secondary" variant="secondary" onPress={noop} />
          <PillButton title="Tinted" variant="tinted" onPress={noop} />
          <PillButton title="Plain" variant="plain" onPress={noop} />
          <PillButton title="Cancel" variant="plain" muted onPress={noop} />
          <PillButton title="Delete" destructive onPress={noop} />
          <PillButton title="Remove" variant="secondary" destructive onPress={noop} />
          <PillButton title="Approve" variant="tinted" tone="orange" onPress={noop} />
        </Wrap>
      </Block>
      <Block title="PillButton sizes and states" caption="small 32, regular 44, large 52, as minHeight so Dynamic Type can grow them.">
        <Wrap>
          <PillButton title="Small" size="small" icon={Add01Icon} onPress={noop} />
          <PillButton title="Regular" icon={SentIcon} onPress={noop} />
          <PillButton title="Large" size="large" onPress={noop} />
          <PillButton title="Loading" variant="secondary" loading onPress={noop} />
          <PillButton title="Disabled" disabled onPress={noop} />
        </Wrap>
      </Block>
      <Block title="CircleButton" caption="40 pt, the close, back and done of sheets and panels; filled is the primary, selected an on toggle.">
        <Wrap>
          <CircleButton label="Close" icon={Cancel01Icon} onPress={noop} />
          <CircleButton label="Done" icon={Tick02Icon} filled onPress={noop} />
          <CircleButton label="Sidebar" icon={SidebarLeftIcon} selected={selected} onPress={() => setSelected((on) => !on)} />
          <CircleButton label="Archive" icon={Archive02Icon} badge={3} onPress={noop} />
          <CircleButton label="Disabled" icon={Search01Icon} disabled />
        </Wrap>
      </Block>
      <Block title="IconButton" caption="Round, no edge: 32, 36, 40, 44 and 48, each reaching 44 with its hitSlop. Glyphs rest in ink2.">
        <Wrap>
          <IconButton label="32" icon={Add01Icon} size={32} onPress={noop} />
          <IconButton label="36" icon={Add01Icon} onPress={noop} />
          <IconButton label="48" icon={Add01Icon} size={48} onPress={noop} />
          <IconButton label="Send" icon={ArrowUp02Icon} filled onPress={noop} />
          <IconButton label="Ultracode" icon={ArrowUp02Icon} filled fill={colors.purple} onPress={noop} />
          <IconButton label="Selected" icon={FilterIcon} selected onPress={noop} />
          <IconButton label="Loading" icon={Add01Icon} loading onPress={noop} />
        </Wrap>
      </Block>
      <Block title="GlassIconButton and HeaderButton" caption="GlassIconButton floats over content; HeaderButton sits in a native header.">
        <Wrap>
          <GlassIconButton label="Add" systemImage="plus" icon={Add01Icon} onPress={noop} />
          <GlassIconButton label="Send" systemImage="arrow.up" icon={ArrowUp02Icon} prominent onPress={noop} />
          <HeaderButton label="Close" icon={Cancel01Icon} onPress={noop} />
          <HeaderButton label="Sidebar" icon={SidebarLeftIcon} disabled />
        </Wrap>
      </Block>
    </>
  );
}

function RowsSpecimen() {
  const { colors } = useTheme();
  const styles = useStyles();
  const [on, setOn] = useState(true);
  const [mode, setMode] = useState("system");
  const [picked, setPicked] = useState<string[]>(["milagre"]);
  const [choice, setChoice] = useState("list");
  const [box, setBox] = useState(false);
  const [name, setName] = useState("");
  const pick = (id: string) => setPicked((list) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]));
  return (
    <>
      <Group title="ListRow in a Group" footer="A Group's note sits under its card in ink3.">
        <ListRow title="With a value" icon={ComputerIcon} value="2 online" onPress={noop} />
        <ListRow title="With a subtitle" subtitle="A caption under a callout title" icon={Copy01Icon} onPress={noop} />
        <ListRow title="Compact" compact icon={FilterIcon} onPress={noop} />
        <ListRow title="A row that is a checkbox" toggle={{ value: on, onChange: () => setOn((value) => !value) }} />
        <ListRow title="Destructive" icon={Archive02Icon} destructive onPress={noop} />
        <ListRow title="Disabled" icon={Search01Icon} disabled onPress={noop} />
        <ListRow title="Selected beside it (iPad)" icon={SidebarLeftIcon} selected onPress={noop} />
      </Group>
      <Group title="CheckRow, radio" role="radiogroup" inset={0}>
        {[
          { id: "system", title: "System" },
          { id: "light", title: "Light" },
          { id: "dark", title: "Dark" },
        ].map((item) => (
          <CheckRow key={item.id} title={item.title} checked={mode === item.id} onPress={() => setMode(item.id)} />
        ))}
      </Group>
      <Group title="CheckRow, checkbox" inset={0}>
        {["milagre", "site"].map((value) => (
          <CheckRow key={value} kind="checkbox" title={value} subtitle={`~/Code/${value}`} checked={picked.includes(value)} onPress={() => pick(value)} />
        ))}
      </Group>
      <Block title="ChoiceRow, Toggle and RowCheckbox" caption="No switches on either platform: on and off is a checkbox.">
        <View style={[styles.card, { gap: 0, paddingVertical: space.xs }]}>
          <ChoiceRow title="One list" selected={choice === "list"} onPress={() => setChoice("list")} />
          <ChoiceRow title="Grouped by Project" selected={choice === "grouped"} onPress={() => setChoice("grouped")} />
          <Toggle title="Toggle, a labelled checkbox" selected={on} onPress={() => setOn((value) => !value)} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg }}>
            <Text style={[styles.text, { flex: 1 }]}>RowCheckbox</Text>
            <RowCheckbox label="RowCheckbox" selected={box} onPress={() => setBox((value) => !value)} />
          </View>
        </View>
      </Block>
      <View style={{ gap: space.md }}>
        <SectionLabel trailing="3">SectionLabel with a count</SectionLabel>
        <View style={styles.card}>
          <Text style={styles.muted}>Footnote 13 medium in ink3, 16 in from the card&apos;s edge.</Text>
        </View>
      </View>
      <Block title="Field and errors">
        <View style={styles.card}>
          <Field label="Field" placeholder="A placeholder in ink3" value={name} onChangeText={setName} />
          <InlineError message="InlineError: a field-level error in redInk." />
          <InlineError warning message="A warning is orangeInk." />
        </View>
        <ErrorNotice message="ErrorNotice: a blocking failure with its retry." retry={noop} />
      </Block>
      <Block title="Progress and empty states">
        <View style={styles.card}>
          <ProgressBar value={0.4} accessibilityLabel="Progress" />
          <ProgressBar value={0.85} tone="orange" size={4} accessibilityLabel="Usage" />
        </View>
        <View style={[styles.card, { backgroundColor: colors.page }]}>
          <EmptyState icon={Search01Icon} title="Nothing here yet" action={{ title: "Add one", onPress: noop }}>
            An empty list says what would be here and how to add it.
          </EmptyState>
        </View>
      </Block>
    </>
  );
}

function ChipsSpecimen() {
  const { colors } = useTheme();
  const [scope, setScope] = useState("all");
  const [kinds, setKinds] = useState<string[]>(["open"]);
  const flip = (id: string) => setKinds((list) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]));
  return (
    <>
      <Block title="Chip, one of several" caption="32 pt, 13 medium: an ink fill when picked, the surface with a lineStrong edge when not.">
        <View accessibilityRole="radiogroup" accessibilityLabel="Scope" style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
          {["all", "needs", "done"].map((id) => (
            <Chip key={id} label={id === "all" ? "All Chats" : id === "needs" ? "Needs me" : "Done"} selected={scope === id} onPress={() => setScope(id)} />
          ))}
        </View>
      </Block>
      <Block title="Chip, any of several">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
          {["open", "draft", "merged"].map((id) => (
            <Chip key={id} label={id} multiple selected={kinds.includes(id)} onPress={() => flip(id)} />
          ))}
        </View>
      </Block>
      <Block title="Chip, other forms">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
          <Chip label="Static" />
          <Chip label="Online" leading={<View style={{ width: 8, height: 8, borderRadius: radius.full, backgroundColor: colors.green }} />} onPress={noop} />
          <Chip label="Filters" leading={<Icon icon={FilterIcon} tone="ink2" size={12} />} trailing={<Tag label="2" />} onPress={noop} />
          <Chip label="Disabled" disabled onPress={noop} />
        </View>
      </Block>
      <Block title="Tag" caption="A static label, 24 pt, 12 medium. A status tone is its tint with its -ink label; neutral is a field fill.">
        <Wrap>
          <Tag label="Recommended" />
          <Tag label="Link" tone="accent" />
          <Tag label="Online" tone="green" dot />
          <Tag label="Waiting" tone="orange" dot />
          <Tag label="Failed" tone="red" dot />
          <Tag label="Merged" tone="purple" />
          <Tag label="Square" square icon={Copy01Icon} />
        </Wrap>
      </Block>
    </>
  );
}

const SORTS = [
  { id: "recent", title: "Recent" },
  { id: "name", title: "Name" },
];

function MenusSpecimen() {
  const styles = useStyles();
  const [sort, setSort] = useState("recent");
  const [picked, setPicked] = useState("");
  const [density, setDensity] = useState("comfortable");
  const choose = (id: string) => {
    if (SORTS.some((item) => item.id === id)) setSort(id);
    else setPicked(id);
  };
  const sections = [
    { title: "Sort by", items: SORTS.map((item) => ({ ...item, checked: sort === item.id })) },
    {
      items: [
        { id: "Rename", title: "Rename", systemImage: "pencil" },
        { id: "Archive", title: "Archive", systemImage: "archivebox", destructive: true },
      ],
    },
  ];
  const sortTitle = SORTS.find((item) => item.id === sort)?.title ?? "";
  return (
    <>
      <Block title="PullDown" caption={picked ? `Picked ${picked}.` : "A tap opens the menu; a checked item shows its tick."}>
        <Wrap>
          <PullDown label="More" sections={sections} onSelect={choose}>
            <CircleButton label="More" icon={MoreHorizontalIcon} asTrigger />
          </PullDown>
          <PullDown
            label="Sort"
            title="Sort by"
            sections={sections.slice(0, 1)}
            onSelect={choose}
            nativeTrigger={{ title: sortTitle, systemImage: "arrow.up.arrow.down" }}
          >
            <Chip label={sortTitle} />
          </PullDown>
        </Wrap>
      </Block>
      <Block title="Sheets from a tap" caption="Actions and long lists open the shared sheets; a route can't carry callbacks, so each waits in its store.">
        <Wrap>
          <PillButton
            title="Actions"
            variant="secondary"
            onPress={() =>
              showActions({
                title: "Sample actions",
                actions: [
                  { id: "Duplicate", title: "Duplicate" },
                  { id: "Delete", title: "Delete", destructive: true },
                ],
                onSelect: setPicked,
              })
            }
          />
          <PillButton
            title="Choices"
            variant="secondary"
            onPress={() =>
              showChoiceSheet({
                title: "Sort by",
                placeholder: "Search",
                emptyLabel: "Nothing matches",
                items: SORTS.map((item) => ({ ...item, checked: sort === item.id })),
                onSelect: choose,
              })
            }
          />
        </Wrap>
      </Block>
      <Block title="Segmented">
        <View style={styles.card}>
          <Segmented
            label="Density"
            value={density}
            options={[
              { value: "comfortable", title: "Comfortable" },
              { value: "compact", title: "Compact" },
            ]}
            onChange={setDensity}
          />
        </View>
      </Block>
      <Block title="SheetHeader" caption="17 semibold, centred between two slots of the same width: Close leading, a filled Done trailing.">
        <View style={[styles.card, { padding: 0 }]}>
          <SheetHeader
            title="Sheet title"
            subtitle="A caption under it"
            leading={<CircleButton label="Close" icon={Cancel01Icon} onPress={noop} />}
            trailing={<CircleButton label="Done" icon={Tick02Icon} filled onPress={noop} />}
            style={{ paddingBottom: space.lg }}
          />
        </View>
      </Block>
      <Block title="Toast" caption="An ink capsule with onInk text and an optional Undo.">
        <View style={{ alignItems: "center" }}>
          <ToastPill text="Chat archived" icon={Archive02Icon} action={{ label: "Undo", onPress: noop }} />
        </View>
      </Block>
    </>
  );
}

const NO_MEDIA: MediaSource = (path) => ({ uri: path });
const USER_MESSAGE = { id: -1, session_id: -1, role: "user" as const, context: null, body: "Make the empty state match the design system." };
const REPLY_MESSAGE = {
  id: -2,
  session_id: -1,
  role: "assistant" as const,
  context: null,
  body: 'Done. The empty state now uses `EmptyState`:\n\n- a 24 pt **ink4** icon\n- a 17 semibold title\n- help in 15 ink3\n\n```ts\n<EmptyState icon={Search01Icon} title="Nothing here yet" />\n```',
};

function ComposerSpecimen() {
  const { textPx } = useTheme();
  const styles = useStyles();
  return (
    <>
      <Block title="A Chat" caption="Drawn by ChatReply, the Chat's own component, at your text size.">
        <View style={{ gap: space.md }}>
          <ChatReply message={USER_MESSAGE} media={NO_MEDIA} onActivity={noop} />
          <ChatReply message={REPLY_MESSAGE} media={NO_MEDIA} onActivity={noop} />
          <TranscriptDivider label="Switched to another model" icon={ArrowUp02Icon} />
        </View>
      </Block>
      <Block title="Composer tokens" caption="The composer itself needs a live Chat and a computer, so its values are listed here.">
        <View style={styles.card}>
          <TokenLine name="radius.composer" value={String(radius.composer)} use="The prompt field's corner" />
          <TokenLine name="composer + 4" value={String(radius.composer + space.xs)} use="The tray around it, so the corners run parallel" />
          <TokenLine name="textPx" value={`${textPx} / ${Math.round(textPx * 1.4667)}`} use="Prompt and message text, from Appearance › Text size" />
          <TokenLine name="canvas, radius.sheet" value={`${space.lg} × ${space.xl}`} use="Your message's bubble: its fill, corner and padding" />
          <TokenLine name="chrome.header" value={String(chrome.header)} use="The floating header; the transcript clears it" />
        </View>
      </Block>
    </>
  );
}
