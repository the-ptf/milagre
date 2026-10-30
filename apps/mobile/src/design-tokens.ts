/** The phone's type and corner scale (.interface-design/system.md): iOS Dynamic Type default sizes and five radii.
 * New styles take their numbers from here; design-tokens.test.ts keeps literals on the scale. */
export const type = {
  caption2: 11,
  caption1: 12,
  footnote: 13,
  subheadline: 15,
  callout: 16,
  body: 17,
  title3: 20,
  title2: 22,
  title1: 28,
  largeTitle: 34,
} as const;

/** iOS Dynamic Type default line heights, one per `type` key: `{ fontSize: type.body, lineHeight: lineHeight.body }`. */
export const lineHeight = {
  caption2: 13,
  caption1: 16,
  footnote: 18,
  subheadline: 20,
  callout: 21,
  body: 22,
  title3: 25,
  title2: 28,
  title1: 34,
  largeTitle: 41,
} as const satisfies Record<keyof typeof type, number>;

/** `sheet` is also the iPad side panels (desktop's window 14 floats like a phone sheet). `composer` is the prompt field;
 * the tray around it is `composer + 4` (its padding), so the corners run parallel. */
export const radius = {
  chip: 6,
  control: 10,
  card: 14,
  sheet: 20,
  composer: 24,
  full: 999,
} as const;

/** The 4pt grid (2 and 6 only inside dense rows). `gutter` is every screen's side padding, `section` the gap between sections. */
export const space = {
  xxs: 2,
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  xxl: 24,
  xxxl: 32,
  gutter: 16,
  section: 24,
} as const;

/** Motion, as desktop's --duration-* and --ease-*: hover and press `fast`, things appearing `base`, panels and sheets
 * `slow`. Durations in ms go through scaledTiming/springTo (motion.ts) for the Animations setting; curves are
 * `Easing.bezier(...easing.enter)`. Artwork (Ultracode, the splash, the fatality) keeps its own timing. */
export const duration = { fast: 120, base: 180, slow: 280 } as const;
export const easing = {
  /** Everything that appears or settles. */
  enter: [0.23, 1, 0.32, 1],
  /** Panels and sheets travelling a long way. */
  slide: [0.32, 0.72, 0, 1],
} as const;

/** The floating chat header's height under the safe area (6 + 44 + 2). Overlays below it sit at its bottom + 8. */
export const chrome = { header: 52 } as const;

/** The 44pt touch floor; a smaller visual makes it up with `hitSlop={hitSlopFor(size)}`. */
export const minTarget = 44;
export const hitSlopFor = (size: number) => Math.max(0, (minTarget - size) / 2);
