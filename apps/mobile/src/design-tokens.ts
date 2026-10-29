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

export const radius = {
  chip: 6,
  control: 10,
  card: 14,
  sheet: 20,
  full: 999,
} as const;
