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

export const radius = {
  chip: 6,
  control: 10,
  card: 14,
  sheet: 20,
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

/** The 44pt touch floor; a smaller visual makes it up with `hitSlop={hitSlopFor(size)}`. */
export const minTarget = 44;
export const hitSlopFor = (size: number) => Math.max(0, (minTarget - size) / 2);
